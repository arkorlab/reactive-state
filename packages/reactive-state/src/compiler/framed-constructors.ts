import {
  type ClassDeclaration,
  type ClassExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isConstructorDeclaration,
  isDecorator,
  isExpressionStatement,
  isExpressionWithTypeArguments,
  isPropertyAccessExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isSourceFile,
  isTypeNode,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type ObjectLiteralExpression,
  type PropertyName,
  type VariableDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { heritageReference } from './local-type-class-bases.ts';
import { readsBinding } from './scope.ts';

/** Source-written local constructions, distinct from the exact-native await proof. */

type LocalClass = ClassDeclaration | ClassExpression;

const ASSIGNMENT_WRAPPERS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AsExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.TypeAssertionExpression,
]);

/** Direct and native reflected construction retain every possible written constructor target. */
export function framedConstructionTargets(node: Expression): readonly Expression[] | undefined {
  if (isNewExpression(node)) return [node.expression];
  if (
    !isCallExpression(node) ||
    globalPathOf(unwrapped(node.expression))?.join('.') !== 'Reflect.construct'
  )
    return undefined;
  const prefix = framedArgumentPrefix(node);
  const target = prefix.values[0];
  return target === undefined ? prefix.alternatives : [target, ...(prefix.alternatives ?? [])];
}

/** A local constructor's native base, without treating a subclass as non-thenable. */
export function framedSubclassConstructor(node: Expression, names: ReadonlySet<string>): boolean {
  const seen = new Set<Node>();
  let reference = constructorReference(node);
  for (;;) {
    if (reference === undefined) return false;
    if (reference.builtin !== undefined) return names.has(reference.builtin);
    const declared = reference.binding;
    if (
      declared === undefined ||
      declared === null ||
      seen.has(declared) ||
      !unchangedClass(declared)
    )
      return false;
    seen.add(declared);
    const base = baseExpression(declared);
    if (base === undefined) return false;
    reference = constructorReference(base);
  }
}

/** Only transparent native construction or literal data results establish locally written words. */
export function framedSubclassOwnWords(node: Expression, names: ReadonlySet<string>): boolean {
  const declared = constructorReference(node)?.binding;
  return declared !== undefined && declared !== null && ordinaryConstruction(declared, names);
}

/** A local subclass whose source constructors only call `super`, nearest first, and its native base. */
export interface SubclassChain {
  readonly classes: readonly LocalClass[];
  readonly base: string;
}

/**
 * The transparent constructor chain from a local subclass target to its native base: unchanged,
 * undecorated classes whose constructors, where written, only call `super` (and write a literal
 * stack), so the construction answers the native base's own error.
 */
export function framedSubclassChain(
  node: Expression,
  names: ReadonlySet<string>,
): SubclassChain | undefined {
  const classes: LocalClass[] = [];
  let reference = constructorReference(node);
  while (reference !== undefined) {
    if (reference.builtin !== undefined)
      return names.has(reference.builtin) && classes.length > 0
        ? { base: reference.builtin, classes }
        : undefined;
    const declared = reference.binding;
    if (
      declared === undefined ||
      declared === null ||
      classes.includes(declared) ||
      !unchangedClass(declared) ||
      hasDecorator(declared)
    )
      return undefined;
    const result = constructorResult(declared, true);
    if (result === undefined || result.object !== undefined) return undefined;
    classes.push(declared);
    const base = baseExpression(declared);
    if (base === undefined) return undefined;
    reference = constructorReference(base);
  }
  return undefined;
}

/** Every source constructor must retain an ordinary receiver before field initializers are trusted. */
function ordinaryConstruction(
  declared: LocalClass,
  names: ReadonlySet<string>,
  stackWrites = false,
): boolean {
  const seen = new Set<Node>();
  let at: LocalClass | undefined = declared;
  while (at !== undefined && !seen.has(at)) {
    seen.add(at);
    if (!unchangedClass(at) || hasDecorator(at)) return false;
    const returned = constructorResult(at, stackWrites);
    if (returned === undefined) return false;
    if (returned.object !== undefined && !objectData(returned.object, new Set())) return false;
    const base = baseExpression(at);
    if (base === undefined) return false;
    const reference = constructorReference(base);
    if (reference?.builtin !== undefined) return names.has(reference.builtin);
    at = reference?.binding ?? undefined;
  }
  return false;
}

