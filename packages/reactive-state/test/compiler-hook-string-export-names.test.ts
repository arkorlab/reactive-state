import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exportsOf } from '../src/compiler/hook-exports.ts';

/**
 * A module may export a name written as a string, `export { useThing as "default" }`, which names
 * what `export { useThing as default }` does, or a name that is no identifier, `"use-thing"`. A hook
 * is exported under it, as a component's `import { "use-thing" as useThing }` reads it. What a
 * module exports is a local binding, an identifier: a string cannot be one, and the export of a
 * type alone exports nothing that runs, written as a string as well.
 */

const HOOK = 'function useThing() {\n  return 1;\n}';

const CASES = [
  {
    exports: [['default', 'useThing']],
    source: `${HOOK}\nexport { useThing as default };`,
    what: 'a default written as a name',
  },
  {
    exports: [['default', 'useThing']],
    source: `${HOOK}\nexport { useThing as "default" };`,
    what: 'a default written as a string',
  },
  {
    exports: [['useRenamed', 'useThing']],
    source: `${HOOK}\nexport { useThing as "useRenamed" };`,
    what: 'a name written as a string',
  },
  {
    exports: [['use-renamed', 'useThing']],
    source: `${HOOK}\nexport { useThing as "use-renamed" };`,
    what: 'a name that is no identifier',
  },
  {
    exports: [
      ['default', 'useThing'],
      ['use-thing', 'useThing'],
    ],
    source: `${HOOK}\nexport { useThing as "default", useThing as "use-thing" };`,
    what: 'a hook exported under two strings',
  },
  {
    exports: [],
    source: `${HOOK}\nexport { type useThing as "default" };`,
    what: 'a name of a type alone, written as a string',
  },
  {
    exports: [],
    source: `${HOOK}\nexport type { useThing as "default" };`,
    what: 'a list of types alone, written as a string',
  },
  {
    exports: [],
    source: `${HOOK}\nexport { "useThing" as "default" };`,
    what: 'a string as the local name, which is no binding',
  },
  {
    exports: [],
    source: 'export { default as "useThing" } from "./other";',
    what: 'a name another module exports',
  },
] as const;

describe('the hooks a module exports by a name written as a string', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `exportsOf` says the module `source` exports, by the name each is exported under. */
  function exported(source: string): readonly (readonly [string, string])[] {
    using parsed = api.createSourceFile('use-thing.ts', `${source}\n`);
    return [...exportsOf(parsed.sourceFile.statements)];
  }

  it.each(CASES)('reads $what', ({ exports, source }) => {
    expect(exported(source)).toStrictEqual(exports);
  });
});
