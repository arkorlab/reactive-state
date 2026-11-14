import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString, framedArrayText } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A destructuring assignment or a loop head writes each member its pattern names, at any depth and
 * through defaults: one that names an array's text method may replace a custom one.
 */
const SAFE = "values.join = () => 'safe';";

const CASES = [
  {
    id: 'reviewed-array-pattern',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} [values.join] = [Array.prototype.join]; return String(values); }`,
    converts: true,
  },
  {
    id: 'object-pattern',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} ({ restore: values.join } = { restore: Array.prototype.join }); return String(values); }`,
    converts: true,
  },
  {
    id: 'pattern-default-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} [values.join = Array.prototype.join] = []; return String(values); }`,
    converts: true,
  },
  {
    id: 'nested-pattern',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} [[values.join]] = [[Array.prototype.join]]; return String(values); }`,
    converts: true,
  },
  {
    id: 'opaque-key-pattern',
    source: `function frames(error: Error, key: string, source: Record<string, unknown>) { const values = [error]; ${SAFE} ({ [key]: values.join } = source); return String(values); }`,
    converts: true,
  },
  {
    id: 'loop-head',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (values.join of [Array.prototype.join]); return String(values); }`,
    converts: true,
  },
  {
    id: 'other-array-pattern-pin',
    source: `function frames(error: Error) { const values = [error]; const other = [1]; ${SAFE} [other.join] = [Array.prototype.join]; return String(values); }`,
    converts: false,
  },
  {
    id: 'other-member-pattern-pin',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} [(values as any).label] = [1]; return String(values); }`,
    converts: false,
  },
] as const;

describe('array text methods a pattern target replaces', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'pattern-method-writes.ts', source);

    expect(convertsError(parsed.sourceFile)).toBe(converts);
  });
});

/** Whether a native join, toString or String call in the source converts the `error` element. */
function convertsError(root: Node): boolean {
  const words = {
    error: (value: Expression, keys?: readonly string[]) => {
      const each = unwrapped(value);
      return (
        (keys === undefined || keys.length === 0) && isIdentifier(each) && each.text === 'error'
      );
    },
    typed: () => false,
  };
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedArrayText(node, words)) return true;
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
