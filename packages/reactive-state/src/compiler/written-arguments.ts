import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type ObjectLiteralElementLike,
  type SpreadAssignment,
  SyntaxKind,
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { initializerOf } from './framed.ts';
import { constantValue } from './numbers.ts';
import { patternSymbolName } from './pattern-writes.ts';
import { constFollowedValue, unmutatedTuple } from './tuple-spreads.ts';

/**
 * Call arguments mutated beside a method's receiver: `structuredClone` transfer lists, explicit
 * 4th-argument receivers of `Reflect.set`, and direct, borrowed or bound global invocations.
 */

export interface CallArgument {
  readonly expression: Expression;
  readonly spread: boolean;
}

interface GlobalCall {
  readonly given: readonly CallArgument[];
  readonly path: string;
}

interface ReflectSpreadContext {
  readonly index: number;
  readonly seen: Set<ArrayLiteralExpression>;
  readonly stack: CallArgument[];
  readonly targets: Node[];
}

const SLOTS = { reflectSetReceiver: 3 } as const;
const PRIMITIVE_GLOBALS: ReadonlySet<string> = new Set(['Infinity', 'NaN', 'undefined']);

/** Wraps ordinary and spread call-site argument nodes into uniform `CallArgument` descriptors. */
export function asCallArguments(list: readonly Expression[]): readonly CallArgument[] {
  return list.map((each) => {
    if (isSpreadElement(each)) {
      return { expression: each.expression, spread: true };
    }
    return { expression: each, spread: false };
  });
}

/** A direct, aliased, borrowed or bound invocation of a global function and its arguments. */
export function globalCallOf(call: CallExpression): GlobalCall | undefined {
  const callee = followedValue(call.expression);
  const direct = globalPathOf(callee)?.join('.');
  if (direct === 'Reflect.apply') {
    const [first, , third] = call.arguments;
    const target = first === undefined ? undefined : globalPathOf(followedValue(first))?.join('.');
    return target === undefined ? undefined : { given: appliedArguments(third), path: target };
  }
  const member =
    isPropertyAccessExpression(callee) || isElementAccessExpression(callee)
      ? memberNameOf(callee)
      : undefined;
  if (
    (member === 'call' || member === 'apply') &&
    (isPropertyAccessExpression(callee) || isElementAccessExpression(callee))
  ) {
    const target = globalPathOf(followedValue(callee.expression))?.join('.');
    if (target !== undefined) {
      const given =
        member === 'apply'
          ? appliedArguments(call.arguments[1])
          : asCallArguments(call.arguments.slice(1));
      return { given, path: target };
    }
  }
  return direct === undefined
    ? boundGlobalCall(callee, asCallArguments(call.arguments))
    : { given: asCallArguments(call.arguments), path: direct };
}

/** Selects the argument at `slot` after expanding known tuple spreads, or an covering spread holder. */
export function argumentAt(given: readonly CallArgument[], slot: number): Expression | undefined {
  const stack = given.toReversed();
  const seen = new Set<ArrayLiteralExpression>();
  let index = 0;
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (current.spread) {
      if (!expandTupleSpread(current.expression, seen, stack)) {
        return index <= slot ? current.expression : undefined;
      }
      continue;
    }
    if (index === slot) {
      return current.expression.kind === SyntaxKind.OmittedExpression
        ? undefined
        : current.expression;
    }
    index += 1;
  }
  return undefined;
}

/** Explicit 4th-argument receivers of `Reflect.set`, through known tuple spreads or opaque spreads. */
export function reflectSetReceivers(given: readonly CallArgument[]): readonly Node[] {
  const targets: Node[] = [];
  const stack = given.toReversed();
  const seen = new Set<ArrayLiteralExpression>();
  let index = 0;
  let shifted = false;
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (current.spread) {
      shifted = pushReflectSpread(current.expression, { index, seen, stack, targets }) || shifted;
      continue;
    }
    if (receivesReflectSet(current.expression, index, shifted)) {
      targets.push(current.expression);
    }
    index += 1;
  }
  return targets;
}

/** The transfer list structuredClone detaches, where the code writes its options and their aliases. */
export function transferredBy(options: Expression | undefined): readonly Node[] {
  const value = options === undefined ? undefined : followedValue(options);
  if (value === undefined || !isObjectLiteralExpression(value)) {
    return [];
  }
  const pending = [...value.properties];
  const seen = new Set<Expression>([value]);
  for (let property = pending.pop(); property !== undefined; property = pending.pop()) {
    if (isSpreadAssignment(property)) {
      const targets = spreadTransfers(property.expression, pending, seen);
      if (targets !== undefined) {
        return targets;
      }
      continue;
    }
    const targets = propertyTransfers(property, value);
    if (targets !== undefined) {
      return targets;
    }
  }
  return [];
}

/** Pushes an unchanged array-literal spread's elements onto `stack` when statically known. */
function expandTupleSpread(
  expression: Expression,
  seen: Set<ArrayLiteralExpression>,
  stack: CallArgument[],
): boolean {
  const tuple = unmutatedTuple(expression);
  if (tuple === undefined || seen.has(tuple)) {
    return false;
  }
  seen.add(tuple);
  stack.push(...asCallArguments(tuple.elements).toReversed());
  return true;
}

