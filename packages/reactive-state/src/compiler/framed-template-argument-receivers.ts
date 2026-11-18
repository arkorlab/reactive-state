import {
  type CallExpression,
  type ClassDeclaration,
  type ClassExpression,
  type ConstructorDeclaration,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBigIntLiteral,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isDeleteExpression,
  isElementAccessExpression,
  isExpression,
  isExpressionWithTypeArguments,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type PropertyName,
  type SetAccessorDeclaration,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, isAnswering, parametersOf } from './answers.ts';
import { globalOf, literalName } from './bounded.ts';
import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import {
  constantDeclaration,
  isAssignmentOperator,
  queueBranchExpressions,
} from './framed-template-argument-spreads.ts';
import { isWrapper, peeled } from './framed-written-targets.ts';
import { isTypeOnly } from './scope.ts';

/**
 * File-level mutation, reassignment, setter, and subclass summaries plus receiver helpers for
 * template-tag `arguments` taint analysis.
 */

export type ClassLike = ClassDeclaration | ClassExpression;

export type TaintKey =
  | Answering
  | ClassLike
  | ConstructorDeclaration
  | FrameDeclaration
  | ObjectLiteralExpression
  | SetAccessorDeclaration;

export interface FileMutationSummary {
  readonly hasComputedSetter: boolean;
  readonly hasDynamicPropertyWrite: boolean;
  readonly hasUnknownObjectAssign: boolean;
  readonly mutatedObjects: ReadonlySet<FrameDeclaration>;
  readonly mutatedProperties: ReadonlySet<string>;
  readonly reassigned: ReadonlySet<FrameDeclaration>;
  readonly setterNames: ReadonlySet<string>;
  readonly subclassesByBase: ReadonlyMap<ClassLike, readonly ClassLike[]>;
}

interface SummaryBuilder {
  hasComputedSetter: boolean;
  hasDynamicPropertyWrite: boolean;
  hasUnknownObjectAssign: boolean;
  readonly mutatedObjects: Set<FrameDeclaration>;
  readonly mutatedProperties: Set<string>;
  readonly reassigned: Set<FrameDeclaration>;
  readonly setterNames: Set<string>;
  readonly subclassesByBase: Map<ClassLike, ClassLike[]>;
}

const FILE_SUMMARIES = new WeakMap<SourceFile, FileMutationSummary>();

const PRIMITIVE_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.TrueKeyword,
]);

const PARAMETER_PROPERTY_MODIFIERS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.OverrideKeyword,
  SyntaxKind.PrivateKeyword,
  SyntaxKind.ProtectedKeyword,
  SyntaxKind.PublicKeyword,
  SyntaxKind.ReadonlyKeyword,
]);

export function unwrapCalleeExpression(expr: Expression): Expression {
  return peeled(expr);
}

export function memberNameOf(expr: Expression): string | undefined {
  if (isPropertyAccessExpression(expr)) return expr.name.text;
  return isElementAccessExpression(expr) ? literalName(expr) : undefined;
}

export function callableParametersOf(
  fn: Answering | ConstructorDeclaration,
): readonly ParameterDeclaration[] {
  if (isAnswering(fn)) return parametersOf(fn);
  return fn.parameters.filter((param) => !isIdentifier(param.name) || param.name.text !== 'this');
}

export function hasParameterProperty(param: ParameterDeclaration): boolean {
  return param.modifiers?.some((mod) => PARAMETER_PROPERTY_MODIFIERS.has(mod.kind)) === true;
}

export function declaredMemberKey(name: PropertyName | undefined): {
  readonly dynamic: boolean;
  readonly key: string | undefined;
} {
  if (name === undefined) return { dynamic: false, key: undefined };
  if (isPrivateIdentifier(name)) return { dynamic: false, key: name.text };
  if (
    isIdentifier(name) ||
    isStringLiteral(name) ||
    isNoSubstitutionTemplateLiteral(name) ||
    isNumericLiteral(name)
  ) {
    return { dynamic: false, key: name.text };
  }
  if (isComputedPropertyName(name)) {
    const inner = peeled(name.expression);
    if (
      isStringLiteral(inner) ||
      isNoSubstitutionTemplateLiteral(inner) ||
      isNumericLiteral(inner)
    ) {
      return { dynamic: false, key: inner.text };
    }
    return { dynamic: true, key: undefined };
  }
  return { dynamic: true, key: undefined };
}

export function isPrimitiveExpression(expr: Expression): boolean {
  return (
    PRIMITIVE_KEYWORDS.has(expr.kind) ||
    isStringLiteral(expr) ||
    isNoSubstitutionTemplateLiteral(expr) ||
    isNumericLiteral(expr) ||
    isBigIntLiteral(expr) ||
    (isIdentifier(expr) && expr.text === 'undefined' && frameDeclarationOf(expr) === undefined)
  );
}

export function isNullishExpression(expr: Expression): boolean {
  const inner = unwrapCalleeExpression(expr);
  return (
    inner.kind === SyntaxKind.NullKeyword ||
    (isIdentifier(inner) && inner.text === 'undefined' && frameDeclarationOf(inner) === undefined)
  );
}

