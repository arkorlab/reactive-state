import {
  type CallExpression,
  isCallExpression,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { filteredArrayViews } from '../src/compiler/framed-filter-results.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Native filter keeps an element for each truthy predicate answer, and an async predicate answers
 * with a Promise, which is truthy whatever it settles to: where the compile cannot place the kept
 * elements, any of the source's elements may sit at the selected position.
 */
const CASES = [
  {
    id: 'reviewed-saved-result',
    source:
      'function frames(error: Error) { const kept = [error].filter(async () => false); touch(); return kept[0]; }',
    views: ['[error]@any'],
  },
  {
    id: 'sparse-saved-result',
    source:
      'function frames(error: Error) { const source = [, error]; const kept = source.filter(async () => false); touch(); return kept[0]; }',
    views: ['source@any'],
  },
  {
    id: 'parameter-saved-result',
    source:
      'function frames(errors: Error[]) { const kept = errors.filter(async () => false); touch(); return kept[0]; }',
    views: ['errors@any'],
  },
  {
    id: 'sync-false-pin',
    source: 'function frames(error: Error) { return [error].filter(() => false)[0]; }',
    views: [],
  },
  {
    id: 'async-block-body-pin',
    source:
      'function frames(error: Error) { const kept = [error].filter(async () => { return false; }); return kept[0]; }',
    views: ['[error]@any'],
  },
  {
    id: 'sync-true-pin',
    source:
      'function frames(error: Error) { const kept = [error].filter(() => true); touch(); return kept[0]; }',
    views: ['[error]@0'],
  },
] as const;

describe('elements an async filter predicate keeps', () => {
  it.each(CASES)('$id', ({ source, views }) => {
    expect(filterViews(source)).toStrictEqual(views);
  });
});

/** The views of position 0 of the source's filter result, with the source index each reads. */
function filterViews(source: string): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(
    api,
    'async-filter-kept-elements.ts',
    `declare function touch(): void; ${source}`,
  );
  const call = filterCall(parsed.sourceFile);
  if (!isPropertyAccessExpression(call.expression)) throw new Error('no filter member');
  const copy = { call, receiver: call.expression.expression, given: call.arguments };
  return filteredArrayViews(copy, 0, () => true).map(
    (view) => `${view.value.getText()}@${view.index ?? 'any'}`,
  );
}

function filterCall(root: Node): CallExpression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'filter'
    )
      return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no filter call');
}