/** Expands a known array-literal spread onto `stack`, or records an opaque spread target. */
function pushReflectSpread(expression: Expression, context: ReflectSpreadContext): boolean {
  if (expandTupleSpread(expression, context.seen, context.stack)) {
    return false;
  }
  if (context.index <= SLOTS.reflectSetReceiver) {
    context.targets.push(expression);
  }
  return true;
}

/** Whether a positional `Reflect.set` argument can act as its object receiver. */
function receivesReflectSet(argument: Expression, index: number, shifted: boolean): boolean {
  const inSlot =
    index === SLOTS.reflectSetReceiver || (shifted && index < SLOTS.reflectSetReceiver);
  return (
    inSlot &&
    argument.kind !== SyntaxKind.OmittedExpression &&
    !PRIMITIVE_GLOBALS.has(globalPathOf(unwrapped(argument))?.join('.') ?? '')
  );
}

/** A global function bound through `.bind(...)` chains and later called with trailing arguments. */
function boundGlobalCall(
  callee: Expression,
  trailing: readonly CallArgument[],
): GlobalCall | undefined {
  const segments: (readonly CallArgument[])[] = [trailing];
  const seen = new Set<Expression>();
  let current = callee;
  while (isCallExpression(current) && !seen.has(current)) {
    seen.add(current);
    const binder = unwrapped(current.expression);
    if (
      (!isPropertyAccessExpression(binder) && !isElementAccessExpression(binder)) ||
      memberNameOf(binder) !== 'bind'
    ) {
      return undefined;
    }
    segments.push(asCallArguments(current.arguments.slice(1)));
    current = followedValue(binder.expression);
  }
  const target = globalPathOf(current)?.join('.');
  return target === undefined || segments.length === 1
    ? undefined
    : { given: segments.toReversed().flat(), path: target };
}

/** The arguments written for `apply`, or an unknown-list spread where the code does not write them apart. */
export function appliedArguments(node: Expression | undefined): readonly CallArgument[] {
  if (node === undefined) {
    return [];
  }
  const value = constFollowedValue(node);
  if (value.kind === SyntaxKind.NullKeyword || globalPathOf(value)?.join('.') === 'undefined') {
    return [];
  }
  const tuple = unmutatedTuple(node);
  return tuple === undefined
    ? [{ expression: unwrapped(node), spread: true }]
    : asCallArguments(tuple.elements);
}

/** The name `node` reads of what it reads it of, by its name or by text in brackets; none of another. */
export function memberNameOf(node: Expression | undefined): string | undefined {
  const value = node === undefined ? undefined : unwrapped(node);
  if (value !== undefined && isPropertyAccessExpression(value)) {
    return value.name.text;
  }
  return value !== undefined && isElementAccessExpression(value)
    ? (literalName(value) ?? patternSymbolName(value.argumentExpression))
    : undefined;
}

/** The transfer targets one options property writes, or none where it names another option. */
function propertyTransfers(
  property: Exclude<ObjectLiteralElementLike, SpreadAssignment>,
  options: Expression,
): readonly Node[] | undefined {
  const { name } = property;
  const key = isComputedPropertyName(name)
    ? constantValue(name.expression, initializerOf)
    : name.text;
  if (key === undefined) {
    return transferTargets(options);
  }
  if (key !== 'transfer') {
    return undefined;
  }
  if (isPropertyAssignment(property)) {
    return transferTargets(property.initializer);
  }
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? transferTargets(property.name)
    : [];
}

/** Adds a known options spread's properties, or reads an unknown spread as what may be transferred. */
function spreadTransfers(
  expression: Expression,
  pending: ObjectLiteralElementLike[],
  seen: Set<Expression>,
): readonly Node[] | undefined {
  const spread = followedValue(expression);
  if (!isObjectLiteralExpression(spread)) {
    return transferTargets(expression);
  }
  if (seen.has(spread)) {
    return [];
  }
  seen.add(spread);
  pending.push(...spread.properties);
  return undefined;
}

/** The buffers a transfer list holds, through list and entry aliases, without following their constructions. */
function transferTargets(list: Expression): readonly Node[] {
  const pending = [list];
  const seen = new Set<Expression>();
  const targets: Node[] = [];
  while (pending.length > 0) {
    const expression = pending.pop();
    if (expression === undefined) {
      break;
    }
    const value = unwrapped(expression);
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    if (isArrayLiteralExpression(value)) {
      pending.push(...value.elements);
      continue;
    }
    if (isSpreadElement(value)) {
      pending.push(value.expression);
      continue;
    }
    const declared = transferAlias(value);
    if (declared === undefined) {
      targets.push(value);
    } else {
      pending.push(declared);
    }
  }
  return targets;
}

/** The alias or container a transfer entry is declared of; none of the construction that makes it. */
function transferAlias(value: Expression): Expression | undefined {
  const initial = isIdentifier(value) ? initializerOf(value) : undefined;
  const declared = initial === undefined ? undefined : unwrapped(initial);
  return declared !== undefined &&
    (isIdentifier(declared) ||
      isArrayLiteralExpression(declared) ||
      isObjectLiteralExpression(declared))
    ? declared
    : undefined;
}

/** What a name is declared of, through other names; itself where it shows none. */
export function followedValue(node: Expression): Expression {
  let value = unwrapped(node);
  const seen = new Set<Expression>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = initializerOf(value);
    if (declared === undefined) {
      break;
    }
    value = unwrapped(declared);
  }
  return value;
}
