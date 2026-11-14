import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { sourceArrayFunction } from './framed-array-functions.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedPossibleBranch } from './framed-writes.ts';
import { isTypeOnly } from './scope.ts';

/** New native iterator origins require quiet source creation and an unchanged first-step boundary. */

export const DEFAULT_ITERATOR = 'Symbol.iterator';
const ITERATOR = new Set([DEFAULT_ITERATOR]);
const NAMED = new Set(['entries', 'keys', 'values']);
/**
 * The nodes that run application code: a call, a read of a member that may be a getter, a spread,
 * a pattern that reads the getters or the iterator of what it takes apart, a template that coerces
 * what it holds, and a loop whose head iterates.
 */
const EFFECTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayBindingPattern,
  SyntaxKind.AwaitExpression,
  SyntaxKind.BinaryExpression,
  SyntaxKind.CallExpression,
  SyntaxKind.DeleteExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.JsxSpreadAttribute,
  SyntaxKind.NewExpression,
  SyntaxKind.ObjectBindingPattern,
  SyntaxKind.PostfixUnaryExpression,
  SyntaxKind.PrefixUnaryExpression,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.SpreadAssignment,
  SyntaxKind.SpreadElement,
  SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.TemplateExpression,
  SyntaxKind.YieldExpression,
]);

interface IteratorSource {
  readonly value: Expression;
  readonly bindings: ReadonlySet<FrameBinding>;
}

export interface IteratorBoundary {
  readonly source: IteratorSource;
  readonly acquisition: CallExpression;
  readonly next: CallExpression;
  readonly method: string;
}

/** The native default symbol retains its identity through whole const aliases and lexical shadows. */
export function iteratorMemberName(member: Expression): string | undefined {
  if (
    isElementAccessExpression(member) &&
    framedNativeConstructor(member.argumentExpression, ITERATOR)
  )
    return DEFAULT_ITERATOR;
  const name = frameMemberName(member);
  return name === DEFAULT_ITERATOR ? undefined : name;
}

/**
 * Every ignored invocation argument still executes before a native iterator answers its first value. A
 * collection built from a name iterates what the name holds as it is built: that is application code.
 */
export function iteratorBoundaryQuiet(boundary: IteratorBoundary): boolean {
  const { source, acquisition, next } = boundary;
  if (!iteratorQuietValues(acquisition.arguments) || !iteratorQuietValues(next.arguments))
    return false;
  if (!iteratorPrefixQuiet(acquisition, next)) return false;
  if (!iteratorPrefixQuiet(source.value, acquisition, boundary)) return false;
  if (isObjectLiteralExpression(unwrapped(source.value))) return false;
  const values = isNewExpression(source.value) ? (source.value.arguments ?? []) : [source.value];
  return (
    values.every((each) => !(isNewExpression(source.value) && isIdentifier(unwrapped(each)))) &&
    (!isNewExpression(source.value) || iterableWritten(source.value)) &&
    iteratorQuietValues(values)
  );
}

/** The constructors of a map, which read the first two slots of each entry they are built from. */
const MAPS: ReadonlySet<string> = new Set(['Map', 'WeakMap']);

/** The constructors of a collection, which iterate their first argument as they are built. */
const COLLECTIONS: ReadonlySet<string> = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);

/**
 * Whether a collection is built from an iterable written out. The constructor takes the iterator
 * its argument has, reads the next step of it, and, for a map, the first two slots of each entry:
 * an argument that is a name, a call or an object, which inherits an iterator through `__proto__`
 * or has none, may run application code; only a list, a text or none at all does not, and a map's
 * entries are lists in turn. Any other constructor does not iterate its argument.
 */
