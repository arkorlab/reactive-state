import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const REQUEST_URL_REFUSAL = 'makes `Request` of a URL the code shows no absolute one';
const REDIRECT_URL_REFUSAL = 'makes `Response.redirect` of a URL the code shows no absolute one';
const BLOB_ENDINGS_REFUSAL =
  'makes a `Blob` or `File` of line endings the code shows no `transparent` one';
const COMPRESSION_REFUSAL = 'makes a `CompressionStream` of a format but `gzip`';

const CASES = [
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'subclass-of-request-without-a-constructor',
    source:
      "class ApiRequest extends Request {} export function make() { return new ApiRequest('/api').url; }",
  },
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'subclass-of-request-with-a-constructor-calling-super',
    source:
      "class ApiRequest extends Request { constructor(path: string) { super(path); } } export function make() { return new ApiRequest('/api').url; }",
  },
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'class-expression-extending-request-held-by-a-constant',
    source:
      "const ApiRequest = class extends Request {}; export function make() { return new ApiRequest('/api').url; }",
  },
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'subclass-of-a-subclass-of-request',
    source:
      "class Base extends Request {} class Api extends Base {} export function make() { return new Api('/api').url; }",
  },
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'subclass-of-request-aliased-by-a-constant',
    source:
      "const Req = Request; class Api extends Req {} export function make() { return new Api('/api').url; }",
  },
  {
    expected: REDIRECT_URL_REFUSAL,
    id: 'static-redirect-inherited-from-response',
    source:
      "class Redirecting extends Response {} export function make() { return Redirecting.redirect('/next'); }",
  },
  {
    expected: BLOB_ENDINGS_REFUSAL,
    id: 'subclass-of-blob-with-native-endings',
    source:
      "class Bytes extends Blob {} export function make() { return new Bytes(['a'], { endings: 'native' }).size; }",
  },
  {
    expected: COMPRESSION_REFUSAL,
    id: 'subclass-of-a-compression-stream-of-an-unheld-format',
    source:
      "class Squeeze extends CompressionStream {} export function make() { return new Squeeze('brotli'); }",
  },
  {
    expected: undefined,
    id: 'subclass-of-request-of-an-absolute-url-pin',
    source:
      "class ApiRequest extends Request {} export function make() { return new ApiRequest('https://example.com/api').url; }",
  },
  {
    expected: undefined,
    id: 'subclass-of-blob-with-transparent-endings-pin',
    source:
      "class Bytes extends Blob {} export function make() { return new Bytes(['a'], { endings: 'transparent' }).size; }",
  },
  {
    expected: undefined,
    id: 'subclass-of-a-local-class-pin',
    source: 'class Base {} class Sub extends Base {} export function make() { return new Sub(); }',
  },
  {
    expected: undefined,
    id: 'subclass-of-map-pin',
    source:
      'class Counts extends Map<string, number> {} export function make() { return new Counts().size; }',
  },
  {
    expected: undefined,
    id: 'class-with-no-heritage-pin',
    source:
      "class Local { constructor(readonly url: string) {} } export function make() { return new Local('/api').url; }",
  },
] as const;

describe('a class that extends a global is constructed as that global', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module that constructs a subclass of a global class. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'global-class-subclasses.ts', source);

    // Each refusal goes on to say why; the rows name what it refuses.
    return unsettledIn(parsed.sourceFile)?.split(', which', 1)[0];
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    const answer = refusalIn(source);

    expect(answer?.slice(0, expected?.length ?? 0) ?? answer).toBe(expected);
  });
});
