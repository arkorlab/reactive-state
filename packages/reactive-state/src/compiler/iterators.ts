import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  isTypeAssertion,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';

/**
 * What of the code makes an iterator, as the language does (`retained.ts`, `kept.ts`): a method
 * that answers one, `Iterator.from` and its kin, a generator called, a helper of one called on it.
 */

/** The methods of a value that answer an iterator of it, which no JSON holds. */
export const ITERATING: ReadonlySet<string> = new Set([
  'entries',
  'keys',
  'matchAll',
  'Symbol.asyncIterator',
  'Symbol.iterator',
  'Symbol.matchAll',
  'values',
]);

/** The methods of an iterator that answer another of what it is of — of an array, its own. */
const ITERATOR_HELPERS: ReadonlySet<string> = new Set(['drop', 'filter', 'flatMap', 'map', 'take']);

/** The functions of `Iterator` that make one: of what they are given, of several in turn, at once. */
const ITERATOR_MAKERS: ReadonlySet<string> = new Set([
  'Iterator.concat',
  'Iterator.from',
  'Iterator.zip',
  'Iterator.zipKeyed',
]);

/** The methods of a function that call it on what they are given first. */
const BORROWING: ReadonlySet<string> = new Set(['apply', 'call']);

/** `node` past what `unwrapped` strips and the casts in angle brackets it leaves, `<any>items.values`. */
function uncast(node: Expression): Expression {
  let each = unwrapped(node);
  while (isTypeAssertion(each)) {
    each = unwrapped(each.expression);
  }
  return each;
}

/**
 * Whether `node` is an iterator, where the code makes one: of a method that answers one
 * (`ITERATING`), `items.values()`; of a global's function that makes one (`makesIterator`),
 * `Iterator.from(…)`; of a call `isGenerator` says calls a generator; of a method of one that
 * answers another (`ITERATOR_HELPERS`), read by its name or by text in brackets, `['map']` — a name
 * read as what `reach` says it holds.
 */
export function isIterator(
  node: Expression,
  reach: (node: Expression) => Expression,
  isGenerator: (call: CallExpression) => boolean,
): boolean {
  const seen = new Set<Expression>();
  for (let value = uncast(reach(node)); isCallExpression(value) && !seen.has(value);) {
    seen.add(value);
    const callee = uncast(value.expression);
    const path = globalPathOf(callee) ?? borrowedSymbolPath(callee);
    if (path !== undefined) {
      return makesIterator(path);
    }
    const name = calledName(callee);
    if (name !== undefined && ITERATING.has(name)) {
      return true;
    }
    if (
      name === undefined ||
      !ITERATOR_HELPERS.has(name) ||
      !(isPropertyAccessExpression(callee) || isElementAccessExpression(callee))
    ) {
      return isGenerator(value);
    }
    value = uncast(reach(callee.expression));
  }
  return false;
}

/**
 * Whether a call of the global `path` makes an iterator: of a function of `Iterator`'s that makes
 * one (`ITERATOR_MAKERS`), or of a method of a prototype that answers one (`ITERATING`) — or of
 * `Iterator.prototype`'s, another (`ITERATOR_HELPERS`) — by its name or a symbol's
 * (`borrowedSymbolPath`), called on the prototype, or on what `call` or `apply` is given first,
 * `Array.prototype.values.call(items)`. Any other function of a global
 * answers what it is: `Object.keys(…)`, an array.
 */
function makesIterator(path: readonly string[]): boolean {
  const called = BORROWING.has(path.at(-1) ?? '') ? path.slice(0, -1) : path;
  if (ITERATOR_MAKERS.has(called.join('.'))) {
    return true;
  }
  const [root, prototype, method, ...more] = called;
  return (
    prototype === 'prototype' &&
    method !== undefined &&
    more.length === 0 &&
    (ITERATING.has(method) || (root === 'Iterator' && ITERATOR_HELPERS.has(method)))
  );
}

/**
 * The names of a global's method keyed by a symbol the language knows, called through `call` or
 * `apply` — `Array.prototype[Symbol.iterator].call(items)` — as `globalPathOf` reads one by its
 * name: the global's first, the symbol's, then `call`'s or `apply`'s; none of another callee.
 */
function borrowedSymbolPath(callee: Expression): readonly string[] | undefined {
  const borrowing = calledName(callee);
  if (
    borrowing === undefined ||
    !BORROWING.has(borrowing) ||
    !(isPropertyAccessExpression(callee) || isElementAccessExpression(callee))
  ) {
    return undefined;
  }
  const method = uncast(callee.expression);
  const symbol = calledName(method);
  if (symbol?.startsWith('Symbol.') !== true || !isElementAccessExpression(method)) {
    return undefined;
  }
  const of = globalPathOf(uncast(method.expression));
  return of === undefined ? undefined : [...of, symbol, borrowing];
}

/**
 * The name of the method `callee` reads: by its name, by text in brackets, or a symbol the language
 * knows, `[Symbol.iterator]`; none of another.
 */
function calledName(callee: Expression): string | undefined {
  if (isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  if (!isElementAccessExpression(callee)) {
    return undefined;
  }
  const key = uncast(callee.argumentExpression);
  if (isStringLiteral(key) || isNoSubstitutionTemplateLiteral(key)) {
    return key.text;
  }
  const symbol = globalPathOf(key)?.join('.');
  return symbol?.startsWith('Symbol.') === true ? symbol : undefined;
}
