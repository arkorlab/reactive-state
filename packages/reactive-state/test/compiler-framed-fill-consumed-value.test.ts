import { type Expression, isIdentifier, isReturnStatement, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { writtenArrayElements } from '../src/compiler/framed-array-elements.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * `fill(value, start, end)` writes its first runtime argument: a spread before it may supply that
 * value or nothing at all, so the written argument after an empty or unknown spread may be the
 * value instead.
 */
const CASES = [
  {
    id: 'reviewed-empty-spread',
    source:
      "function frames(error: Error) { const values: unknown[] = ['safe']; values.fill(...[], error); return values; }",
    elements: ['error'],
  },
  {
    id: 'opaque-spread',
    source:
      "function frames(error: Error, rest: unknown[]) { const values: unknown[] = ['safe']; values.fill(...rest, error); return values; }",
    elements: ['...rest', 'error'],
  },
  {
    id: 'borrowed-empty-spread',
    source:
      "function frames(error: Error) { const values: unknown[] = ['safe']; Array.prototype.fill.call(values, ...[], error); return values; }",
    elements: ['error'],
  },
  {
    id: 'spread-supplies-value',
    source:
      "function frames(error: Error) { const values: unknown[] = ['safe']; values.fill(...[0], error as any); return values; }",
    elements: ['0'],
  },
  {
    id: 'written-value-pin',
    source:
      "function frames(error: Error) { const values: unknown[] = ['safe']; values.fill(error, 0, 1); return values; }",
    elements: ['error'],
  },
] as const;

describe('the value a fill call writes after a spread', () => {
  it.each(CASES)('$id', ({ source, elements }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'fill-consumed-value.ts', source);
    const read = returned(parsed.sourceFile);
    const written = writtenArrayElements(read, read).map((each) => each.value.getText());

    expect(written).toStrictEqual(elements);
  });
});

function returned(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isReturnStatement(node) && node.expression !== undefined && isIdentifier(node.expression))
      return node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no returned name');
}
