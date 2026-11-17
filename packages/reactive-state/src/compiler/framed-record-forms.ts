import {
  type Expression,
  isArrowFunction,
  isCallExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isNewExpression,
  isPropertyAccessExpression,
  isSpreadElement,
} from 'typescript/ast';

import { answeringOf, returnedBy } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** A native call that makes a record or a list of entries of what it is given, and is not followed. */

/** What a native form makes its answer of: the operands, and whether later ones replace earlier. */
export interface RecordForm {
  readonly operands: readonly Expression[];
  readonly ordered: boolean;
}

/** Calls that copy each argument into one record, the later over the earlier, as a spread does. */
const ASSIGN: ReadonlySet<string> = new Set(['Object.assign']);

/** Calls and constructions whose first argument is the record or the entries they answer. */
const FIRST: ReadonlySet<string> = new Set([
  'Array.from',
  'Map',
  'Object.entries',
  'Object.fromEntries',
  'Set',
]);

/** Methods answering a copy of the list they are called on, the first two adding what they are given. */
const COPYING: ReadonlySet<string> = new Set([
  'concat',
  'filter',
  'flat',
  'reverse',
  'slice',
  'sort',
  'toReversed',
  'toSorted',
]);

/** Methods whose callback answers what the entries are made of. */
const MAPPING: ReadonlySet<string> = new Set(['flatMap', 'map']);

/**
 * What a record or a list of entries made by a native call is made of: `Object.assign({}, a, b)` of
 * the records it is given, in order, as `{ ...a, ...b }` is; `Object.fromEntries(rows)`,
 * `Object.entries(record)`, `new Map(rows)`, `new Set(rows)` and `Array.from(rows)` of their first
 * argument; the methods that copy a list (`rows.filter(…)`, `rows.concat(more)`) of the list and
 * what is added to it, and `rows.map(…)` of the list and what its callback answers. A call of any
 * other function is not one of these forms: what it answers is not followed.
 */
export function framedRecordForm(node: Expression): RecordForm | undefined {
  const value = unwrapped(node);
  if (isNewExpression(value)) {
    return framedNativeConstructor(value.expression, FIRST)
      ? { operands: given(value.arguments?.slice(0, 1) ?? []), ordered: false }
      : undefined;
  }
  if (!isCallExpression(value)) return undefined;
  const callee = unwrapped(value.expression);
  if (framedNativeConstructor(callee, ASSIGN))
    return { operands: given(value.arguments), ordered: true };
  if (framedNativeConstructor(callee, FIRST))
    return {
      operands: [...given(value.arguments.slice(0, 1)), ...answered(value.arguments[1])],
      ordered: false,
    };
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return undefined;
  const method = frameMemberName(callee);
  if (method === undefined) return undefined;
  const receiver = unwrapped(callee.expression);
  if (COPYING.has(method))
    return { operands: [receiver, ...given(value.arguments)], ordered: false };
  if (MAPPING.has(method))
    return { operands: [receiver, ...answered(value.arguments[0])], ordered: false };
  return undefined;
}

/** The arguments that are values: a spread's own source, and no function. */
function given(args: readonly Expression[]): readonly Expression[] {
  return args.flatMap((each) => {
    const value = unwrapped(isSpreadElement(each) ? each.expression : each);
    return isArrowFunction(value) || isFunctionExpression(value) ? [] : [value];
  });
}

/** What a written callback answers: its body's value, or each `return`'s. */
function answered(callback: Expression | undefined): readonly Expression[] {
  const fn = callback === undefined ? undefined : answeringOf(unwrapped(callback));
  return fn === undefined ? [] : returnedBy(fn).map((each) => unwrapped(each));
}
