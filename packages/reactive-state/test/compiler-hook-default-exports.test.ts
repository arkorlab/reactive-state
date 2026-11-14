import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exportsOf } from '../src/compiler/hook-exports.ts';

/**
 * A module of hooks exports a function as its default by name, `export default useThing;`, as it
 * does by declaring it so, `export default function useThing() {}`: either is the module's default
 * hook. What another default export answers — a call, a value — names no function of the module's.
 */

const HOOK = 'function useThing() {\n  return 1;\n}';

const CASES = [
  {
    exports: [['default', 'useThing']],
    source: `${HOOK}\nexport default useThing;`,
    what: 'a function by its name',
  },
  {
    exports: [['default', 'useThing']],
    source: `${HOOK}\nexport default (useThing);`,
    what: 'a function in parentheses',
  },
  {
    exports: [['default', 'useThing']],
    source: 'export default function useThing() {\n  return 1;\n}',
    what: 'a function declared so',
  },
  { exports: [], source: `${HOOK}\nexport default useThing();`, what: 'a call' },
  { exports: [], source: `${HOOK}\nexport = useThing;`, what: "CommonJS's export" },
  { exports: [], source: 'export default 1;', what: 'a value' },
] as const;

describe('the default hook of a module of hooks', () => {
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

  it.each(CASES)('$what', ({ exports, source }) => {
    expect(exported(source)).toStrictEqual(exports);
  });
});