export function fileMutationSummary(file: SourceFile): FileMutationSummary {
  const cached = FILE_SUMMARIES.get(file);
  if (cached !== undefined) return cached;
  const builder: SummaryBuilder = {
    hasComputedSetter: false,
    hasDynamicPropertyWrite: false,
    hasUnknownObjectAssign: false,
    mutatedObjects: new Set(),
    mutatedProperties: new Set(),
    reassigned: new Set(),
    setterNames: new Set(),
    subclassesByBase: new Map(),
  };
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    inspectSummaryNode(node, builder);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  recordClassRelationships(file, builder);
  const summary: FileMutationSummary = { ...builder };
  FILE_SUMMARIES.set(file, summary);
  return summary;
}

function inspectSummaryNode(node: Node, builder: SummaryBuilder): void {
  if (isSetAccessorDeclaration(node)) {
    const info = declaredMemberKey(node.name);
    if (info.key === undefined) builder.hasComputedSetter = true;
    else builder.setterNames.add(info.key);
    return;
  }
  if (isIdentifier(node) && isReassignedBindingIdentifier(node)) {
    const decl = frameDeclarationOf(node);
    if (decl !== undefined) builder.reassigned.add(decl);
    return;
  }
  if (isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    recordAssignedMemberProperties(node.left, builder);
    return;
  }
  if (isDeleteExpression(node)) {
    recordWrittenMemberAccess(peeled(node.expression), builder);
    return;
  }
  if (isCallExpression(node)) recordCallPropertyMutations(node, builder);
}

function recordClassRelationships(file: SourceFile, builder: SummaryBuilder): void {
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isClassDeclaration(node) || isClassExpression(node)) {
      const base = resolveDirectBaseClassWith(node, builder.reassigned);
      if (base !== undefined) {
        let list = builder.subclassesByBase.get(base);
        if (list === undefined) {
          list = [];
          builder.subclassesByBase.set(base, list);
        }
        list.push(node);
      }
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
}

export function resolveDirectBaseExpression(cls: ClassLike): Expression | undefined {
  const baseType = cls.heritageClauses?.find((clause) => clause.token === SyntaxKind.ExtendsKeyword)
    ?.types[0];
  return baseType !== undefined && isExpressionWithTypeArguments(baseType)
    ? baseType.expression
    : undefined;
}

export function resolveDirectBaseClass(cls: ClassLike): ClassLike | undefined {
  return resolveDirectBaseClassWith(cls, fileMutationSummary(cls.getSourceFile()).reassigned);
}

export function resolveIdentifierClassLike(id: Identifier): ClassLike | undefined {
  return resolveIdentifierClassLikeWith(id, fileMutationSummary(id.getSourceFile()).reassigned);
}

function resolveDirectBaseClassWith(
  cls: ClassLike,
  reassigned: ReadonlySet<FrameDeclaration>,
): ClassLike | undefined {
  const rawBase = resolveDirectBaseExpression(cls);
  if (rawBase === undefined) return undefined;
  const expr = unwrapCalleeExpression(rawBase);
  if (isClassExpression(expr)) return expr;
  return isIdentifier(expr) ? resolveIdentifierClassLikeWith(expr, reassigned) : undefined;
}

function resolveIdentifierClassLikeWith(
  id: Identifier,
  reassigned: ReadonlySet<FrameDeclaration>,
): ClassLike | undefined {
  const seen = new Set<FrameDeclaration>();
  for (let current: Identifier = id; ;) {
    const decl = frameDeclarationOf(current);
    if (decl === undefined || seen.has(decl) || reassigned.has(decl)) return undefined;
    seen.add(decl);
    if (isClassDeclaration(decl)) return decl;
    if (!isVariableDeclaration(decl) || decl.initializer === undefined) return undefined;
    const init = unwrapCalleeExpression(decl.initializer);
    if (isClassExpression(init)) return init;
    if (!isIdentifier(init)) return undefined;
    current = init;
  }
}

function recordAssignedMemberProperties(lhs: Node, builder: SummaryBuilder): void {
  const pending: Node[] = [lhs];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const target = isExpression(current) ? peeled(current) : current;
    if (isPropertyAccessExpression(target) || isElementAccessExpression(target)) {
      recordWrittenMemberAccess(target, builder);
      continue;
    }
    queuePatternNodes(target, pending);
  }
}

function recordWrittenMemberAccess(target: Node, builder: SummaryBuilder): void {
  if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) return;
  const name = memberNameOf(target);
  if (name === undefined) builder.hasDynamicPropertyWrite = true;
  else builder.mutatedProperties.add(name);
}

