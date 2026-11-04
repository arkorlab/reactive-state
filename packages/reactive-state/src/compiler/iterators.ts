import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';

/**
 * What of the code makes an iterator, as the language does (`retained.ts`, `kept.ts`): a method
 * that answers one, `Iterator.from`, a generator called, a helper of one called on it.
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

/**
 * Whether `node` is an iterator, where the code makes one: of a method that answers one
 * (`ITERATING`), `items.values()`; of `Iterator.from(…)`; of a call `isGenerator` says calls a
 * generator; of a method of one that answers another (`ITERATOR_HELPERS`) — a name read as what
 * `reach` says it holds.
 */
export function isIterator(
  node: Expression,
  reach: (node: Expression) => Expression,
  isGenerator: (call: CallExpression) => boolean,
): boolean {
  const seen = new Set<Expression>();
  for (let value = reach(node); isCallExpression(value) && !seen.has(value);) {
    seen.add(value);
    const callee = unwrapped(value.expression);
    const path = globalPathOf(callee);
    if (path !== undefined) {
      return path.join('.') === 'Iterator.from';
    }
    const name = calledName(callee);
    if (name !== undefined && ITERATING.has(name)) {
      return true;
    }
    if (name === undefined || !ITERATOR_HELPERS.has(name) || !isPropertyAccessExpression(callee)) {
      return isGenerator(value);
    }
    value = reach(callee.expression);
  }
  return false;
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
  const key = unwrapped(callee.argumentExpression);
  if (isStringLiteral(key) || isNoSubstitutionTemplateLiteral(key)) {
    return key.text;
  }
  const symbol = globalPathOf(key)?.join('.');
  return symbol?.startsWith('Symbol.') === true ? symbol : undefined;
}
