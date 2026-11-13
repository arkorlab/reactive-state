import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A native object mutator hands back the object it was given first, and a mutator that is given
 * that result writes the array it came from: `Object.assign(Object.assign(a, {}), …)` writes `a`.
 */
const SAFE = "values.join = () => 'fixed';";

const CASES = [
  {
    id: 'assign-through-the-result-of-an-assign-restores-the-method',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} Object.assign(Object.assign(values, {}), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'define-through-the-result-of-an-assign-restores-the-method',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} Object.defineProperty(Object.assign(values, {}), 'join', { value: Array.prototype.join, writable: true, configurable: true }); return String(values); }`,
    converts: true,
  },
  {
    id: 'assign-through-three-results-restores-the-method',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} Object.assign(Object.assign(Object.assign(values, {}), {}), { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'define-properties-through-the-result-of-a-define-restores-the-method',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} Object.defineProperties(Object.defineProperty(values, 'other', { value: 1 }), { join: { value: Array.prototype.join, writable: true, configurable: true } }); return String(values); }`,
    converts: true,
  },
  {
    id: 'assign-through-the-result-of-another-array-pin',
    source: `function frames(error: Error) { const values = [error]; const other: unknown[] = []; ${SAFE} Object.assign(Object.assign(other, {}), { join: Array.prototype.join }); return String(values); }`,
    converts: false,
  },
  {
    id: 'assign-directly-restores-the-method-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} Object.assign(values, { join: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
] as const;

describe('the array a mutator reaches through the result of another', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** Whether the source's `String(array)` converts the `error` element. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'returned-mutator-target.ts', source);
  const words = {
    error: (value: Expression, keys?: readonly string[]) => {
      const each = unwrapped(value);
      return (
        (keys === undefined || keys.length === 0) && isIdentifier(each) && each.text === 'error'
      );
    },
    typed: () => false,
  };
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'String' &&
      framedArrayString(node.arguments[0], words, node)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
