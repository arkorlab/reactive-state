import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isElementAccessExpression,
  isExpression,
  isFunctionExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadElement,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { memberPath } from './exported-values.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import { targetsOf } from './kept.ts';
import { canonicalArrayIndex } from './middleware-array-selector-guards.ts';
import { isTypeOnly, readsBinding } from './scope.ts';
import { writtenBy } from './written.ts';

/** Native array callbacks receive original item and array identities, but scalar indexes are copies. */
const ARRAY_CALLBACKS = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
  'toSorted',
]);
const REDUCED_ARRAY = 3;

interface Handoff {
  readonly receiver: Expression;
  readonly callback: Expression | undefined;
  readonly unknown: boolean;
  readonly slots: readonly number[];
  readonly arraySlot: number;
  readonly primitiveItems: boolean;
}

interface CallbackReceiverTrace {
  readonly aliases: ReadonlySet<FrameBinding>;
  readonly directAliases: ReadonlySet<FrameBinding>;
  readonly chainNodes: ReadonlySet<Expression>;
}

/** Only the first callback of a known native member adds implicit parameter inputs. */
export function middlewareCallbackHandoff(
  call: CallExpression,
  selected: (value: Expression) => Expression | undefined,
): Handoff | undefined {
  const method = unwrapped(call.expression);
  if (!isPropertyAccessExpression(method) && !isElementAccessExpression(method)) return undefined;
  const name = frameMemberName(method);
  if (name === undefined || !ARRAY_CALLBACKS.has(name)) return undefined;
  const initialReceiver = selected(method.expression);
  if (initialReceiver !== undefined && !isArrayLiteralExpression(initialReceiver)) return undefined;
  const receiverChanged =
    initialReceiver !== undefined && receiverMayChangeBeforeCall(call, method.expression);
  const receiver = receiverChanged ? undefined : initialReceiver;
  const given = framedArgumentPrefix(call, call.arguments, 2);
  const argumentUnknown = given.unknown || given.alternatives !== undefined;
  const reduced = name === 'reduce' || name === 'reduceRight';
  const maybeInitial = argumentUnknown || given.values.length >= 2;
  if (receiver !== undefined && noCallback(receiver, name, maybeInitial)) return undefined;
  const definiteInitial = hasDefiniteInitial(argumentUnknown, given.values.length);
  return {
    receiver: method.expression,
    callback: given.values[0],
    unknown: argumentUnknown || receiverChanged,
    slots: callbackSlots(name, reduced, definiteInitial),
    arraySlot: reduced ? REDUCED_ARRAY : 2,
    primitiveItems: primitiveElements(receiver),
  };
}

/** Only a resolved second argument guarantees an initial value that displaces receiver slot zero. */
function hasDefiniteInitial(unknown: boolean, count: number): boolean {
  return !unknown && count >= 2;
}

/** Omitted holes and quiet scalar literals carry no mutable element identity into callback slots. */
function primitiveElements(receiver: ArrayLiteralExpression | undefined): boolean {
  return (
    receiver?.elements.every(
      (element) => isOmittedExpression(element) || framedQuietPrimitive(element),
    ) ?? false
  );
}

/** Reduction supplies accumulator and item separately; an explicit initial value is not a receiver item. */
function callbackSlots(
  name: string,
  reduced: boolean,
  definiteInitial: boolean,
): readonly number[] {
  if (name === 'toSorted') return [0, 1];
  if (reduced) return [1, REDUCED_ARRAY, ...(definiteInitial ? [] : [0])];
  return [0, 2];
}

/** A literal with no visited positions, or too few comparator/reducer inputs, never invokes its callback. */
function noCallback(receiver: ArrayLiteralExpression, method: string, initial: boolean): boolean {
  if (receiver.elements.length === 0) return true;
  if (receiver.elements.some((element) => isSpreadElement(element))) return false;
  if (method.startsWith('find')) return false;
  const elements = receiver.elements.filter((element) => !isOmittedExpression(element));
  if (method === 'toSorted')
    return (
      elements.filter((element) => {
        return (
          unwrapped(element).kind !== SyntaxKind.VoidExpression &&
          globalPathOf(unwrapped(element))?.join('.') !== 'undefined'
        );
      }).length < 2
    );
  if (!initial && (method === 'reduce' || method === 'reduceRight')) return elements.length < 2;
  return elements.length === 0;
}

/** Detects receiver writes or exposures before iteration starts, including evaluated call arguments. */
function receiverMayChangeBeforeCall(call: CallExpression, receiver: Expression): boolean {
  const trace = traceCallbackReceiver(receiver);
  if (trace === undefined) return true;
  if (trace.aliases.size === 0) return false;
  const harmless = (name: Identifier): boolean => {
    return (
      trace.chainNodes.has(unwrapped(name)) ||
      insideDirectCallbackArgument(name, call) ||
      harmlessReceiverRead(name, trace.directAliases)
    );
  };
  if (argumentArrayExposed(memberPath(receiver).root, trace.aliases, harmless, true)) return true;
  return callEvaluatesAliasChange(call, trace.aliases, harmless);
}