function recordCallPropertyMutations(call: CallExpression, builder: SummaryBuilder): void {
  const callee = peeled(call.expression);
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return;
  const method = memberNameOf(callee);
  const globalName = globalOf(peeled(callee.expression));
  if (isDefineOrReflectPropertyWrite(globalName, method)) {
    recordDefinedKeyArgument(call.arguments[1], builder);
    return;
  }
  if (
    globalName === 'Object' &&
    (method === 'assign' || method === 'defineProperties' || method === 'setPrototypeOf')
  ) {
    recordMutatedObjectTarget(call.arguments[0], builder);
    return;
  }
  if (globalName === 'Reflect' && method === 'setPrototypeOf') {
    recordMutatedObjectTarget(call.arguments[0], builder);
  }
}

function isDefineOrReflectPropertyWrite(
  globalName: string | undefined,
  method: string | undefined,
): boolean {
  if (globalName === 'Object' && method === 'defineProperty') return true;
  return (
    globalName === 'Reflect' &&
    (method === 'defineProperty' || method === 'deleteProperty' || method === 'set')
  );
}

function recordDefinedKeyArgument(rawKey: Expression | undefined, builder: SummaryBuilder): void {
  const keyArg = rawKey === undefined ? undefined : peeled(rawKey);
  if (
    keyArg !== undefined &&
    (isStringLiteral(keyArg) || isNoSubstitutionTemplateLiteral(keyArg))
  ) {
    builder.mutatedProperties.add(keyArg.text);
  } else {
    builder.hasDynamicPropertyWrite = true;
  }
}

function recordMutatedObjectTarget(
  rawTarget: Expression | undefined,
  builder: SummaryBuilder,
): void {
  const first = rawTarget === undefined ? undefined : peeled(rawTarget);
  if (first === undefined || !isIdentifier(first)) {
    builder.hasUnknownObjectAssign = true;
    return;
  }
  const decl = frameDeclarationOf(first);
  if (decl === undefined) builder.hasUnknownObjectAssign = true;
  else builder.mutatedObjects.add(decl);
}

function queuePatternNodes(target: Node, pending: Node[]): void {
  if (isBinaryExpression(target) && target.operatorToken.kind === SyntaxKind.EqualsToken) {
    pending.push(target.left);
  } else if (isSpreadElement(target) || isSpreadAssignment(target)) {
    pending.push(target.expression);
  } else if (isPropertyAssignment(target)) {
    pending.push(target.initializer);
  } else if (isArrayLiteralExpression(target)) {
    for (const el of target.elements) pending.push(el);
  } else if (isObjectLiteralExpression(target)) {
    for (const prop of target.properties) pending.push(prop);
  }
}

function isReassignedBindingIdentifier(id: Identifier): boolean {
  let current: Node = id;
  while (isAssignmentPatternWrapper(current, current.parent)) current = current.parent;
  const { parent } = current;
  if (isBinaryExpression(parent) && parent.left === current) {
    return isAssignmentOperator(parent.operatorToken.kind);
  }
  if (isForInStatement(parent) || isForOfStatement(parent)) return parent.initializer === current;
  return (
    (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    (parent.operator === SyntaxKind.PlusPlusToken || parent.operator === SyntaxKind.MinusMinusToken)
  );
}

function isAssignmentPatternWrapper(child: Node, parent: Node): boolean {
  return (
    isWrapper(parent) ||
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    (isBinaryExpression(parent) &&
      parent.operatorToken.kind === SyntaxKind.EqualsToken &&
      parent.left === child) ||
    (isPropertyAssignment(parent) && parent.initializer === child) ||
    (isShorthandPropertyAssignment(parent) && parent.name === child)
  );
}

export function isUnreassignedDeclaration(decl: FrameDeclaration): boolean {
  return !fileMutationSummary(decl.getSourceFile()).reassigned.has(decl);
}

export function isStableMember(
  file: SourceFile,
  method: string,
  ownerDecl?: FrameDeclaration,
): boolean {
  const summary = fileMutationSummary(file);
  return (
    !summary.hasDynamicPropertyWrite &&
    !summary.hasUnknownObjectAssign &&
    !summary.mutatedProperties.has(method) &&
    (ownerDecl === undefined || !summary.mutatedObjects.has(ownerDecl))
  );
}

export function immutablePrimitiveConst(decl: TaintKey): boolean {
  if (
    !isVariableDeclaration(decl) ||
    !constantDeclaration(decl) ||
    decl.initializer === undefined
  ) {
    return false;
  }
  return isPrimitiveExpression(peeled(decl.initializer));
}

export function callableParametersInInitializer(expr: Expression): readonly FrameDeclaration[] {
  const found: FrameDeclaration[] = [];
  const pending: Expression[] = [expr];
  const visited = new Set<Expression>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const current = peeled(next);
    if (visited.has(current)) continue;
    visited.add(current);
    if (isAnswering(current)) {
      found.push(...parametersOf(current));
      continue;
    }
    queueBranchExpressions(current, pending);
  }
  return found;
}

export function propertyWriteMayInvokeSetter(target: Expression): boolean {
  const summary = fileMutationSummary(target.getSourceFile());
  if (!summary.hasComputedSetter && summary.setterNames.size === 0) return false;
  if (summary.hasComputedSetter) return true;
  const key = memberNameOf(target);
  return key === undefined || summary.setterNames.has(key);
}
