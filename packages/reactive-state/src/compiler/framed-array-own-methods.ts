import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isElementAccessExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isForInStatement,
  isForOfStatement,
  isExpressionStatement,
  isFunctionLikeDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type MethodDeclaration,
  type Node,
  NodeFlags,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import {
  sourceArrayFunction,
  writtenArrayFunction,
  writtenArrayKey,
} from './framed-array-functions.ts';
import { arrayRestBinding } from './framed-array-rest.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedWrittenTargets } from './framed-written-targets.ts';
import { constantValue } from './numbers.ts';
import { bindingIdentifiers, isBlockScoped } from './scope.ts';

/** The names an array's own methods may take, and what a direct write of one declares. */

export const OWN_METHODS = new Set([
  'at',
  'concat',
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flat',
  'flatMap',
  'forEach',
  'join',
  'map',
  'pop',
  'reduce',
  'reduceRight',
  'shift',
  'slice',
  'some',
  'sort',
  'splice',
  'toReversed',
  'toSorted',
  'toSpliced',
  'toString',
  'with',
]);

export interface ArrayMethodOverride {
  readonly own: boolean;
  readonly value?: Expression | MethodDeclaration;
  /** A data property the descriptor wrote writable: a later write replaces it. */
  readonly writable?: true;
  /** A property the descriptor wrote configurable: a later definition or deletion replaces it. */
  readonly configurable?: true;
}

/** The own methods a write names, as far as it shows them. */
export type OwnMethods = Map<string, ArrayMethodOverride>;

/**
 * The expression a statement of the block evaluates for certain and may write the array's methods
 * with: an expression statement's, the initializer of the one declaration of a plain name, or the
 * right of an assignment to a plain name that is no write of a method, whose own write is the call
 * or the deletion it holds. What runs after the expression, a pattern's defaults and the setter of a
 * property assigned, is no part of it.
 */
export function definiteExpression(before: Node, root: FrameBinding): Expression | undefined {
  let expression: Expression | undefined;
  if (isExpressionStatement(before)) expression = before.expression;
  else if (isVariableStatement(before)) {
    const [only, ...rest] = before.declarationList.declarations;
    const plain = only !== undefined && rest.length === 0 && isIdentifier(only.name);
    expression = plain ? only.initializer : undefined;
  }
  const value = expression === undefined ? undefined : unwrapped(expression);
  const stored =
    value !== undefined &&
    isBinaryExpression(value) &&
    value.operatorToken.kind === SyntaxKind.EqualsToken &&
    isIdentifier(unwrapped(value.left)) &&
    ownMethodAssignment(value, root) === undefined;
  return stored ? value.right : expression;
}

/** The operators whose right side runs only on some left. */
const SHORT_CIRCUITS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * A descriptor written with `__proto__: object` takes fields from that object, which the compile
 * leaves unread: it may name an accessor, or any attribute.
 */
function setsPrototype(property: ObjectLiteralElementLike): boolean {
  return (
    isPropertyAssignment(property) &&
    !isComputedPropertyName(property.name) &&
    writtenArrayKey(property.name) === '__proto__'
  );
}

/** Whether an assignment gives a member a value, whose setter runs after the right side. */
function setsMember(node: BinaryExpression): boolean {
  const kind = node.operatorToken.kind;
  const assigns = kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
  return assigns && !isIdentifier(unwrapped(node.left));
}

/** Whether a node is a link of an optional chain, which runs what follows `?.` only on some value. */
function inOptionalChain(node: Node): boolean {
  // eslint-disable-next-line no-bitwise -- TypeScript marks the links of an optional chain with this flag.
  return (node.flags & NodeFlags.OptionalChain) !== 0;
}

/**
 * Whether an expression runs whenever its statement does: no condition, short-circuit, optional
 * chain, function or inner statement lies between them.
 */
