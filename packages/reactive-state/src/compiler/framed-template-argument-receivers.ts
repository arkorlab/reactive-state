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
  isForStatement,
  isIdentifier,
  isNewExpression,
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
  isVariableDeclarationList,
  isVariableStatement,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type PropertyName,
  type SetAccessorDeclaration,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { type Answering, isAnswering, parametersOf } from './answers.ts';
import { globalOf, literalName } from './bounded.ts';
import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import {
  constantDeclaration,
  isAssignmentOperator,
  queueBranchExpressions,
} from './framed-template-argument-spreads.ts';
import { peeled } from './framed-written-targets.ts';
import { bindingIdentifiers, isTypeOnly } from './scope.ts';

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

interface SummaryState {
  readonly assignedValues: Map<VariableDeclaration, Expression[]>;
  hasComputedSetter: boolean;
  hasDynamicPropertyWrite: boolean;
  hasUnknownObjectAssign: boolean;
  readonly mutatedObjects: Set<FrameDeclaration>;
  readonly mutatedProperties: Set<string>;
  readonly openReassigned: Set<FrameDeclaration>;
  readonly reassigned: Set<FrameDeclaration>;
  readonly setterNames: Set<string>;
  readonly subclassesByBase: Map<ClassLike, ClassLike[]>;
}

const FILE_SUMMARIES = new WeakMap<SourceFile, SummaryState>();

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

const DIRECT_ASSIGNMENT_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

export { peeled as unwrapCalleeExpression } from './framed-written-targets.ts';

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
  if (isPrivateIdentifier(name) || isIdentifier(name) || isStaticTextOrNumber(name)) {
    return { dynamic: false, key: name.text };
  }
  if (!isComputedPropertyName(name)) return { dynamic: true, key: undefined };
  const inner = peeled(name.expression);
  return isStaticTextOrNumber(inner)
    ? { dynamic: false, key: inner.text }
    : { dynamic: true, key: undefined };
}

function isStaticTextOrNumber(node: Node): node is Node & { readonly text: string } {
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) || isNumericLiteral(node);
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
  const inner = peeled(expr);
  return (
    inner.kind === SyntaxKind.NullKeyword ||
    (isIdentifier(inner) && inner.text === 'undefined' && frameDeclarationOf(inner) === undefined)
  );
}

export function fileMutationSummary(file: SourceFile): FileMutationSummary {
  return internalMutationSummary(file);
}

function internalMutationSummary(file: SourceFile): SummaryState {
  const cached = FILE_SUMMARIES.get(file);
  if (cached !== undefined) return cached;
  const builder: SummaryState = {
    assignedValues: new Map(),
    hasComputedSetter: false,
    hasDynamicPropertyWrite: false,
    hasUnknownObjectAssign: false,
    mutatedObjects: new Set(),
    mutatedProperties: new Set(),
    openReassigned: new Set(),
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
  finalizeMutatedObjects(builder);
  recordClassRelationships(file, builder);
  FILE_SUMMARIES.set(file, builder);
  return builder;
}

function finalizeMutatedObjects(builder: SummaryState): void {
  for (const decl of builder.mutatedObjects) {
    if (builder.reassigned.has(decl) || !isFreshContainerDeclaration(decl)) {
      builder.hasUnknownObjectAssign = true;
      return;
    }
  }
}

function isFreshContainerDeclaration(decl: FrameDeclaration): boolean {
  if (!isVariableDeclaration(decl) || decl.initializer === undefined) return false;
  const init = peeled(decl.initializer);
  return isObjectLiteralExpression(init) || isArrayLiteralExpression(init) || isNewExpression(init);
}

function inspectSummaryNode(node: Node, builder: SummaryState): void {
  if (isSetAccessorDeclaration(node)) {
    const info = declaredMemberKey(node.name);
    if (info.key === undefined) builder.hasComputedSetter = true;
    else builder.setterNames.add(info.key);
    return;
  }
  if (isVariableDeclaration(node)) {
    recordVariableRedeclaration(node, builder);
    return;
  }
  if (isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    const rhs = DIRECT_ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) ? node.right : undefined;
    recordAssignmentTarget(node.left, rhs, builder);
    return;
  }
  const openTarget = openWriteTargetOf(node);
  if (openTarget !== undefined) {
    recordAssignmentTarget(openTarget, undefined, builder);
    return;
  }
  if (isDeleteExpression(node)) recordWrittenMemberAccess(peeled(node.expression), builder);
  else if (isCallExpression(node)) recordCallPropertyMutations(node, builder);
}

function openWriteTargetOf(node: Node): Node | undefined {
  if (isForInStatement(node) || isForOfStatement(node)) {
    return isVariableDeclarationList(node.initializer) ? undefined : node.initializer;
  }
  if (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) {
    return node.operator === SyntaxKind.PlusPlusToken ||
      node.operator === SyntaxKind.MinusMinusToken
      ? node.operand
      : undefined;
  }
  return undefined;
}

