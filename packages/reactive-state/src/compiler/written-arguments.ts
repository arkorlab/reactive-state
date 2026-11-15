import {
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
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { initializerOf } from './framed.ts';
import { constantValue } from './numbers.ts';
import { patternSymbolName } from './pattern-writes.ts';

/**
 * Call arguments mutated beside a method's receiver: `structuredClone` transfer lists, explicit
 * 4th-argument receivers of `Reflect.set`, and direct, borrowed or bound global invocations.
 */

interface GlobalCall {
  readonly path: string;
  readonly given: readonly Expression[];
}

interface ReflectSpreadContext {
  readonly index: number;
  readonly seen: Set<Expression>;
  readonly stack: Expression[];
  readonly targets: Node[];
}

const REFLECT_SET_RECEIVER = 3;
const PRIMITIVE_GLOBALS: ReadonlySet<string> = new Set(['Infinity', 'NaN', 'undefined']);

/** A direct, aliased, borrowed or bound invocation of a global function and its arguments. */
export function globalCallOf(call: CallExpression): GlobalCall | undefined {
  const callee = followedValue(call.expression);
  const direct = globalPathOf(callee)?.join('.');
  if (direct === 'Reflect.apply') {
    const [first, , third] = call.arguments;
    const target = first === undefined ? undefined : globalPathOf(followedValue(first))?.join('.');
    return target === undefined ? undefined : { path: target, given: appliedArguments(third) };
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
        member === 'apply' ? appliedArguments(call.arguments[1]) : call.arguments.slice(1);
      return { path: target, given };
    }
  }
  return direct === undefined
    ? boundGlobalCall(callee, call.arguments)
    : { path: direct, given: call.arguments };
}

/** Explicit 4th-argument receivers of `Reflect.set`, through known tuple spreads or opaque spreads. */
export function reflectSetReceivers(given: readonly Expression[]): readonly Node[] {
  const targets: Node[] = [];
  const stack = given.toReversed();
  const seen = new Set<Expression>();
  let index = 0;
  let shifted = false;
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (isSpreadElement(current)) {
      shifted = pushReflectSpread(current.expression, { index, seen, stack, targets }) || shifted;
      continue;
    }
    if (receivesReflectSet(current, index, shifted)) {
      targets.push(current);
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

/** Expands a known array-literal spread onto `stack`, or records an opaque spread target. */
function pushReflectSpread(expression: Expression, context: ReflectSpreadContext): boolean {
  const value = followedValue(expression);
  if (isArrayLiteralExpression(value) && !context.seen.has(value)) {
    context.seen.add(value);
    context.stack.push(...value.elements.toReversed());
    return false;
  }
  if (context.index <= REFLECT_SET_RECEIVER) {
    context.targets.push(expression);
  }
  return true;
}

/** Whether a positional `Reflect.set` argument can act as its object receiver. */
function receivesReflectSet(argument: Expression, index: number, shifted: boolean): boolean {
  const inSlot = index === REFLECT_SET_RECEIVER || (shifted && index < REFLECT_SET_RECEIVER);
  return inSlot && !PRIMITIVE_GLOBALS.has(globalPathOf(unwrapped(argument))?.join('.') ?? '');
}

/** A global function bound through `.bind(...)` and later called with trailing arguments. */
function boundGlobalCall(
  callee: Expression,
  trailing: readonly Expression[],
): GlobalCall | undefined {
  if (!isCallExpression(callee)) {
    return undefined;
  }
  const binder = unwrapped(callee.expression);
  if (
    (!isPropertyAccessExpression(binder) && !isElementAccessExpression(binder)) ||
    memberNameOf(binder) !== 'bind'
  ) {
    return undefined;
  }
  const target = globalPathOf(followedValue(binder.expression))?.join('.');
  return target === undefined
    ? undefined
    : { path: target, given: [...callee.arguments.slice(1), ...trailing] };
}

/** The arguments written for `apply`, or their holder where the code does not write them apart. */
export function appliedArguments(node: Expression | undefined): readonly Expression[] {
  if (node === undefined) {
    return [];
  }
  const value = followedValue(node);
  return isArrayLiteralExpression(value) ? value.elements : [value];
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
function followedValue(node: Expression): Expression {
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
