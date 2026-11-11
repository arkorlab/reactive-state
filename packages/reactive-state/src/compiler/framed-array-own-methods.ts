import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isElementAccessExpression,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
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

const ACCESSOR_KEYS = new Set(['get', 'set']);

/** The own methods a write names, as far as it shows them. */
export type OwnMethods = Map<string, ArrayMethodOverride>;

/** One direct assignment to the native method selected by a call. */
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
 * The bindings a file writes as a whole — by an assignment, a destructuring target or a loop head —
 * found in one walk of the file.
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
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  WRITTEN_WHOLE.set(file, found);
  return found;
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

/** A written own method or callable value, with unknown entries kept unproven. */
function propertyOverride(property: Node): ArrayMethodOverride {
  if (isMethodDeclaration(property)) return { own: true, value: property };
  if (!isPropertyAssignment(property)) return { own: false };
  return { own: knownNonNative(property.initializer), value: property.initializer };
}

/** One statically named data descriptor, including restoration to the native implementation. */
export function defineMethod(call: CallExpression, own: OwnMethods): void {
  const keyNode = call.arguments[1];
  const key = keyNode === undefined ? undefined : constantValue(keyNode);
  if (typeof key !== 'string') {
    forgetMethods(own);
    return;
  }
  if (OWN_METHODS.has(key)) own.set(key, descriptorFunction(call.arguments[2]));
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
        isPropertyAssignment(property) ? descriptorFunction(property.initializer) : { own: false },
      );
    }
  }
}

/** A written value function proves a custom implementation; getters and unknown values do not. */
function descriptorFunction(descriptor: Expression | undefined): ArrayMethodOverride {
  if (descriptor === undefined) return { own: false };
  const value = unwrapped(descriptor);
  if (!isObjectLiteralExpression(value)) return { own: false };
  const writable = descriptorSays(value, 'writable') ? { writable: true as const } : {};
  const configurable = descriptorSays(value, 'configurable') ? { configurable: true as const } : {};
  return { ...descriptorValue(value), ...writable, ...configurable };
}

/** The value a descriptor writes, unproven once an accessor, a spread or an unknown key may follow. */
function descriptorValue(value: ObjectLiteralExpression): ArrayMethodOverride {
  let custom: ArrayMethodOverride = { own: false };
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) custom = { own: false };
    else {
      const key = writtenArrayKey(property.name);
      if (key === undefined || ACCESSOR_KEYS.has(key)) custom = { own: false };
      else if (key === 'value')
        custom = isPropertyAssignment(property)
          ? { own: knownNonNative(property.initializer), value: property.initializer }
          : { own: false };
    }
  }
  return custom;
}

/**
 * A descriptor whose last word on an attribute is a literal `true`, with no spread and no key that
 * is not written out; a writable data property is not an accessor.
 */
function descriptorSays(
  descriptor: ObjectLiteralExpression,
  attribute: 'configurable' | 'writable',
): boolean {
  let says = false;
  for (const property of descriptor.properties) {
    if (isSpreadAssignment(property)) return false;
    const key = writtenArrayKey(property.name);
    if (key === undefined || (attribute === 'writable' && ACCESSOR_KEYS.has(key))) return false;
    if (key === attribute)
      says =
        isPropertyAssignment(property) &&
        unwrapped(property.initializer).kind === SyntaxKind.TrueKeyword;
  }
  return says;
}

/** An opaque write can replace either method and therefore removes a proof of a custom method. */
export function forgetMethods(own: OwnMethods): void {
  for (const method of OWN_METHODS) own.set(method, { own: false });
}
