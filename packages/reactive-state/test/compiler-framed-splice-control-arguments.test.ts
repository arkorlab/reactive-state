import { type Expression, isIdentifier, isReturnStatement, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { writtenArrayElements } from '../src/compiler/framed-array-elements.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * `splice(start, deleteCount, ...items)` inserts only from its third argument. A written argument
 * before the first spread keeps its position, so a start or delete count written there is never an
 * element; a spread at those positions leaves every later argument possibly inserted.
 */
const CASES = [
  {
    id: 'reviewed-start-before-spread',
    source:
      'function frames(error: Error) { const values: unknown[] = []; values.splice(error as any, 0, ...[]); return values; }',
    elements: ['...[]'],
  },
  {
    id: 'count-before-spread',
    source:
      'function frames(error: Error, rest: unknown[]) { const values: unknown[] = []; values.splice(0, error as any, ...rest); return values; }',
    elements: ['...rest'],
  },
  {
    id: 'borrowed-start-before-spread',
    source:
      'function frames(error: Error) { const values: unknown[] = []; Array.prototype.splice.call(values, error as any, 0, ...[]); return values; }',
    elements: ['...[]'],
  },
  {
    id: 'second-argument-spread',
    source:
      'function frames(error: Error, start: number, rest: number[]) { const values: unknown[] = []; values.splice(start, ...rest, error); return values; }',
    elements: ['...rest', 'error'],
  },
  {
    id: 'leading-spread',
    source:
      'function frames(error: Error, rest: number[]) { const values: unknown[] = []; values.splice(...rest, error); return values; }',
    elements: ['...rest', 'error'],
  },
  {
    id: 'written-controls-pin',
    source:
      'function frames(error: Error) { const values: unknown[] = []; values.splice(error as any, 0); return values; }',
    elements: [],
  },
  {
    id: 'inserted-after-controls',
    source:
      'function frames(error: Error, rest: unknown[]) { const values: unknown[] = []; values.splice(0, 0, ...rest, error); return values; }',
    elements: ['...rest', 'error'],
  },
] as const;

describe('splice controls before an argument spread', () => {
  it.each(CASES)('$id', ({ source, elements }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'splice-control-arguments.ts', source);
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
