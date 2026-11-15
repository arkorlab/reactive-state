import {
  type ClassDeclaration,
  type ClassElement,
  type ClassExpression,
  type ConstructorDeclaration,
  type ElementAccessExpression,
  type Expression,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isConstructorDeclaration,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNonNullExpression,
  isParenthesizedExpression,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isReturnStatement,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isSourceFile,
  type Node,
  type PropertyAccessExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { type MetadataSource } from './input-bindings.ts';
import { metadataInitializer } from './input-callees.ts';
import { literalPropertyName } from './input-selections.ts';
import { constantValue } from './numbers.ts';

/** Member resolution on fresh base-class construction receivers (`this.field`). */

type BaseClass = ClassDeclaration | ClassExpression;
export type MemberAccess = ElementAccessExpression | PropertyAccessExpression;

export const PROTO_KEY = '__proto__';

export const SAFE_INSPECTORS: ReadonlySet<string> = new Set([
  'Object.freeze',
  'Object.isExtensible',
  'Object.isFrozen',
  'Object.isSealed',
  'Object.preventExtensions',
  'Object.seal',
  'Reflect.isExtensible',
  'Reflect.preventExtensions',
]);

const ASSIGNMENT_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Walks outward across parentheses and erased TypeScript value assertions around `node`. */
export function wrappedExpression(node: Expression): Expression {
  let current = node;
  while (
    isParenthesizedExpression(current.parent) ||
    isAsExpression(current.parent) ||
    isSatisfiesExpression(current.parent) ||
    isNonNullExpression(current.parent)
  ) {
    current = current.parent;
  }
  return current;
}

/** Static property, private field, or constant bracket key of a member access. */
export function memberAccessKey(node: MemberAccess): string | undefined {
  if (isPropertyAccessExpression(node)) {
    return isIdentifier(node.name) || isPrivateIdentifier(node.name) ? node.name.text : undefined;
  }
  const constant = constantValue(node.argumentExpression, metadataInitializer);
  return constant === undefined ? undefined : String(constant);
}

/** Candidate values written to `this[key]` on a proven fresh base-class receiver; undefined otherwise. */
export function receiverMemberSources(
  thisNode: Expression,
  key: string,
  source: MetadataSource,
  writtenMembers: ReadonlySet<Node>,
): readonly MetadataSource[] | undefined {
  const cls = enclosingFreshBaseClass(thisNode);
  if (cls === undefined) {
    return undefined;
  }
  const declared = declaredReceiverSources(cls, key, source);
  if (declared === undefined) {
    return undefined;
  }
  const assigned = assignedReceiverSources(cls, key, source, writtenMembers);
  return assigned === undefined ? undefined : [...declared, ...assigned];
}

/**
 * Downstream `this.<slot>` reads when `ref` initializes a fresh base-class slot (`field = ref` or
 * `this.field = ref`); `null` when `ref` is not in a receiver slot position, `undefined` if unsafe.
 */
export function receiverSlotReads(
  ref: Expression,
  writtenMembers: ReadonlySet<Node>,
): readonly Expression[] | undefined | null {
  const slot = enclosingReceiverSlot(ref);
  if (slot === null) {
    return null;
  }
  if (slot === undefined) {
    return undefined;
  }
  return collectSafeSlotReads(slot.cls, slot.key, writtenMembers);
}

/** Resolves `(cls, key)` when `ref` is a class instance field initializer or `this.key = ref` RHS. */
function enclosingReceiverSlot(
  ref: Expression,
): { readonly cls: BaseClass; readonly key: string } | undefined | null {
  const parent = ref.parent;
  if (isPropertyDeclaration(parent) && !isStaticMember(parent) && parent.initializer === ref) {
    const cls = baseClassOf(parent.parent);
    const key = classMemberKey(parent.name);
    return cls === undefined || key === undefined || key === PROTO_KEY ? undefined : { cls, key };
  }
  if (
    !isBinaryExpression(parent) ||
    parent.right !== ref ||
    !ASSIGNMENT_OPERATORS.has(parent.operatorToken.kind)
  ) {
    return null;
  }
  const target = unwrapped(parent.left);
  if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) {
    return null;
  }
  const receiver = unwrapped(target.expression);
  if (receiver.kind !== SyntaxKind.ThisKeyword) {
    return null;
  }
  const cls = enclosingFreshBaseClass(receiver);
  const key = memberAccessKey(target);
  return cls === undefined || key === undefined || key === PROTO_KEY ? undefined : { cls, key };
}