export function evaluatedForSure(node: Node, statement: Node): boolean {
  for (let at = node; at !== statement; at = at.parent) {
    if (skipsLink(at, statement)) return false;
  }
  return true;
}

/** Whether what holds `at` runs it only on some paths: a branch, a short circuit, a chain, a setter. */
function skipsLink(at: Node, statement: Node): boolean {
  const { parent } = at;
  if (isConditionalExpression(parent)) return at !== parent.condition;
  if (isBinaryExpression(parent) && parent.right === at)
    return SHORT_CIRCUITS.has(parent.operatorToken.kind) || setsMember(parent);
  if (inOptionalChain(parent) || isFunctionLikeDeclaration(parent)) return true;
  const inner = parent.kind >= SyntaxKind.FirstStatement && parent.kind <= SyntaxKind.LastStatement;
  return inner && parent !== statement;
}

/** What an assignment makes a property: writable and configurable, as a descriptor would say. */
export const PLAIN_PROPERTY = { writable: true, configurable: true } as const;

/**
 * A method a write may have replaced: unproven, with the attributes it has both ways, as it was
 * and as the write leaves it, if it ran. A write of the value alone leaves it as it was.
 */
export function afterPossibleWrite(
  previous: ArrayMethodOverride | undefined,
  written: ArrayMethodOverride | undefined,
): ArrayMethodOverride {
  const writable = previous?.writable === true && written?.writable === true;
  const configurable = previous?.configurable === true && written?.configurable === true;
  return {
    own: false,
    ...(writable && { writable: true as const }),
    ...(configurable && { configurable: true as const }),
  };
}

/**
 * What a write that may be of another array leaves of a method: its value unproven, and an attribute
 * only where the method had it before and the write gives it, as it stands whether or not the write
 * was of this array. A method nothing wrote before has both, as a plain assignment makes them.
 */
export function possibleOverride(
  written: ArrayMethodOverride,
  before: ArrayMethodOverride | undefined,
): ArrayMethodOverride {
  const writable = written.writable === true && (before === undefined || before.writable === true);
  const configurable =
    written.configurable === true && (before === undefined || before.configurable === true);
  return {
    own: false,
    ...(writable && { writable: true as const }),
    ...(configurable && { configurable: true as const }),
  };
}

/** One direct assignment to the native method selected by a call; it creates a plain property. */
export function ownMethodAssignment(
  node: Node,
  root: FrameBinding,
): (ArrayMethodOverride & { readonly key: string }) | undefined {
  if (!isBinaryExpression(node) || node.operatorToken.kind !== SyntaxKind.EqualsToken)
    return undefined;
  const member = unwrapped(node.left);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const key = frameMemberName(member);
  if (key === undefined || !OWN_METHODS.has(key) || arrayIdentity(member.expression) !== root)
    return undefined;
  return {
    key,
    own: sourceArrayFunction(node.right) || knownNonNative(node.right),
    value: node.right,
    ...PLAIN_PROPERTY,
  };
}

/** A written non-callable join makes native toString fall back to the ordinary object tag. */
export function knownNonNative(expression: Expression): boolean {
  const value = unwrapped(expression);
  return (
    writtenArrayFunction(value) ||
    constantValue(value) !== undefined ||
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    globalPathOf(value)?.join('.') === 'undefined'
  );
}

/**
 * The declaration whose array value a name or a chain of lexical aliases denotes; none where a name
 * of the chain is written as a whole elsewhere, and may hold another array than it was given.
 */
export function arrayIdentity(value: Expression): FrameBinding | undefined {
  const followed = followedIdentity(value);
  return followed.written ? undefined : followed.root;
}

/**
 * Whether a write to a member of `value` may write the array `root`: a name of its chain that is
 * written as a whole elsewhere may hold any array, and so may its member be one of the array's.
 */
export function mayBeArray(value: Expression, root: FrameBinding): boolean {
  const followed = followedIdentity(value);
  return followed.written || followed.root === root;
}

