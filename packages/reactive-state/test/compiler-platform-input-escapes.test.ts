import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Expected refusal reason when a `Blob` options proof is invalidated before construction. */
const ENDINGS_REFUSAL =
  'makes a `Blob` or `File` of line endings the code shows no `transparent` one, which may follow the host platform';

/**
 * Mutable platform option bindings retain their initializer proof only while every pre-read use
 * keeps lexical identity without storing, returning, exporting, or invoking methods on the value.
 */
const CASES = [
  {
    expected: ENDINGS_REFUSAL,
    id: 'shorthand-object-container',
    source:
      "export function label(text: string) { const opts: BlobPropertyBag = { endings: 'transparent' }; const box = { opts }; box.opts.endings = 'native'; return new Blob([text], opts).size; }",
  },
  {
    expected: ENDINGS_REFUSAL,
    id: 'named-object-container',
    source:
      "export function label(text: string) { const opts: BlobPropertyBag = { endings: 'transparent' }; const box = { held: opts }; box.held.endings = 'native'; return new Blob([text], opts).size; }",
  },
  {
    expected: ENDINGS_REFUSAL,
    id: 'array-container',
    source:
      "export function label(text: string) { const opts: BlobPropertyBag = { endings: 'transparent' }; const list = [opts]; list[0]!.endings = 'native'; return new Blob([text], opts).size; }",
  },
  {
    expected: ENDINGS_REFUSAL,
    id: 'property-assignment-alias',
    source:
      "export function label(text: string) { const opts: BlobPropertyBag = { endings: 'transparent' }; const box: { opts?: BlobPropertyBag } = {}; box.opts = opts; box.opts.endings = 'native'; return new Blob([text], opts).size; }",
  },
  {
    expected: ENDINGS_REFUSAL,
    id: 'reassigned-local-alias',
    source:
      "export function label(text: string) { const opts: BlobPropertyBag = { endings: 'transparent' }; let alias: BlobPropertyBag | undefined; alias = opts; alias.endings = 'native'; return new Blob([text], opts).size; }",
  },
  {
    expected: ENDINGS_REFUSAL,
    id: 'helper-return-alias',
    source:
      "export function label(text: string) { const opts: BlobPropertyBag = { endings: 'transparent' }; function identity(value: BlobPropertyBag) { return value; } const alias = identity(opts); alias.endings = 'native'; return new Blob([text], opts).size; }",
  },
  {
    expected: ENDINGS_REFUSAL,
    id: 'concise-arrow-return-alias',
    source:
      "export function label(text: string) { const opts: BlobPropertyBag = { endings: 'transparent' }; const identity = (value: BlobPropertyBag) => value; const alias = identity(opts); alias.endings = 'native'; return new Blob([text], opts).size; }",
  },
  {
    expected: ENDINGS_REFUSAL,
    id: 'global-object-wrapper-alias',
    source:
      "export function label(text: string) { const opts: BlobPropertyBag = { endings: 'transparent' }; const alias = Object(opts); alias.endings = 'native'; return new Blob([text], opts).size; }",
  },
  {
    expected: ENDINGS_REFUSAL,
    id: 'method-call-on-options',
    source:
      "export function label(text: string) { const opts = { endings: 'transparent' as EndingType, flip() { this.endings = 'native'; } }; opts.flip(); return new Blob([text], opts).size; }",
  },
  {
    expected: ENDINGS_REFUSAL,
    id: 'exported-options-binding',
    source:
      "export const opts: BlobPropertyBag = { endings: 'transparent' }; export function label(text: string) { return new Blob([text], opts).size; }",
  },
  {
    expected: undefined,
    id: 'direct-constant-options-pin',
    source:
      "export function label(text: string) { const opts = { endings: 'transparent' } as const; return new Blob([text], opts).size; }",
  },
  {
    expected: undefined,
    id: 'const-alias-options-pin',
    source:
      "export function label(text: string) { const opts = { endings: 'transparent' } as const; const alias = opts; return new Blob([text], alias).size; }",
  },
  {
    expected: undefined,
    id: 'helper-member-read-pin',
    source:
      "export function label(text: string) { const opts = { endings: 'transparent' } as const; function read(value: BlobPropertyBag) { return value.endings; } void read(opts); return new Blob([text], opts).size; }",
  },
  {
    expected: undefined,
    id: 'object-spread-copy-pin',
    source:
      "export function label(text: string) { const opts = { endings: 'transparent' } as const; const copy = { ...opts }; void copy.endings; return new Blob([text], opts).size; }",
  },
  {
    expected: undefined,
    id: 'container-after-construction-pin',
    source:
      "export function label(text: string) { const opts: BlobPropertyBag = { endings: 'transparent' }; const size = new Blob([text], opts).size; const box = { opts }; box.opts.endings = 'native'; return size; }",
  },
] as const;

describe('platform input escape and container alias checks', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Returns the module's unsettled reason, if any. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'platform-input-escapes.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