/** Decorators may replace constructors or field initialization, so they establish no data proof. */
function hasDecorator(declared: LocalClass): boolean {
  const pending: Node[] = [declared];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isDecorator(node)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Known constructed data members, never the shape of an arbitrary parameter of that class. */
export function framedConstructedData(
  node: Expression,
  members: readonly string[] | undefined,
  names: ReadonlySet<string>,
): boolean {
  if (members === undefined || members.length === 0) return false;
  const classes = constructedClasses(node);
  return (
    classes?.every((declared) => {
      return (
        ordinaryConstruction(declared, names, true) &&
        constructedMembers(declared, new Set(members))
      );
    }) === true
  );
}

/** Literal fields selected only after the complete constructor chain is known ordinary. */
function constructedMembers(first: LocalClass, missing: Set<string>): boolean {
  const seen = new Set<Node>();
  let declared: LocalClass | undefined = first;
  while (declared !== undefined && !seen.has(declared)) {
    seen.add(declared);
    if (!unchangedClass(declared)) return false;
    const returned = constructorResult(declared, true);
    if (returned === undefined) return false;
    if (returned.object !== undefined) return objectData(returned.object, missing);
    if (!ownDataMembers(declared, missing, returned.stack === true)) return false;
    if (missing.size === 0) return true;
    const base = baseExpression(declared);
    declared = base === undefined ? undefined : (constructorReference(base)?.binding ?? undefined);
  }
  return false;
}

/** A written class binding keeps its source constructor only while no write replaces it. */
function unchangedClass(declared: LocalClass): boolean {
  return !isClassDeclaration(declared) || constructorWrites(declared).length === 0;
}

/** One direct earlier replacement in the same block establishes its written class expression. */
function constructorReference(node: Expression): ReturnType<typeof heritageReference> | undefined {
  const reference = heritageReference(node);
  const declared = reference.binding;
  if (declared === undefined || declared === null || !isClassDeclaration(declared))
    return reference;
  const writes = constructorWrites(declared);
  if (writes.length === 0) return reference;
  if (!isIdentifier(node) || frameDeclarationOf(node) !== declared) return undefined;
  const [write] = writes;
  if (
    write === undefined ||
    writes.length !== 1 ||
    !isBinaryExpression(write) ||
    write.operatorToken.kind !== SyntaxKind.EqualsToken ||
    !isIdentifier(unwrapped(write.left)) ||
    !isExpressionStatement(write.parent) ||
    write.parent.parent !== declared.parent ||
    write.pos < declared.end ||
    write.end >= node.pos ||
    !isClassExpression(unwrapped(write.right))
  )
    return undefined;
  for (let at: Node = node; at.parent !== declared.parent; at = at.parent) {
    if (isAnswering(at) || isSourceFile(at)) return undefined;
  }
  return heritageReference(write.right);
}

/** Every source write to this lexical class binding, including deferred owners. */
function constructorWrites(declared: ClassDeclaration): readonly Node[] {
  if (declared.name === undefined) return [];
  const writes = new Set<Node>();
  const pending: Node[] = [declared.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isIdentifier(node) && readsBinding(node) && frameDeclarationOf(node) === declared) {
      const write = writtenConstructorBy(node);
      if (write !== undefined) writes.add(write);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return [...writes];
}

/** Direct and destructured assignments, unary changes and loop bindings replace a constructor. */
function writtenConstructorBy(name: Node): Node | undefined {
  let target = name;
  while (assignmentContainer(target)) target = target.parent;
  const parent = target.parent;
  if (isBinaryExpression(parent) && parent.left === target) {
    const kind = parent.operatorToken.kind;
    return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment
      ? parent
      : undefined;
  }
  if (isForInStatement(parent) || isForOfStatement(parent))
    return parent.initializer === target ? parent : undefined;
  return (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    (parent.operator === SyntaxKind.PlusPlusToken || parent.operator === SyntaxKind.MinusMinusToken)
    ? parent
    : undefined;
}

/** Assignment patterns retain their target binding, without following object member receivers. */
function assignmentContainer(target: Node): boolean {
  const parent = target.parent;
  const wrapper = ASSIGNMENT_WRAPPERS.has(parent.kind);
  return (
    (wrapper && 'expression' in parent && parent.expression === target) ||
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === target) ||
    (isShorthandPropertyAssignment(parent) && parent.name === target)
  );
}

/** Literal instance initializers establish only their own written fields. */
function ownDataMembers(declared: LocalClass, missing: Set<string>, stack: boolean): boolean {
  for (const member of declared.members) {
    if (!isPropertyDeclaration(member) || member.initializer === undefined || isStatic(member))
      continue;
    const key = memberKey(member.name);
    if (key === undefined || !literalData(member.initializer)) return false;
    missing.delete(key);
  }
  if (stack) missing.delete('stack');
  return true;
}

/** A direct construction or whole constant value alias, without following mutable receivers. */
function constructedClasses(node: Expression): readonly LocalClass[] | undefined {
  const seen = new Set<Node>();
  const aliases = new Set<VariableDeclaration>();
  const uses = new Set<Node>();
  let value = unwrapped(node);
  while (!seen.has(value)) {
    seen.add(value);
    const targets = framedConstructionTargets(value);
    if (targets !== undefined)
      return unobservedAliases(node, aliases, uses) ? targetClasses(targets) : undefined;
    if (!isIdentifier(value)) return undefined;
    const declared = frameDeclarationOf(value);
    if (declared === undefined || !isVariableDeclaration(declared)) return undefined;
    aliases.add(declared);
    uses.add(value);
    uses.add(declared.name);
    const statement = declared.parent.parent;
    if (
      !isVariableStatement(statement) ||
      !/^const\s/u.test(statement.declarationList.getText(statement.getSourceFile())) ||
      declared.initializer === undefined
    )
      return undefined;
    value = unwrapped(declared.initializer);
  }
  return undefined;
}

/** Every possible target must retain its own source class before an instance data proof is used. */
function targetClasses(targets: readonly Expression[]): readonly LocalClass[] | undefined {
  if (targets.length === 0) return undefined;
  const classes: LocalClass[] = [];
  for (const target of targets) {
    const declared = constructorReference(target)?.binding;
    if (declared === undefined || declared === null) return undefined;
    classes.push(declared);
  }
  return classes;
}

/** Any other use may write or expose an instance, including a deferred body's use. */
function unobservedAliases(
  node: Node,
  aliases: ReadonlySet<VariableDeclaration>,
  uses: ReadonlySet<Node>,
): boolean {
  if (aliases.size === 0) return true;
  const pending: Node[] = [node.getSourceFile()];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isTypeNode(at) && !isExpressionWithTypeArguments(at)) continue;
    if (isIdentifier(at) && readsBinding(at) && !uses.has(at)) {
      const declared = frameDeclarationOf(at);
      if (declared !== undefined && isVariableDeclaration(declared) && aliases.has(declared))
        return false;
    }
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** A transparent super call or an unconditional directly written object result. */
function constructorResult(
  declared: LocalClass,
  stackWrites = false,
): { readonly object?: ObjectLiteralExpression; readonly stack?: boolean } | undefined {
  const constructor = declared.members.find((member) => isConstructorDeclaration(member));
  if (constructor === undefined) return {};
  if (constructor.body === undefined) return undefined;
  let superCalled = false;
  let stack = false;
  for (const statement of constructor.body.statements) {
    if (
      isExpressionStatement(statement) &&
      isCallExpression(statement.expression) &&
      statement.expression.expression.kind === SyntaxKind.SuperKeyword
    ) {
      superCalled = true;
      continue;
    }
    if (stackWrites && superCalled && literalStackWrite(statement)) {
      stack = true;
      continue;
    }
    if (!isReturnStatement(statement) || statement.expression === undefined) return undefined;
    const value = unwrapped(statement.expression);
    return isObjectLiteralExpression(value) ? { object: value } : undefined;
  }
  return { stack };
}

/** Only a direct literal assignment to this receiver's stack is accepted after transparent super. */
function literalStackWrite(node: Node): boolean {
  if (!isExpressionStatement(node)) return false;
  const write = unwrapped(node.expression);
  if (!isBinaryExpression(write) || write.operatorToken.kind !== SyntaxKind.EqualsToken)
    return false;
  const target = unwrapped(write.left);
  return (
    (isPropertyAccessExpression(target) || isElementAccessExpression(target)) &&
    unwrapped(target.expression).kind === SyntaxKind.ThisKeyword &&
    frameMemberName(target) === 'stack' &&
    literalData(write.right)
  );
}

/** Own literal data fields supplied by a constructor result, with opaque overwrites unproven. */
function objectData(value: ObjectLiteralExpression, members: ReadonlySet<string>): boolean {
  const found = new Set<string>();
  for (const property of value.properties) {
    if (!isPropertyAssignment(property)) return false;
    const key = memberKey(property.name);
    if (key === undefined || !literalData(property.initializer)) return false;
    found.add(key);
  }
  for (const member of members) {
    if (!found.has(member)) return false;
  }
  return true;
}

/** The literal key of a written field; computed unknown keys establish no own member. */
function memberKey(name: PropertyName): string | undefined {
  if (isComputedPropertyName(name)) {
    const key = unwrapped(name.expression);
    return isStringLiteral(key) || isNoSubstitutionTemplateLiteral(key) ? key.text : undefined;
  }
  return isIdentifier(name) || isStringLiteral(name) || isNumericLiteral(name)
    ? name.text
    : undefined;
}

/** Literal field values cannot replace a sibling field or expose error frames themselves. */
function literalData(node: Expression): boolean {
  const value = unwrapped(node);
  return (
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    isNumericLiteral(value) ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.NullKeyword
  );
}

/** Static fields belong to the constructor rather than the constructed receiver. */
function isStatic(node: Node): boolean {
  return (
    (node as { readonly modifiers?: readonly Node[] }).modifiers?.some(
      (modifier) => modifier.kind === SyntaxKind.StaticKeyword,
    ) === true
  );
}

/** The one constructor-valued base of a local class, resolved in its own lexical scope. */
function baseExpression(declared: LocalClass): Expression | undefined {
  const base = declared.heritageClauses?.find(
    (clause) => clause.token === SyntaxKind.ExtendsKeyword,
  )?.types[0];
  return base !== undefined && isExpressionWithTypeArguments(base) ? base.expression : undefined;
}
