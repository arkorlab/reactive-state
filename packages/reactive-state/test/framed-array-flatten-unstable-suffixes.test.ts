import { type Expression, isExpressionStatement, isIdentifier } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { flattenedArrayViews } from '../src/compiler/framed-array-flatten.ts';

/**
 * An array the code changes after it is written, `items.push(changed)`, may hold more elements
 * than its initializer, after them: a position counted from the end of what `flat()` makes of it
 * may be one the initializer does not hold, so that none of its elements is the one selected
 * there alone. A position from the start, or one past every changed array, is still exact. The
 * rows marked a pin answer the same before the change as after it.
 */

const CASES = [
  {
    changed: ['items'],
    index: -1,
    source: 'const items = [0]; items.push(changed);',
    views: ['items', '0'],
    what: 'the last of a changed array',
  },
  {
    changed: ['inner'],
    index: -2,
    source: 'const inner = [1, 2]; inner.push(changed); const items = [0, inner, 3];',
    views: ['0', 'inner', '1', '2', '3'],
    what: 'the last of a changed inner array',
  },
  {
    changed: ['inner'],
    index: -1,
    source: 'const inner = [1, 2]; inner.push(changed); const items = [0, inner, 3];',
    views: ['3'],
    what: 'the last after a changed array (pin)',
  },
  {
    changed: [],
    index: -1,
    source: 'const items = [0, 1];',
    views: ['1'],
    what: 'the last of an unchanged array (pin)',
  },
  {
    changed: ['items'],
    index: 0,
    source: 'const items = [0]; items.push(changed);',
    views: ['items', '0'],
    what: 'the first of a changed array (pin)',
  },
] as const;

describe('a position from the end of a flattened array the code changes', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /**
   * The text of each view `flat()` of `items` keeps of the position `index`, in `source`, which
   * changes the arrays `changed` names after it writes them.
   */
  function viewsOf(source: string, index: number, changed: readonly string[]): readonly string[] {
    using parsed = api.createSourceFile(
      'framed-array-flatten.ts',
      `declare const changed: unknown;\n${source}\nitems;\n`,
    );
    const last = parsed.sourceFile.statements.at(-1);
    if (last === undefined || !isExpressionStatement(last)) {
      throw new Error(`No read of items ends ${source}.`);
    }
    const stable = (value: Expression): boolean =>
      !(isIdentifier(value) && changed.includes(value.text));
    return flattenedArrayViews(last.expression, index, 1, { capture: last, stable }).map((view) =>
      view.value.getText(parsed.sourceFile),
    );
  }

  it.each(CASES)('$what', ({ changed, index, source, views }) => {
    expect(viewsOf(source, index, changed)).toStrictEqual(views);
  });
});