/** Collects `this.<slotKey>` read expressions when every `this` reference in `cls` stays contained. */
function collectSafeSlotReads(
  cls: BaseClass,
  slotKey: string,
  writtenMembers: ReadonlySet<Node>,
): readonly Expression[] | undefined {
  if (!hasPlainInstanceMembers(cls, slotKey)) {
    return undefined;
  }
  const reads: Expression[] = [];
  for (const thisRef of receiverKeywordsOf(cls)) {
    const step = classifySlotReceiverRef(wrappedExpression(thisRef), slotKey, writtenMembers);
    if (step === null) {
      return undefined;
    }
    if (step !== undefined) {
      reads.push(step);
    }
  }
  return reads;
}

/** Returns a matching read expression, `undefined` for safe non-reads, or `null` on unsafe `this` use. */
function classifySlotReceiverRef(
  ref: Expression,
  slotKey: string,
  writtenMembers: ReadonlySet<Node>,
): Expression | undefined | null {
  const parent = ref.parent;
  if (
    (isReturnStatement(parent) && parent.expression === ref) ||
    isSafeInspectorArgument(ref, parent)
  ) {
    return undefined;
  }
  if (
    (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
    wrappedExpression(unwrapped(parent.expression)) !== ref
  ) {
    return null;
  }
  const outer = wrappedExpression(parent);
  if (
    isCallExpression(outer.parent) &&
    wrappedExpression(unwrapped(outer.parent.expression)) === outer
  ) {
    return null;
  }
  const key = memberAccessKey(parent);
  if (writtenMembers.has(unwrapped(parent))) {
    return key !== undefined && key !== PROTO_KEY && directAssignmentValue(outer) !== undefined
      ? undefined
      : null;
  }
  return key === undefined || key === slotKey ? outer : undefined;
}

/** Verifies `cls` defines no prototype method/accessor on `key` or computed instance members. */
function hasPlainInstanceMembers(cls: BaseClass, key: string): boolean {
  for (const member of cls.members) {
    if (isStaticMember(member) || isConstructorDeclaration(member)) {
      continue;
    }
    const memberName = member.name === undefined ? undefined : classMemberKey(member.name);
    if (
      isGetAccessorDeclaration(member) ||
      isSetAccessorDeclaration(member) ||
      isMethodDeclaration(member)
    ) {
      if (memberName === undefined || memberName === key) {
        return false;
      }
    } else if (
      isPropertyDeclaration(member) &&
      memberName === undefined &&
      member.initializer !== undefined
    ) {
      return false;
    }
  }
  return true;
}

/** Collects instance field initializers and constructor parameter properties for `key` on `cls`. */
function declaredReceiverSources(
  cls: BaseClass,
  key: string,
  source: MetadataSource,
): readonly MetadataSource[] | undefined {
  if (!hasPlainInstanceMembers(cls, key)) {
    return undefined;
  }
  const found: MetadataSource[] = [];
  for (const member of cls.members) {
    if (
      isPropertyDeclaration(member) &&
      !isStaticMember(member) &&
      member.initializer !== undefined &&
      classMemberKey(member.name) === key
    ) {
      found.push({ bindings: source.bindings, value: member.initializer });
    }
  }
  const parameterSources = constructorParameterPropertySources(cls, key, source);
  return parameterSources === undefined ? undefined : [...found, ...parameterSources];
}

/** Collects TypeScript parameter property bindings (`constructor(public data = ...)`) matching `key`. */
function constructorParameterPropertySources(
  cls: BaseClass,
  key: string,
  source: MetadataSource,
): readonly MetadataSource[] | undefined {
  const ctor = cls.members.find((member): member is ConstructorDeclaration =>
    isConstructorDeclaration(member),
  );
  if (ctor === undefined) {
    return [];
  }
  const found: MetadataSource[] = [];
  for (const parameter of ctor.parameters) {
    if ((parameter.modifiers?.length ?? 0) === 0) {
      continue;
    }
    if (!isIdentifier(parameter.name)) {
      return undefined;
    }
    if (parameter.name.text === key) {
      found.push({ bindings: source.bindings, value: parameter.name });
    }
  }
  return found;
}

/** Collects `this[key] = rhs` writes while ensuring `this` never escapes or undergoes dynamic mutation. */
function assignedReceiverSources(
  cls: BaseClass,
  key: string,
  source: MetadataSource,
  writtenMembers: ReadonlySet<Node>,
): readonly MetadataSource[] | undefined {
  const found: MetadataSource[] = [];
  for (const thisRef of receiverKeywordsOf(cls)) {
    const step = classifyReceiverWrite(wrappedExpression(thisRef), key, writtenMembers);
    if (step === null) {
      return undefined;
    }
    if (step !== undefined) {
      found.push({ bindings: source.bindings, value: step });
    }
  }
  return found;
}

/** Returns assigned `rhs` for `this[key] = rhs`, `undefined` for safe uses, or `null` when unsafe. */
function classifyReceiverWrite(
  ref: Expression,
  key: string,
  writtenMembers: ReadonlySet<Node>,
): Expression | undefined | null {
  const parent = ref.parent;
  if (
    (isReturnStatement(parent) && parent.expression === ref) ||
    isSafeInspectorArgument(ref, parent)
  ) {
    return undefined;
  }
  if (
    (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
    wrappedExpression(unwrapped(parent.expression)) !== ref
  ) {
    return null;
  }
  const outer = wrappedExpression(parent);
  if (
    isCallExpression(outer.parent) &&
    wrappedExpression(unwrapped(outer.parent.expression)) === outer
  ) {
    return null;
  }
  if (!writtenMembers.has(unwrapped(parent))) {
    return undefined;
  }
  const writtenKey = memberAccessKey(parent);
  if (writtenKey === undefined || writtenKey === PROTO_KEY) {
    return null;
  }
  if (writtenKey !== key) {
    return undefined;
  }
  return directAssignmentValue(outer) ?? null;
}

/** RHS expression when `outer` is the direct left operand of `=`, `||=`, `&&=`, or `??=`. */
function directAssignmentValue(outer: Expression): Expression | undefined {
  const parent = outer.parent;
  return isBinaryExpression(parent) &&
    parent.left === outer &&
    ASSIGNMENT_OPERATORS.has(parent.operatorToken.kind)
    ? parent.right
    : undefined;
}

/** Allows single-argument lock/introspection calls such as `Object.freeze(this)`. */
function isSafeInspectorArgument(ref: Expression, parent: Node): boolean {
  if (!isCallExpression(parent) || parent.arguments.length !== 1 || parent.arguments[0] !== ref) {
    return false;
  }
  const path = globalPathOf(unwrapped(parent.expression))?.join('.');
  return path !== undefined && SAFE_INSPECTORS.has(path);
}

/** Finds all `ThisKeyword` expressions bound to `cls`'s instance field initializers or constructor. */
function receiverKeywordsOf(cls: BaseClass): readonly Expression[] {
  const roots: Node[] = [];
  for (const member of cls.members) {
    if (isConstructorDeclaration(member) && member.body !== undefined) {
      roots.push(member.body);
    } else if (
      isPropertyDeclaration(member) &&
      !isStaticMember(member) &&
      member.initializer !== undefined
    ) {
      roots.push(member.initializer);
    }
  }
  const found: Expression[] = [];
  const pending: Node[] = [...roots];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.kind === SyntaxKind.ThisKeyword) {
      found.push(node as Expression);
      continue;
    }
    node.forEachChild((child) => {
      if (!bindsOwnReceiver(node, child)) {
        pending.push(child);
      }
    });
  }
  return found;
}