interface FollowedIdentity {
  readonly root: FrameBinding | undefined;
  /** Whether a name of the chain is written as a whole. */
  readonly written: boolean;
}

/** The chain of lexical aliases a value follows to an array's declaration, and what it passes. */
function followedIdentity(value: Expression): FollowedIdentity {
  let each = unwrapped(value);
  const rest = arrayRestBinding(each);
  if (rest !== undefined) return { root: rest, written: false };
  const seen = new Set<FrameBinding>();
  let root: FrameBinding | undefined;
  let written = false;
  while (isIdentifier(each)) {
    const selected = frameBindingOf(each);
    if (selected === undefined || selected.keys.length > 0 || seen.has(selected.binding))
      return { root: undefined, written };
    root = selected.binding;
    written ||= writtenWhole(root.getSourceFile()).has(root);
    seen.add(root);
    if (root.initializer === undefined) return { root, written };
    each = unwrapped(root.initializer);
  }
  return { root: isArrayLiteralExpression(each) ? root : undefined, written };
}

const WRITTEN_WHOLE = new WeakMap<SourceFile, ReadonlySet<FrameBinding>>();

/**
 * The bindings a file writes as a whole — by an assignment, a destructuring target, a loop head or
 * a `var` that declares a name again — found in one walk of the file.
 */
function writtenWhole(file: SourceFile): ReadonlySet<FrameBinding> {
  const known = WRITTEN_WHOLE.get(file);
  if (known !== undefined) return known;
  const found = new Set<FrameBinding>();
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const target of framedWrittenTargets(node)) {
      const name = unwrapped(target);
      const selected = isIdentifier(name) ? frameBindingOf(name) : undefined;
      if (selected?.keys.length === 0) found.add(selected.binding);
    }
    if (isVariableDeclaration(node)) for (const binding of redeclared(node)) found.add(binding);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  WRITTEN_WHOLE.set(file, found);
  return found;
}

/**
 * The bindings a declaration writes as a whole where an earlier declaration binds the same name, as
 * a `var` may: one with a value, an initializer or a for-in or for-of head, assigns it (`var a;`
 * alone does not), and a block-scoped declaration only ever binds its own.
 */
function redeclared(declaration: VariableDeclaration): readonly FrameBinding[] {
  const { parent } = declaration;
  if (!isVariableDeclarationList(parent) || isBlockScoped(parent)) return [];
  const head = isForInStatement(parent.parent) || isForOfStatement(parent.parent);
  if (!head && declaration.initializer === undefined) return [];
  const bound: FrameBinding[] = [];
  for (const name of bindingIdentifiers(declaration.name)) {
    const selected = frameBindingOf(name);
    if (selected?.keys.length === 0 && selected.binding !== declaration)
      bound.push(selected.binding);
  }
  return bound;
}

/** Each source's last explicitly written field wins; an unknown source may restore native methods. */
export function assignMethods(source: Expression, own: OwnMethods): void {
  const value = unwrapped(source);
  if (!isObjectLiteralExpression(value)) {
    forgetMethods(own);
    return;
  }
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) {
      forgetMethods(own);
      continue;
    }
    const key = writtenArrayKey(property.name);
    if (key === undefined) forgetMethods(own);
    else if (OWN_METHODS.has(key)) {
      own.set(key, propertyOverride(property));
    }
  }
}

/** A written own method or callable value, with unknown entries kept unproven; a plain property. */
function propertyOverride(property: Node): ArrayMethodOverride {
  if (isMethodDeclaration(property)) return { own: true, value: property, ...PLAIN_PROPERTY };
  if (!isPropertyAssignment(property)) return { own: false };
  const { initializer } = property;
  return { own: knownNonNative(initializer), value: initializer, ...PLAIN_PROPERTY };
}