function recordVariableRedeclaration(node: VariableDeclaration, builder: SummaryState): void {
  for (const bound of bindingIdentifiers(node.name)) {
    const canon = frameDeclarationOf(bound);
    if (canon !== undefined && canon !== node) {
      builder.reassigned.add(canon);
      builder.openReassigned.add(canon);
    }
  }
}

function recordClassRelationships(file: SourceFile, builder: SummaryState): void {
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

function resolveDirectBaseClassWith(
  cls: ClassLike,
  reassigned: ReadonlySet<FrameDeclaration>,
): ClassLike | undefined {
  const rawBase = resolveDirectBaseExpression(cls);
  if (rawBase === undefined) return undefined;
  const expr = peeled(rawBase);
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
    const init = peeled(decl.initializer);
    if (isClassExpression(init)) return init;
    if (!isIdentifier(init)) return undefined;
    current = init;
  }
}

function recordAssignmentTarget(
  lhs: Node,
  directRhs: Expression | undefined,
  builder: SummaryState,
): void {
  const directRoot = isExpression(lhs) ? peeled(lhs) : lhs;
  if (directRhs !== undefined && isIdentifier(directRoot)) {
    recordDirectIdentifierWrite(directRoot, directRhs, builder);
    return;
  }
  const pending: Node[] = [lhs];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const target = isExpression(current) ? peeled(current) : current;
    if (isIdentifier(target)) recordOpenIdentifierWrite(target, builder);
    else if (isPropertyAccessExpression(target) || isElementAccessExpression(target)) {
      recordWrittenMemberAccess(target, builder);
    } else queuePatternNodes(target, pending);
  }
}

function recordDirectIdentifierWrite(id: Identifier, rhs: Expression, builder: SummaryState): void {
  const decl = frameDeclarationOf(id);
  if (decl === undefined) return;
  builder.reassigned.add(decl);
  if (!isVariableDeclaration(decl)) return;
  let list = builder.assignedValues.get(decl);
  if (list === undefined) {
    list = [];
    builder.assignedValues.set(decl, list);
  }
  list.push(rhs);
}

function recordOpenIdentifierWrite(id: Identifier, builder: SummaryState): void {
  const decl = frameDeclarationOf(id);
  if (decl === undefined) return;
  builder.reassigned.add(decl);
  builder.openReassigned.add(decl);
}

function recordWrittenMemberAccess(target: Node, builder: SummaryState): void {
  if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) return;
  const name = memberNameOf(target);
  if (name === undefined) builder.hasDynamicPropertyWrite = true;
  else builder.mutatedProperties.add(name);
}

function recordCallPropertyMutations(call: CallExpression, builder: SummaryState): void {
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

function recordDefinedKeyArgument(rawKey: Expression | undefined, builder: SummaryState): void {
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

function recordMutatedObjectTarget(rawTarget: Expression | undefined, builder: SummaryState): void {
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
  } else if (isShorthandPropertyAssignment(target)) {
    pending.push(target.name);
  } else if (isArrayLiteralExpression(target)) {
    for (const el of target.elements) pending.push(el);
  } else if (isObjectLiteralExpression(target)) {
    for (const prop of target.properties) pending.push(prop);
  }
}

export function isUnreassignedDeclaration(decl: FrameDeclaration): boolean {
  return !fileMutationSummary(decl.getSourceFile()).reassigned.has(decl);
}

export function declarationValueExpressions(
  decl: FrameDeclaration,
): readonly Expression[] | undefined {
  if (!isVariableDeclaration(decl) || !isIdentifier(decl.name)) return undefined;
  const summary = internalMutationSummary(decl.getSourceFile());
  if (summary.openReassigned.has(decl) || !isClosedDeclarationHolder(decl, summary)) {
    return undefined;
  }
  const writes = summary.assignedValues.get(decl);
  if (writes === undefined || writes.length === 0) {
    return decl.initializer === undefined ? undefined : [decl.initializer];
  }
  const raw = decl.initializer === undefined ? writes : [decl.initializer, ...writes];
  const nonNullish = raw.filter((expr) => !isNullishExpression(expr));
  return nonNullish.length > 0 ? nonNullish : raw;
}

function isClosedDeclarationHolder(decl: VariableDeclaration, summary: SummaryState): boolean {
  const list = decl.parent;
  if (!isVariableDeclarationList(list)) return false;
  const holder = list.parent;
  if (isForStatement(holder)) return holder.initializer === list;
  if (!isVariableStatement(holder)) return false;
  const { modifiers } = holder;
  if (modifiers === undefined) return true;
  const isReassigned = summary.reassigned.has(decl);
  for (const mod of modifiers) {
    if (mod.kind === SyntaxKind.DeclareKeyword) return false;
    if (isReassigned && mod.kind === SyntaxKind.ExportKeyword) return false;
  }
  return true;
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
  return (
    isVariableDeclaration(decl) &&
    constantDeclaration(decl) &&
    decl.initializer !== undefined &&
    isPrimitiveExpression(peeled(decl.initializer))
  );
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