/** Resolves the enclosing heritage-free class when `thisNode` binds to its construction receiver. */
function enclosingFreshBaseClass(thisNode: Expression): BaseClass | undefined {
  for (
    let at: Node = thisNode.parent, within: Node = thisNode;
    !isSourceFile(at);
    within = at, at = at.parent
  ) {
    if (isConstructorDeclaration(at) && within === at.body) {
      return baseClassOf(at.parent);
    }
    if (isPropertyDeclaration(at) && !isStaticMember(at) && within === at.initializer) {
      return baseClassOf(at.parent);
    }
    if (bindsOwnReceiver(at, within)) {
      return undefined;
    }
  }
  return undefined;
}

/** Whether stepping into `child` of `node` enters a scope with its own `this` binding. */
function bindsOwnReceiver(node: Node, child: Node): boolean {
  if (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isClassStaticBlockDeclaration(node)
  ) {
    return child === node.body;
  }
  return isPropertyDeclaration(node) && child === node.initializer;
}

/** Returns `node` when it is a class declaration or expression with no `extends` heritage clause. */
function baseClassOf(node: Node): BaseClass | undefined {
  return (isClassDeclaration(node) || isClassExpression(node)) && node.heritageClauses === undefined
    ? node
    : undefined;
}

/** Static member key or `#private` field key on a class element name. */
function classMemberKey(name: Node): string | undefined {
  return isPrivateIdentifier(name) ? name.text : literalPropertyName(name);
}

/** Whether a class element carries the `static` modifier. */
function isStaticMember(member: ClassElement): boolean {
  return member.modifiers?.some((modifier) => modifier.kind === SyntaxKind.StaticKeyword) === true;
}
