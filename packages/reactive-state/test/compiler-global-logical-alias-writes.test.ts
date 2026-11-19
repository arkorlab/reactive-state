import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const REQUEST_URL_REFUSAL = 'makes `Request` of a URL the code shows no absolute one';
const REDIRECT_URL_REFUSAL = 'makes `Response.redirect` of a URL the code shows no absolute one';
const BLOB_ENDINGS_REFUSAL =
  'makes a `Blob` or `File` of line endings the code shows no `transparent` one';

const CASES = [
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'nullish-assignment-of-a-constructor-then-construct',
    source:
      "export function make(): string { let Ctor: any; Ctor ??= Request; return new Ctor('/api').url; }",
  },
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'or-assignment-of-a-constructor-then-construct',
    source:
      "export function make(): string { let Ctor: any = undefined; Ctor ||= Request; return new Ctor('/api').url; }",
  },
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'and-assignment-of-a-constructor-then-construct',
    source:
      "export function make(): string { let Ctor: any = Response; Ctor &&= Request; return new Ctor('/api').url; }",
  },
  {
    expected: BLOB_ENDINGS_REFUSAL,
    id: 'nullish-assignment-of-blob-then-construct',
    source:
      "export function make() { let Blobs: any; Blobs ??= Blob; return new Blobs(['a'], { endings: 'native' }).size; }",
  },
  {
    expected: REDIRECT_URL_REFUSAL,
    id: 'nullish-assignment-of-a-namespace-then-redirect',
    source:
      "export function make() { let Res: any; Res ??= Response; return Res.redirect('/next'); }",
  },
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'plain-assignment-of-a-constructor-then-construct-pin',
    source:
      "export function make(): string { let Ctor: any; Ctor = Request; return new Ctor('/api').url; }",
  },
  {
    expected: undefined,
    id: 'nullish-assignment-of-a-local-class-pin',
    source:
      "class Local { constructor(readonly url: string) {} } export function make(): string { let Ctor: any; Ctor ??= Local; return new Ctor('/api').url; }",
  },
  {
    expected: undefined,
    id: 'nullish-assignment-of-a-constructor-to-an-absolute-url-pin',
    source:
      "export function make(): string { let Ctor: any; Ctor ??= Request; return new Ctor('https://example.com/api').url; }",
  },
  {
    expected: undefined,
    id: 'nullish-assignment-of-plain-data-pin',
    source: "export function make() { let name: any; name ??= 'abc'; return name.length; }",
  },
] as const;

describe('a logical assignment gives a binding one more value to follow to a global', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module reaching a global class through `??=`, `||=` or `&&=`. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'global-logical-alias-writes.ts', source);

    // Each refusal goes on to say why; the rows name what it refuses.
    return unsettledIn(parsed.sourceFile)?.split(', which', 1)[0];
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
