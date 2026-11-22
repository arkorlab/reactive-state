import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Expected refusal reason when `new File` cannot prove an unchanged defined `lastModified`. */
const TIMED_FILE_REFUSAL = 'makes a `File` of no `lastModified`, which it takes of the time';

/**
 * `File` timestamp checks must account for writes, deletions, container escapes, and loop-carried
 * mutations before construction rather than trusting original variable initializers unconditionally.
 */
const CASES = [
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'deleted-last-modified-property',
    source:
      "export function make() { const options: FilePropertyBag = { lastModified: 0 }; delete options.lastModified; return new File([], 'x', options).lastModified; }",
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'overwritten-last-modified-property',
    source:
      "export function make() { const opts: FilePropertyBag = { lastModified: 0 }; opts.lastModified = undefined; return new File([], 'x', opts).size; }",
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'reassigned-timestamp-binding',
    source:
      "export function make() { let ts: number | undefined = 0; ts = undefined; return new File([], 'x', { lastModified: ts }).size; }",
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'reassigned-shorthand-timestamp',
    source:
      "export function make() { let lastModified: number | undefined = 0; lastModified = undefined; return new File([], 'x', { lastModified }).size; }",
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'reassigned-computed-key-binding',
    source:
      "export function make() { let key = 'lastModified'; key = 'type'; return new File([], 'x', { [key]: 0 } as FilePropertyBag).size; }",
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'container-alias-mutation',
    source:
      "export function make() { const opts: FilePropertyBag = { lastModified: 0 }; const box = { opts }; box.opts.lastModified = undefined; return new File([], 'x', opts).size; }",
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'loop-carried-mutation-after-construction',
    source:
      "export function make() { const opts: FilePropertyBag = { lastModified: 0 }; let total = 0; for (let i = 0; i < 2; i++) { total += new File([], 'x', opts).size; opts.lastModified = undefined; } return total; }",
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'getter-mutating-sibling-option',
    source:
      "export function make() { return new File([], 'x', { lastModified: 0, get endings(): EndingType { (this as FilePropertyBag).lastModified = undefined; return 'transparent'; } }).size; }",
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'spread-constructor-arguments',
    source:
      "export function make(bits: [BlobPart[]]) { return new File(...bits, 'x', { endings: 'transparent', lastModified: 0 }).size; }",
  },
  {
    expected: undefined,
    id: 'unchanged-options-binding-pin',
    source:
      "export function make() { const opts: FilePropertyBag = { endings: 'transparent', lastModified: 0 }; return new File([], 'x', opts).size; }",
  },
  {
    expected: undefined,
    id: 'unchanged-const-alias-pin',
    source:
      "export function make() { const lastModified = 0; const opts = { endings: 'transparent' as const, lastModified }; const alias = opts; return new File([], 'x', alias).size; }",
  },
  {
    expected: undefined,
    id: 'unchanged-computed-key-pin',
    source:
      "export function make() { const key = 'lastModified'; return new File([], 'x', { endings: 'transparent', [key]: 0 }).size; }",
  },
  {
    expected: undefined,
    id: 'mutation-strictly-after-construction-pin',
    source:
      "export function make() { const opts: FilePropertyBag = { endings: 'transparent', lastModified: 0 }; const size = new File([], 'x', opts).size; opts.lastModified = undefined; return size; }",
  },
] as const;

describe('file timestamp checks across local writes', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Returns the unsettled reason reported for `source`, if any. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'timed-file-writes.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