/** Follows lexical initializers and static literal containers to the receiver's literal array. */
function traceCallbackReceiver(receiver: Expression): CallbackReceiverTrace | undefined {
  let value = unwrapped(receiver);
  const keys: string[] = [];
  const seen = new Set<Expression>();
  const aliases = new Set<FrameBinding>();
  const directAliases = new Set<FrameBinding>();
  const chainNodes = new Set<Expression>();
  for (;;) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    markMemberChain(value, chainNodes);
    const path = memberPath(value);
    keys.unshift(...path.keys);
    const next = isIdentifier(path.root)
      ? stepReceiverBinding(path.root, keys.length === 0, aliases, directAliases)
      : stepReceiverMember(path.root, keys);
    if (next === undefined)
      return !isIdentifier(path.root) && keys.length === 0 && isArrayLiteralExpression(path.root)
        ? { aliases, directAliases, chainNodes }
        : undefined;
    value = unwrapped(next);
  }
}

/** Follows one lexical variable binding along the receiver expression's initializer chain. */
function stepReceiverBinding(
  name: Identifier,
  direct: boolean,
  aliases: Set<FrameBinding>,
  directAliases: Set<FrameBinding>,
): Expression | undefined {
  const selected = frameBindingOf(name);
  const initializer = selected?.binding.initializer;
  if (selected === undefined || initializer === undefined || selected.keys.length > 0)
    return undefined;
  aliases.add(selected.binding);
  if (direct) directAliases.add(selected.binding);
  return initializer;
}

/** Steps one pending member lookup on an intermediate literal container. */
function stepReceiverMember(value: Expression, keys: string[]): Expression | undefined {
  const key = keys.shift();
  if (key === undefined) return undefined;
  if (isObjectLiteralExpression(value)) return plainObjectMember(value, key);
  if (!isArrayLiteralExpression(value) || value.elements.some((each) => isSpreadElement(each)))
    return undefined;
  const index = canonicalArrayIndex(key);
  const element = index === undefined ? undefined : value.elements[index];
  return element === undefined || isOmittedExpression(element) ? undefined : element;
}

/** Extracts surviving identifier-named data properties from a literal container. */
function plainObjectMember(value: ObjectLiteralExpression, name: string): Expression | undefined {
  for (const field of value.properties.toReversed()) {
    if (
      (!isPropertyAssignment(field) && !isShorthandPropertyAssignment(field)) ||
      !isIdentifier(field.name)
    )
      return undefined;
    if (field.name.text === name)
      return isPropertyAssignment(field) ? field.initializer : field.name;
  }
  return undefined;
}

/** Records each unwrapped property/element access node in `receiver`'s own lookup syntax. */
function markMemberChain(expression: Expression, nodes: Set<Expression>): void {
  let current = unwrapped(expression);
  for (;;) {
    nodes.add(current);
    if (!isPropertyAccessExpression(current) && !isElementAccessExpression(current)) return;
    current = unwrapped(current.expression);
  }
}

/** Closure bodies passed directly as arguments do not execute before native iteration starts. */
function insideDirectCallbackArgument(reference: Identifier, call: CallExpression): boolean {
  for (let node: Node = reference; node !== call; node = node.parent) {
    if (isSourceFile(node)) return false;
    if (
      (isArrowFunction(node) || isFunctionExpression(node)) &&
      call.arguments.some((argument) => unwrapped(argument) === node)
    )
      return true;
  }
  return false;
}

/** Non-call quiet property/element reads cannot mutate or leak the array receiver. */
function harmlessReceiverRead(
  reference: Identifier,
  directAliases: ReadonlySet<FrameBinding>,
): boolean {
  const selected = frameBindingOf(reference);
  if (selected === undefined || !directAliases.has(selected.binding)) return false;
  const parent = useOf(reference).parent;
  if (
    (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
    unwrapped(parent.expression) !== unwrapped(reference)
  )
    return false;
  if (isElementAccessExpression(parent) && !framedQuietPrimitive(parent.argumentExpression))
    return false;
  if (frameMemberName(parent) === undefined) return false;
  const grand = useOf(parent).parent;
  if (isCallExpression(grand) && unwrapped(grand.expression) === unwrapped(parent)) return false;
  const write = writtenBy(grand);
  return (
    write === undefined ||
    targetsOf(write).every(
      (target) => !isExpression(target) || unwrapped(target) !== unwrapped(parent),
    )
  );
}

/** Checks whether evaluating `call` touches any receiver alias in a potentially mutating way. */
function callEvaluatesAliasChange(
  call: CallExpression,
  aliases: ReadonlySet<FrameBinding>,
  harmless: (name: Identifier) => boolean,
): boolean {
  const pending: Node[] = [call];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && referencesAlias(node, aliases) && !harmless(node)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Determines whether an identifier reads a tracked binding rather than declaring it. */
function referencesAlias(name: Identifier, aliases: ReadonlySet<FrameBinding>): boolean {
  if (!readsBinding(name)) return false;
  const selected = frameBindingOf(name);
  return selected !== undefined && name !== selected.binding.name && aliases.has(selected.binding);
}
