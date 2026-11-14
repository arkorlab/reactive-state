import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exportsOf } from '../src/compiler/hook-exports.ts';

/**
 * A module of hooks's default export of a function by name, past a cast of either form, is that
 * function: `export default <typeof useThing>useThing;` as `export default useThing as typeof
 * useThing;`. A cast of a call names no function of the module's.
 */

const HOOK = 'function useThing() {\n  return 1;\n}';

const CASES = [
  {
    exports: [['default', 'useThing']],
    source: `${HOOK}\nexport default <typeof useThing>useThing;`,
    what: 'a cast in angle brackets',
  },
  {
    exports: [['default', 'useThing']],
    source: `${HOOK}\nexport default (<typeof useThing>(useThing));`,
    what: 'a cast within parentheses',
  },
  {
    exports: [['default', 'useThing']],
    source: `${HOOK}\nexport default useThing as typeof useThing;`,
    what: 'a cast by `as`',
  },
  { exports: [], source: `${HOOK}\nexport default <number>useThing();`, what: 'a cast of a call' },
] as const;

describe('the default hook of a module of hooks, past a cast', () => {
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
