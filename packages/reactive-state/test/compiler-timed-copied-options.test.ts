import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Expected refusal reason when `new File(...)` cannot prove a defined `lastModified` option. */
const TIMED_FILE_REFUSAL = 'makes a `File` of no `lastModified`, which it takes of the time';

/**
 * Property initializers and computed property names inside an earlier `File` options literal are
 * evaluated when that literal is constructed, whereas mutations to the options object itself
 * take effect up to `new File(...)`.
 */
const CASES = [
  {
    expected: undefined,
    id: 'copied-timestamp-reassigned-after-literal',
    source:
      "export function make() { let stamp: number | undefined = 0; const opts = { lastModified: stamp }; stamp = undefined; return new File([], 'x', opts).size; }",
  },
  {
    expected: undefined,
    id: 'copied-shorthand-timestamp-reassigned-after-literal',
    source:
      "export function make() { let lastModified: number | undefined = 0; const opts = { lastModified }; lastModified = undefined; return new File([], 'x', opts).size; }",
  },
  {
    expected: undefined,
    id: 'computed-key-reassigned-after-literal',
    source:
      "export function make() { let key = 'lastModified'; const opts = { [key]: 0 }; key = 'other'; return new File([], 'x', opts).size; }",
  },
  {
    expected: undefined,
    id: 'copied-endings-reassigned-after-literal',
    source:
      "export function make() { let endings: EndingType = 'transparent'; const opts = { endings, lastModified: 0 }; endings = 'native'; return new File([], 'x', opts).size; }",
  },
  {
    expected: undefined,
    id: 'copied-conditional-branches-reassigned-after-literal',
    source:
      "export function make(flag: boolean) { let first: number | undefined = 0; let second: number | undefined = 1; const opts = { lastModified: flag ? first : second }; first = undefined; second = undefined; return new File([], 'x', opts).size; }",
  },
  {
    expected: undefined,
    id: 'two-hop-copied-timestamp-reassigned-after-each-copy',
    source:
      "export function make() { let raw: number | undefined = 0; let stamp: number | undefined = raw; raw = undefined; const opts = { lastModified: stamp }; stamp = undefined; return new File([], 'x', opts).size; }",
  },
  {
    expected: undefined,
    id: 'loop-local-timestamp-reset-each-iteration',
    source:
      "export function make() { let total = 0; for (let i = 0; i < 2; i++) { let stamp: number | undefined = 0; const opts = { lastModified: stamp }; stamp = undefined; total += new File([], 'x', opts).size; } return total; }",
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'timestamp-cleared-before-literal-pin',
    source:
      "export function make() { let stamp: number | undefined = 0; stamp = undefined; const opts = { lastModified: stamp }; return new File([], 'x', opts).size; }",
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'computed-key-clears-timestamp-before-value-pin',
    source:
      "export function make() { let stamp: number | undefined = 0; const opts = { [((stamp = undefined), 'lastModified')]: stamp }; return new File([], 'x', opts).size; }",
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'options-object-mutated-after-copying-timestamp-pin',
    source:
      "export function make() { let stamp: number | undefined = 0; const opts: FilePropertyBag = { lastModified: stamp }; opts.lastModified = undefined; return new File([], 'x', opts).size; }",
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'options-alias-deleted-after-copying-timestamp-pin',
    source:
      "export function make() { let stamp: number | undefined = 0; const raw: FilePropertyBag = { lastModified: stamp }; const opts = raw; stamp = undefined; delete raw.lastModified; return new File([], 'x', opts).size; }",
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'outer-timestamp-cleared-across-loop-iteration-pin',
    source:
      "export function make() { let stamp: number | undefined = 0; let total = 0; for (let i = 0; i < 2; i++) { const opts = { lastModified: stamp }; total += new File([], 'x', opts).size; stamp = undefined; } return total; }",
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'helper-literal-evaluated-after-timestamp-cleared-pin',
    source:
      "export function make() { let stamp: number | undefined = 0; const build = () => { const opts = { lastModified: stamp }; return new File([], 'x', opts).size; }; stamp = undefined; return build(); }",
  },
] as const;

describe('copied File option literals with post-literal variable writes', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module constructing a `File`. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'timed-copied-options.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
