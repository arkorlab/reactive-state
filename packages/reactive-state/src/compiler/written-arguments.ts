import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isSpreadElement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { initializerOf } from './framed.ts';
import { patternSymbolName } from './pattern-writes.ts';
import { constFollowedValue, unmutatedTuple } from './tuple-spreads.ts';

/**
 * Call arguments mutated beside a method's receiver: explicit 4th-argument receivers of
 * `Reflect.set`, slot-aligned spread expansion, and direct, borrowed or bound global invocations.
 */

export interface CallArgument {
  readonly expression: Expression;
  readonly spread: boolean;
}

export interface SlotArgument {
  readonly expression: Expression;
  readonly index: number;
  readonly spread: boolean;
}

interface GlobalCall {
  readonly given: readonly CallArgument[];
  readonly path: string;
}

const SLOTS = { reflectSetReceiver: 3 } as const;
const PRIMITIVE_GLOBALS: ReadonlySet<string> = new Set(['Infinity', 'NaN', 'undefined']);

/** Wraps ordinary and spread call-site argument nodes into uniform `CallArgument` descriptors. */
export function asCallArguments(list: readonly Expression[]): readonly CallArgument[] {
  return list.map((each) =>
    isSpreadElement(each)
      ? { expression: each.expression, spread: true }
      : { expression: each, spread: false },
  );
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

/** Selects the argument at `slot` after expanding known tuple spreads, or a covering spread holder. */
export function argumentAt(given: readonly CallArgument[], slot: number): Expression | undefined {
  return slotArguments(given, slot)[0]?.expression;
}

/** Positional and unexpanded-spread arguments that can supply `slot`. */
export function slotArguments(
  given: readonly CallArgument[],
  slot: number,
): readonly SlotArgument[] {
  const candidates: SlotArgument[] = [];
  const stack = given.toReversed();
  const seen = new Set<ArrayLiteralExpression>();
  let index = 0;
  let shifted = false;
  for (let current = stack.pop(); current !== undefined && index <= slot; current = stack.pop()) {
    if (current.spread) {
      if (!expandTupleSpread(current.expression, seen, stack)) {
        candidates.push({ expression: current.expression, index, spread: true });
        shifted = true;
      }
      continue;
    }
    if ((shifted || index === slot) && current.expression.kind !== SyntaxKind.OmittedExpression) {
      candidates.push({ expression: current.expression, index, spread: false });
    }
    index += 1;
  }
  return candidates;
}

/** Explicit 4th-argument receivers of `Reflect.set`, through known tuple spreads or opaque spreads. */
export function reflectSetReceivers(given: readonly CallArgument[]): readonly Node[] {
  return slotArguments(given, SLOTS.reflectSetReceiver)
    .filter(
      (each) =>
        each.spread ||
        !PRIMITIVE_GLOBALS.has(globalPathOf(unwrapped(each.expression))?.join('.') ?? ''),
    )
    .map((each) => each.expression);
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
