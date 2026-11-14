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
 * A negative position counts from the end of a filter result whose length the source does not
 * show, so it is no source position: it answers what an unknown position does, whichever index
 * the caller passes. Its one caller gives none for a negative index, but the function takes any.
 */
const SAVED = 'touch(); return kept[0];';

const CASES = [
  {
    id: 'trailing-hole',
    source: `function frames(error: Error) { const source = [error, ,]; const kept = source.filter(() => true); ${SAVED} }`,
    views: ['source@any'],
  },
  {
    id: 'trailing-hole-before-last',
    source: `function frames(error: Error) { const source = [error, { stack: 'fixed' }, ,]; const kept = source.filter(() => true); ${SAVED} }`,
    views: ['source@any'],
  },
  {
    id: 'dense-source',
    source: `function frames(error: Error) { const source = [{ stack: 'fixed' }, error]; const kept = source.filter(() => true); ${SAVED} }`,
    views: ['source@any'],
  },
  {
    id: 'immediate-sparse-literal',
    source: 'function frames(error: Error) { return [, error].filter(() => true)[0]!.stack; }',
    views: ['error@any'],
  },
  {
    id: 'async-predicate',
    source: `function frames(error: Error) { const source = [error, ,]; const kept = source.filter(async () => false); ${SAVED} }`,
    views: ['source@any'],
  },
  {
    id: 'synchronous-false-pin',
    source: 'function frames(error: Error) { return [error].filter(() => false)[0]; }',
    views: [],
  },
] as const;

describe('negative positions of a filter result', () => {
  it.each(CASES)('$id', (row) => {
    expect(filterViews(row.source, -1)).toStrictEqual(row.views);
    expect(filterViews(row.source, -2)).toStrictEqual(row.views);
    expect(filterViews(row.source, undefined)).toStrictEqual(row.views);
  });
});

/** The views of one position of the source's filter result, with the source index each reads. */
function filterViews(source: string, index: number | undefined): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(
    api,
    'filter-negative-positions.ts',
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
