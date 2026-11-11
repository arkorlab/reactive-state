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
 * Native filter numbers its result after skipping holes, so a kept element's result position is
 * its source position only where the compile has shown the source to have no hole before it:
 * elsewhere any kept element may be at the selected position, whatever the predicate keeps.
 */
const SAVED = 'touch(); return kept[0];';

const CASES = [
  {
    id: 'reviewed-sparse-saved-result',
    source: `function frames(error: Error) { const source = [, error]; const kept = source.filter(() => true); ${SAVED} }`,
    views: ['source@any'],
  },
  {
    id: 'sparse-saved-later-slot',
    source:
      "function frames(error: Error) { const source = [error, , { stack: 'fixed' }]; const kept = source.filter(() => true); touch(); return kept[1]; }",
    index: 1,
    views: ['source@any'],
  },
  {
    id: 'sparse-async-true-saved-result',
    source: `function frames(error: Error) { const source = [, error]; const kept = source.filter(async () => true); ${SAVED} }`,
    views: ['source@any'],
  },
  {
    id: 'constructed-saved-result',
    source: `function frames(error: Error) { const source = new Array<Error>(2); source[1] = error; const kept = source.filter(() => true); ${SAVED} }`,
    views: ['source@any'],
  },
  {
    id: 'parameter-saved-result',
    source: `function frames(errors: Error[]) { const kept = errors.filter(() => true); ${SAVED} }`,
    views: ['errors@any'],
  },
  {
    id: 'async-parameter-immediate-pin',
    source: 'function frames(errors: Error[]) { return errors.filter(async () => false)[0]; }',
    views: ['errors@any'],
  },
  {
    id: 'empty-spread-before-hole',
    source: `function frames(error: Error) { const source = [...[], , error]; const kept = source.filter(() => true); ${SAVED} }`,
    views: ['source@any'],
  },
  {
    id: 'spread-before-position',
    source: `function frames(error: Error, more: Error[]) { const source = [...more, error]; const kept = source.filter(() => true); touch(); return kept[1]; }`,
    index: 1,
    views: ['source@any'],
  },
  {
    id: 'spread-after-position-pin',
    source: `function frames(error: Error, more: Error[]) { const source = [error, ...more]; const kept = source.filter(() => true); ${SAVED} }`,
    views: ['source@0'],
  },
  {
    id: 'sparse-saved-before-hole-pin',
    source:
      "function frames(error: Error) { const source = [{ stack: 'fixed' }, , error]; const kept = source.filter(() => true); touch(); return kept[0]; }",
    views: ['source@0'],
  },
  {
    id: 'dense-saved-pin',
    source:
      "function frames(error: Error) { const source = [{ stack: 'fixed' }, error]; const kept = source.filter(() => true); touch(); return kept[1]; }",
    index: 1,
    views: ['source@1'],
  },
  {
    id: 'dense-immediate-pin',
    source:
      "function frames(error: Error) { return [{ stack: 'fixed' }, error].filter(() => true)[0]!.stack; }",
    views: ["[{ stack: 'fixed' }, error]@0"],
  },
  {
    id: 'dense-call-default-pin',
    source:
      'function frames(error: Error) { return [1, error].filter((value: unknown = (() => undefined)()) => true)[0]!.stack; }',
    views: ['[1, error]@0'],
  },
  {
    id: 'sparse-immediate-pin',
    source: 'function frames(error: Error) { return [, error].filter(() => true)[0]!.stack; }',
    views: ['error@any'],
  },
  {
    id: 'unwritten-predicate-pin',
    source:
      'function frames(error: Error) { return [error].filter((value) => value !== undefined)[0]; }',
    views: ['[error]@any'],
  },
  {
    id: 'sync-false-pin',
    source: 'function frames(error: Error) { return [error].filter(() => false)[0]; }',
    views: [],
  },
] as const;

describe('filter positions the compile does not place', () => {
  it.each(CASES)('$id', (row) => {
    expect(filterViews(row.source, 'index' in row ? row.index : 0)).toStrictEqual(row.views);
  });
});

/** The views of one position of the source's filter result, with the source index each reads. */
function filterViews(source: string, index: number): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(
    api,
    'filter-unproven-positions.ts',
    `declare function touch(): void; ${source}`,
  );
  const call = filterCall(parsed.sourceFile);
  if (!isPropertyAccessExpression(call.expression)) throw new Error('no filter member');
  const copy = { call, receiver: call.expression.expression, given: call.arguments };
  return filteredArrayViews(copy, index, () => true).map(
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