function iterableWritten(source: NewExpression): boolean {
  if (!framedNativeConstructor(source.expression, COLLECTIONS)) return true;
  const [first] = source.arguments ?? [];
  const list = first === undefined ? undefined : unwrapped(first);
  if (list === undefined || list.kind === SyntaxKind.NullKeyword) return true;
  const map = framedNativeConstructor(source.expression, MAPS);
  if (!isArrayLiteralExpression(list))
    return !map && (isStringLiteral(list) || isNoSubstitutionTemplateLiteral(list));
  return (
    !map ||
    list.elements.every(
      (each) => isOmittedExpression(each) || isArrayLiteralExpression(unwrapped(each)),
    )
  );
}

/** Literal data creation invokes neither application calls, getters nor unresolved spread iterators. */
export function iteratorQuietValues(values: readonly Expression[]): boolean {
  const pending = [...values];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapped(next);
    if (quietAtom(value)) continue;
    const children = quietChildren(value);
    if (children === undefined) return false;
    pending.push(...children);
  }
  return true;
}

/** Known native symbol reads and literal primitive operands cannot run application coercion. */
function quietAtom(value: Expression): boolean {
  return (
    isIdentifier(value) ||
    isNumericLiteral(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    (isPrefixUnaryExpression(value) &&
      isNumericLiteral(unwrapped(value.operand)) &&
      (value.operator === SyntaxKind.MinusToken || value.operator === SyntaxKind.PlusToken))
  );
}

/** Plain array slots and own data initializers preserve their original expression nodes. */
function quietChildren(value: Expression): readonly Expression[] | undefined {
  if (isArrayLiteralExpression(value)) return quietArrayValues(value);
  if (!isObjectLiteralExpression(value)) return undefined;
  const found: Expression[] = [];
  for (const field of value.properties) {
    if (isSpreadAssignment(field) || isComputedPropertyName(field.name)) return undefined;
    if (isPropertyAssignment(field)) found.push(field.initializer);
    else if (isShorthandPropertyAssignment(field) && isIdentifier(field.name))
      found.push(field.name);
  }
  return found;
}

/** A finite literal array contributes its written data slots without invoking a spread iterator. */
function quietArrayValues(value: ArrayLiteralExpression): readonly Expression[] | undefined {
  const found: Expression[] = [];
  for (const each of value.elements) {
    if (isSpreadElement(each)) return undefined;
    if (!isOmittedExpression(each)) found.push(each);
  }
  return found;
}

/** Runtime work between creation and acquisition or between acquisition and next keeps origins opaque. */
export function iteratorPrefixQuiet(
  from: Expression,
  to: Expression,
  boundary?: IteratorBoundary,
): boolean {
  if (from.end > to.pos) return true;
  const owner = executionOwner(to);
  const pending: Node[] = [to.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node) || unrelatedOwnMethod(node, boundary)) continue;
    if (
      node.pos >= from.end &&
      node.end <= to.pos &&
      executionOwner(node) === owner &&
      EFFECTS.has(node.kind) &&
      framedPossibleBranch(node) &&
      !quietNativeSymbol(node)
    )
      return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** A direct native symbol property read performs no application getter work. */
function quietNativeSymbol(node: Node): boolean {
  return (
    (isPropertyAccessExpression(node) || isElementAccessExpression(node)) &&
    framedNativeConstructor(node, ITERATOR)
  );
}

/** The default symbol ignores source-written own values, keys and entries implementations. */
function unrelatedOwnMethod(node: Node, boundary: IteratorBoundary | undefined): boolean {
  if (
    boundary?.method !== DEFAULT_ITERATOR ||
    !isBinaryExpression(node) ||
    node.operatorToken.kind !== SyntaxKind.EqualsToken ||
    !sourceArrayFunction(node.right)
  )
    return false;
  const member = unwrapped(node.left);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return false;
  const method = frameMemberName(member);
  const receiver = unwrapped(member.expression);
  if (method === undefined || !NAMED.has(method) || !isIdentifier(receiver)) return false;
  const selected = frameBindingOf(receiver);
  return selected?.keys.length === 0 && boundary.source.bindings.has(selected.binding);
}