/** One statically named data descriptor, including restoration to the native implementation. */
export function defineMethod(call: CallExpression, own: OwnMethods): void {
  const keyNode = call.arguments[1];
  const key = keyNode === undefined ? undefined : constantValue(keyNode);
  if (typeof key !== 'string') {
    forgetMethods(own);
    return;
  }
  if (OWN_METHODS.has(key)) own.set(key, descriptorFunction(call.arguments[2], own.get(key)));
}

/** Object.defineProperties selects each descriptor by its written property name. */
export function descriptorMethods(descriptors: ObjectLiteralExpression, own: OwnMethods): void {
  for (const property of descriptors.properties) {
    if (isSpreadAssignment(property)) {
      forgetMethods(own);
      continue;
    }
    const key = writtenArrayKey(property.name);
    if (key === undefined) forgetMethods(own);
    else if (OWN_METHODS.has(key)) {
      own.set(
        key,
        isPropertyAssignment(property)
          ? descriptorFunction(property.initializer, own.get(key))
          : { own: false },
      );
    }
  }
}

const ACCESSOR_KEYS = new Set(['get', 'set']);

/**
 * A written value function proves a custom implementation; getters and unknown values do not. An
 * attribute the descriptor leaves unsaid stays as the property it redefines had it.
 */
function descriptorFunction(
  descriptor: Expression | undefined,
  previous?: ArrayMethodOverride,
): ArrayMethodOverride {
  if (descriptor === undefined) return { own: false };
  const value = unwrapped(descriptor);
  if (!isObjectLiteralExpression(value)) return { own: false };
  const writable = attributeKept(descriptorSays(value, 'writable'), previous?.writable);
  const configurable = attributeKept(descriptorSays(value, 'configurable'), previous?.configurable);
  return {
    ...descriptorValue(value),
    ...(writable && { writable: true as const }),
    ...(configurable && { configurable: true as const }),
  };
}

/** An attribute the descriptor says is true, or leaves unsaid where the property it redefines had it. */
function attributeKept(says: AttributeSaid, before: true | undefined): boolean {
  return says === 'true' || (says === 'omitted' && before === true);
}

/** The value a descriptor writes, unproven once an accessor, a spread or an unknown key may follow. */
function descriptorValue(value: ObjectLiteralExpression): ArrayMethodOverride {
  let custom: ArrayMethodOverride = { own: false };
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) custom = { own: false };
    else {
      const key = writtenArrayKey(property.name);
      if (key === undefined || ACCESSOR_KEYS.has(key) || setsPrototype(property))
        custom = { own: false };
      else if (key === 'value')
        custom = isPropertyAssignment(property)
          ? { own: knownNonNative(property.initializer), value: property.initializer }
          : { own: false };
    }
  }
  return custom;
}

type AttributeSaid = 'omitted' | 'other' | 'true';

/**
 * What a descriptor says of an attribute: a literal `true` as its last word, nothing at all, or
 * anything else — `false`, a value the compile cannot read, a spread, a key that is not written out.
 * A writable data property is not an accessor.
 */
function descriptorSays(
  descriptor: ObjectLiteralExpression,
  attribute: 'configurable' | 'writable',
): AttributeSaid {
  let says: AttributeSaid = 'omitted';
  for (const property of descriptor.properties) {
    if (isSpreadAssignment(property)) return 'other';
    const key = writtenArrayKey(property.name);
    if (key === undefined || setsPrototype(property)) return 'other';
    if (attribute === 'writable' && ACCESSOR_KEYS.has(key)) return 'other';
    if (key === attribute)
      says =
        isPropertyAssignment(property) &&
        unwrapped(property.initializer).kind === SyntaxKind.TrueKeyword
          ? 'true'
          : 'other';
  }
  return says;
}

/** An opaque write can replace either method and therefore removes a proof of a custom method. */
export function forgetMethods(own: OwnMethods): void {
  for (const method of OWN_METHODS) own.set(method, { own: false });
}
