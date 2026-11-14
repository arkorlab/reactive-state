import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exportsOf } from '../src/compiler/hook-exports.ts';

/**
 * What a module of hooks exports of its functions, as it runs: an export of a type alone —
 * `export type { useThing }`, `export { type useThing }` — exports nothing that runs, and so no
 * hook, where `export { useThing }` and `export function useThing() {}` do.
 */

const HOOK = 'function useThing() {\n  return 1;\n}';

const CASES = [
  { exports: [], source: `${HOOK}\nexport type { useThing };`, what: 'a list of types alone' },
  { exports: [], source: `${HOOK}\nexport { type useThing };`, what: 'a name of a type alone' },
  {
    exports: [['useOther', 'useOther']],
    source: `${HOOK}\nfunction useOther() {}\nexport { type useThing, useOther };`,
    what: 'a type beside a value',
  },
  { exports: [['useThing', 'useThing']], source: `${HOOK}\nexport { useThing };`, what: 'a value' },
  {
    exports: [['useRenamed', 'useThing']],
    source: `${HOOK}\nexport { useThing as useRenamed };`,
    what: 'a value renamed',
  },
  {
    exports: [['useThing', 'useThing']],
    source: 'export function useThing() {\n  return 1;\n}',
    what: 'an exported function',
  },
] as const;

describe('the hooks a module exports, of types alone', () => {
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
