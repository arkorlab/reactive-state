import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const REQUEST_URL_REFUSAL =
  "makes `Request` of a URL the code shows no absolute one, which a page reads against its document's and the authority refuses";
const REDIRECT_URL_REFUSAL =
  "makes `Response.redirect` of a URL the code shows no absolute one, which a page reads against its document's and the authority refuses";
const BLOB_ENDINGS_REFUSAL =
  'makes a `Blob` or `File` of line endings the code shows no `transparent` one, which may follow the host platform';
const COMPRESSION_STREAM_REFUSAL =
  'makes a `CompressionStream` of a format but `gzip`, `deflate` and `deflate-raw`, which an authority may hold not';
const MULTIPART_REFUSAL =
  'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random';
const TIMED_FILE_REFUSAL = 'makes a `File` of no `lastModified`, which it takes of the time';
const EVENT_TIMESTAMP_REFUSAL = "reads an event's `timeStamp`, of the time it was made";

const CASES = [
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'request-constructor-const-alias-relative-url',
    source:
      "const MakeRequest = Request; export function make() { return new MakeRequest('/api').url; }",
  },
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'request-constructor-global-alias-chain',
    source:
      "const First = globalThis.Request; const MakeRequest = First; export function make() { return new MakeRequest('/api').url; }",
  },
  {
    expected: REDIRECT_URL_REFUSAL,
    id: 'response-namespace-alias-redirect-relative-url',
    source:
      "const MakeResponse = Response; export function make() { return MakeResponse.redirect('/api').status; }",
  },
  {
    expected: COMPRESSION_STREAM_REFUSAL,
    id: 'compression-stream-constructor-alias-unsupported-format',
    source:
      "const MakeStream = CompressionStream; export function make() { return new MakeStream('brotli' as CompressionFormat); }",
  },
  {
    expected: BLOB_ENDINGS_REFUSAL,
    id: 'blob-constructor-alias-native-endings',
    source: String.raw`const MakeBlob = Blob; export function make() { return new MakeBlob(['\n'], { endings: 'native' }).size; }`,
  },
  {
    expected: MULTIPART_REFUSAL,
    id: 'request-constructor-alias-formdata-multipart',
    source:
      "const MakeRequest = Request; export function make() { return new MakeRequest('https://example.com/', { method: 'POST', body: new FormData() }).headers.get('content-type'); }",
  },
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'request-special-scheme-without-slashes',
    source: "export function make() { return new Request('https:example.com').url; }",
  },
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'request-special-scheme-single-slash',
    source: "export function make() { return new Request('https:/example.com').url; }",
  },
  {
    expected: REDIRECT_URL_REFUSAL,
    id: 'response-redirect-http-scheme-without-slashes',
    source: "export function make() { return Response.redirect('http:example.com/next').status; }",
  },
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'request-file-single-slash-relative-drive',
    source: "export function make() { return new Request('file:/tmp/report').url; }",
  },
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'request-template-special-scheme-without-slashes',
    source: `export function make(host: string) { return new Request(\`https:\${host}\`).url; }`,
  },
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'request-reassigned-url-to-slashless-special-scheme',
    source:
      "export function make() { let url = 'https://example.com/'; url = 'https:example.com'; return new Request(url).url; }",
  },
  {
    expected: BLOB_ENDINGS_REFUSAL,
    id: 'blob-spread-all-arguments',
    source:
      'export function make(args: [BlobPart[], BlobPropertyBag]) { return new Blob(...args).size; }',
  },
  {
    expected: BLOB_ENDINGS_REFUSAL,
    id: 'blob-spread-tuple-literal',
    source: String.raw`export function make() { const args = [['\n'], { endings: 'native' }] as const; return new Blob(...args).size; }`,
  },
  {
    expected: BLOB_ENDINGS_REFUSAL,
    id: 'blob-options-custom-proto-native-endings',
    source: String.raw`export function make() { return new Blob(['\n'], { type: 'text/plain', __proto__: { endings: 'native' } } as BlobPropertyBag).size; }`,
  },
  {
    expected: TIMED_FILE_REFUSAL,
    id: 'file-parameter-default-reads-later-reassigned-stamp',
    source:
      "export function make() { let stamp: number | undefined = 0; function build(value = new File([], 'x', { lastModified: stamp }).lastModified) { return value; } stamp = undefined; return build(); }",
  },
  {
    expected: REQUEST_URL_REFUSAL,
    id: 'request-parameter-default-reads-later-reassigned-url',
    source:
      "export function make() { let url = 'https://example.com/'; const build = (value = new Request(url).url) => value; url = '/relative'; return build(); }",
  },
  {
    expected: EVENT_TIMESTAMP_REFUSAL,
    id: 'event-timestamp-from-array-element',
    source:
      "export function make() { const events = [new Event('x')]; return events[0].timeStamp; }",
  },
  {
    expected: EVENT_TIMESTAMP_REFUSAL,
    id: 'event-timestamp-from-inline-object-property',
    source: "export function make() { return ({ event: new Event('x') }).event.timeStamp; }",
  },
  {
    expected: EVENT_TIMESTAMP_REFUSAL,
    id: 'event-timestamp-from-reassigned-local-variable',
    source:
      "export function make() { let event: Event | { timeStamp: number } = { timeStamp: 0 }; event = new Event('x'); return event.timeStamp; }",
  },
  {
    expected: EVENT_TIMESTAMP_REFUSAL,
    id: 'event-timestamp-from-destructured-array-binding',
    source: "export function make() { const [event] = [new Event('x')]; return event.timeStamp; }",
  },
  {
    expected: EVENT_TIMESTAMP_REFUSAL,
    id: 'event-timestamp-from-pushed-array-element',
    source:
      "export function make() { const events: (Event | { timeStamp: number })[] = []; events.push(new Event('x')); return events[0]!.timeStamp; }",
  },
  {
    expected: undefined,
    id: 'request-constructor-alias-valid-https-url-pin',
    source:
      "const MakeRequest = Request; export function make() { return new MakeRequest('https://example.com/api').url; }",
  },
  {
    expected: undefined,
    id: 'blob-constructor-alias-transparent-options-pin',
    source: String.raw`const MakeBlob = Blob; export function make() { return new MakeBlob(['\n'], { endings: 'transparent', type: 'text/plain' }).size; }`,
  },
  {
    expected: undefined,
    id: 'request-non-special-data-url-pin',
    source: "export function make() { return new Request('data:text/plain,hello').url; }",
  },
  {
    expected: undefined,
    id: 'request-triple-slash-file-url-pin',
    source: "export function make() { return new Request('file:///tmp/report').url; }",
  },
  {
    expected: undefined,
    id: 'request-https-template-prefix-pin',
    source: `export function make(host: string) { return new Request(\`https://\${host}/api\`).url; }`,
  },
  {
    expected: undefined,
    id: 'parameter-default-reassigned-after-call-pin',
    source:
      "export function make() { let stamp: number | undefined = 0; function build(value = new File([], 'x', { lastModified: stamp }).lastModified) { return value; } const result = build(); stamp = undefined; return result; }",
  },
  {
    expected: undefined,
    id: 'plain-object-timestamp-in-array-and-parameter-pin',
    source:
      'function read(data: { timeStamp: number }) { return data.timeStamp; } export function make() { const items = [{ timeStamp: 0 }]; return items[0].timeStamp + read({ timeStamp: 1 }); }',
  },
  {
    expected: undefined,
    id: 'local-shadow-event-class-in-container-pin',
    source:
      'class Event { timeStamp = 0; } export function make() { const items = [new Event()]; return items[0].timeStamp; }',
  },
  {
    expected: EVENT_TIMESTAMP_REFUSAL,
    id: 'event-timestamp-self-reassigning-linked-projection-bounded',
    source:
      'export function last(first: { next?: unknown; timeStamp: number }) { let current: any = first; while (current.next) { current = current.next; } return current.timeStamp; }',
  },
  {
    expected: EVENT_TIMESTAMP_REFUSAL,
    id: 'event-timestamp-self-reassigning-element-projection-bounded',
    source:
      "export function walk(root: Record<string, any>) { let node = root; while (node['child']) { node = node['child']; } return node.timeStamp; }",
  },
  {
    expected: EVENT_TIMESTAMP_REFUSAL,
    id: 'event-timestamp-after-empty-prefix-spread-in-array',
    source:
      "export function make(prefix: Event[]) { const events = [...prefix, new Event('x')]; return events[0]!.timeStamp; }",
  },
  {
    expected: EVENT_TIMESTAMP_REFUSAL,
    id: 'event-timestamp-after-empty-literal-spread-in-array',
    source:
      "export function make() { const empty: Event[] = []; const events = [...empty, new Event('x')]; return events[0]!.timeStamp; }",
  },
  {
    expected: EVENT_TIMESTAMP_REFUSAL,
    id: 'event-timestamp-after-prefix-spread-in-helper-call',
    source:
      "function read(first: { timeStamp: number }) { return first.timeStamp; } export function make(prefix: { timeStamp: number }[]) { return (read as (...args: unknown[]) => number)(...prefix, new Event('x')); }",
  },
  {
    expected: EVENT_TIMESTAMP_REFUSAL,
    id: 'event-timestamp-from-nullish-assigned-local-variable',
    source:
      "export function make() { let event: Event | undefined; event ??= new Event('x'); return event.timeStamp; }",
  },
  {
    expected: EVENT_TIMESTAMP_REFUSAL,
    id: 'event-timestamp-from-logical-or-assigned-local-variable',
    source:
      "export function make(seed?: Event) { let event: Event | undefined = seed; event ||= new Event('x'); return event.timeStamp; }",
  },
  {
    expected: EVENT_TIMESTAMP_REFUSAL,
    id: 'event-timestamp-from-logical-and-assigned-local-variable',
    source:
      "export function make() { let event: Event | { timeStamp: number } = { timeStamp: 0 }; event &&= new Event('x'); return event.timeStamp; }",
  },
  {
    expected: EVENT_TIMESTAMP_REFUSAL,
    id: 'event-timestamp-from-nullish-assigned-object-member',
    source:
      "export function make() { const box: { event?: Event } = {}; box.event ??= new Event('x'); return box.event.timeStamp; }",
  },
  {
    expected: EVENT_TIMESTAMP_REFUSAL,
    id: 'event-timestamp-from-inline-nullish-assignment',
    source: "export function make(event?: Event) { return (event ??= new Event('x')).timeStamp; }",
  },
  {
    expected: EVENT_TIMESTAMP_REFUSAL,
    id: 'event-timestamp-read-via-nullish-member-assignment',
    source:
      "export function make() { const ev: { timeStamp?: number } = new Event('x'); ev.timeStamp ??= 0; return 1; }",
  },
  {
    expected: undefined,
    id: 'plain-timestamp-fixed-element-before-event-spread-pin',
    source:
      "export function make() { const events = [{ timeStamp: 0 }, ...[new Event('x')]]; return events[0]!.timeStamp; }",
  },
  {
    expected: undefined,
    id: 'plain-timestamp-cyclic-alias-without-projection-pin',
    source:
      'export function make(flag: boolean) { let a = { timeStamp: 1 }; let b = { timeStamp: 2 }; if (flag) { a = b; b = a; } return a.timeStamp; }',
  },
] as const;

describe('platform constructor aliases, base-independent URLs, Blob options, and Event timestamps', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module exercising platform and timestamp checks. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'platform-url-blob-and-events.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
