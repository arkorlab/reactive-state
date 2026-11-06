import { type Identifier, isIdentifier, isReturnStatement, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { arrayRestView } from '../src/compiler/framed-array-rest.ts';

/**
 * A rest of a parameter's array pattern copies what the call gives the parameter, and the default
 * only where it gives none: the default is no source of it, which the call's argument may replace.
 * A rest of a variable's pattern copies its initializer. The rows marked a pin answer the same
 * before the change as after it.
 */

const CASES = [
  {
    source: 'function collect([...rest] = [0]) { return rest; }',
    view: undefined,
    what: "a rest of a parameter's default",
  },
  {
    source: 'function collect([first, ...rest]: unknown[] = [0, 1]) { return rest; }',
    view: undefined,
    what: 'a rest after an element of a default',
  },
  {
    source: 'function collect() { const [...rest] = [0]; return rest; }',
    view: { start: 0, value: '[0]' },
    what: "a rest of a variable's initializer (pin)",
  },
  {
    source: 'function collect() { const [first, ...rest] = [0, 1, 2]; return rest; }',
    view: { start: 1, value: '[0, 1, 2]' },
    what: 'a rest after an element (pin)',
  },
] as const;

describe('a rest of a parameter pattern of a default', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `arrayRestView` reads of the rest the function in `source` returns. */
  function viewOf(
    source: string,
  ): { readonly start: number | undefined; readonly value: string } | undefined {
    using parsed = api.createSourceFile('framed-array-rest.ts', source);
    let returned: Identifier | undefined;
    const visit = (node: Node): void => {
      if (isReturnStatement(node) && node.expression !== undefined && isIdentifier(node.expression))
        returned = node.expression;
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    if (returned === undefined) {
      throw new Error(`No rest is returned in ${source}.`);
    }
    const view = arrayRestView(returned, undefined);
    return view === undefined
      ? undefined
      : { start: view.start, value: view.value.getText(parsed.sourceFile) };
  }

  it.each(CASES)('$what', ({ source, view }) => {
    expect(viewOf(source)).toStrictEqual(view);
  });
});
