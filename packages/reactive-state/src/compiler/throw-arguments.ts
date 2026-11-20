import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isOmittedExpression,
  isSpreadElement,
  type NewExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import type { Resolve } from './numbers.ts';
import { writtenOf } from './throw-shapes.ts';
import { includesApplication, interveningEvaluation } from './written-evaluation.ts';

interface Reading {
  readonly at: Expression;
  readonly resolve: Resolve | undefined;
  readonly seen: ReadonlySet<Expression>;
  readonly preceding: boolean;
}

/** A call's statically known tuple spreads, expanded before its ordinary argument validators run. */
export function expandedInvocation<T extends CallExpression | NewExpression>(
  node: T,
  resolve: Resolve | undefined,
): T {
  const given = node.arguments;
  if (given?.some((each) => isSpreadElement(each)) !== true) {
    return node;
  }
  const expanded = expandedArguments(given, {
    at: node,
    resolve,
    seen: new Set(),
    preceding: false,
  });
  if (expanded === undefined) {
    return node;
  }
  const args = Object.assign(expanded, {
    end: given.end,
    pos: given.pos,
    transformFlags: given.transformFlags,
  });
  return new Proxy(node, {
    get: (target, key): unknown => (key === 'arguments' ? args : Reflect.get(target, key)),
  });
}

/** Written elements in argument order; none of an unknown iterator, hole, cycle or changed tuple. */
function expandedArguments(
  given: readonly Expression[],
  reading: Reading,
): Expression[] | undefined {
  const result: Expression[] = [];
  let preceding = reading.preceding;
  for (const each of given) {
    if (isOmittedExpression(each)) {
      return undefined;
    }
    const values = isSpreadElement(each)
      ? spreadValues(each.expression, { ...reading, preceding })
      : [each];
    if (values === undefined) {
      return undefined;
    }
    result.push(...values);
    preceding ||= includesApplication(each);
  }
  return result;
}

/** A fresh literal or an unchanged followed tuple, with nested literal spreads expanded. */
function spreadValues(node: Expression, reading: Reading): Expression[] | undefined {
  const value = writtenOf(node, reading.resolve);
  if (
    !isArrayLiteralExpression(value) ||
    reading.seen.has(value) ||
    interveningEvaluation(value, reading.at) ||
    (reading.preceding && value !== unwrapped(node))
  ) {
    return undefined;
  }
  return expandedArguments(value.elements, { ...reading, seen: new Set([...reading.seen, value]) });
}
