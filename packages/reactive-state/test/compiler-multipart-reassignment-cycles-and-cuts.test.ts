import { isIdentifier, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { multipartMaking } from '../src/compiler/multipart.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const MULTIPART_REASON =
  'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random';

const DIAMOND_LEVELS = 30;

/** Builds 30 conditional descriptor alias declarations `d1`..`d30` starting from `seed`. */
function descriptorAliasDiamond(seed: string): string {
  const lines = [`const d0 = ${seed};`];
  for (let index = 1; index <= DIAMOND_LEVELS; index += 1) {
    const previous = `d${String(index - 1)}`;
    lines.push(`const d${String(index)} = flag ? ${previous} : ${previous};`);
  }
  return lines.join(' ');
}

const CASES = [
  {
    expected: MULTIPART_REASON,
    id: 'destructured-parameter-direct-form-data-reassignment',
    source:
      'export function build({ body }: { body: BodyInit }) { body = new FormData(); return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'destructured-parameter-conditional-form-data-reassignment',
    source:
      'export function build({ body }: { body: BodyInit }, flag: boolean) { if (flag) { body = new FormData(); } return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'destructured-parameter-projected-sub-key-reassignment',
    source:
      "export function build({ body }: { body: BodyInit }) { const src = { sub: new FormData() }; body = 'fixed'; ({ sub: body } = src); return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'destructured-array-parameter-direct-form-data-reassignment',
    source:
      'export function build([body]: [BodyInit]) { body = new FormData(); return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'destructured-box-parameter-reassigned-then-destructured',
    source:
      'export function build({ box }: { box: { body: BodyInit } }) { box = { body: new FormData() }; const { body } = box; return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'destructured-options-parameter-member-write-form-data',
    source:
      "export function build({ options }: { options: RequestInit }) { options.body = new FormData(); return new Request('https://example.com/', options); }",
  },
  {
    expected: undefined,
    id: 'destructured-typed-form-data-parameter-replaced-with-string-pin',
    source:
      "export function build({ body }: { body: FormData | string }) { body = 'fixed'; return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'destructured-parameter-outer-default-form-data-pin',
    source:
      'export function build({ body }: { body?: BodyInit } = { body: new FormData() }) { return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'destructured-typed-form-data-parameter-unmodified-pin',
    source:
      'export function build({ body }: { body: FormData | string }) { return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'self-referential-let-cursor-next-destructured-response',
    source:
      'export function build(head: { body: BodyInit; next?: any }) { let cursor = head; cursor = cursor.next!; const { body } = cursor; return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'self-referential-parameter-inner-destructured-response',
    source:
      'export function build(opts: { body?: BodyInit; inner?: any }) { opts = opts.inner; const { body } = opts; return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'self-referential-object-pattern-parameter-request',
    source:
      "export function build(a: any) { ({ body: a } = a); return new Request('https://example.com/', a); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'self-referential-array-pattern-parameter-response',
    source:
      'export function build(a: any) { [a] = a; const { body } = a; return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'mutually-recursive-let-holders-destructured-response',
    source:
      'export function build(seed: any) { let a = seed; let b = seed; a = b.next; b = a.next; const { body } = a; return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'deep-member-projection-exceeding-depth-cap-refused',
    source:
      'export function build(root: any) { const { n1 } = root; const { n2 } = n1; const { n3 } = n2; const { n4 } = n3; const { n5 } = n4; const { n6 } = n5; const { n7 } = n6; const { n8 } = n7; const { n9 } = n8; const { n10 } = n9; const { n11 } = n10; const { n12 } = n11; const { n13 } = n12; const { n14 } = n13; const { n15 } = n14; const { n16 } = n15; const { n17 } = n16; const { n18 } = n17; return new Response(n18); }',
  },
  {
    expected: undefined,
    id: 'self-referential-request-spread-overwritten-by-later-fixed-body-pin',
    source:
      "export function build(a: any) { ({ body: a } = a); return new Request('https://example.com/', { ...a, method: 'POST', body: 'fixed' }); }",
  },
  {
    expected: undefined,
    id: 'non-cyclic-diamond-member-projection-allowed-pin',
    source:
      "export function build(flag: boolean) { const leaf = { body: 'fixed' }; const left = { inner: leaf }; const right = { inner: leaf }; const chosen = flag ? left : right; const { inner } = chosen; const { body } = inner; return new Response(body); }",
  },
  {
    expected: undefined,
    id: 'same-pattern-sibling-default-projection-allowed-pin',
    source:
      "export function build(input: { a?: { body: string }; b?: { body: string } }) { const { a = { body: 'fixed' }, b = a } = input; const { body } = b; return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'computed-key-const-alias-form-data-after-parameter-cut',
    source:
      "export function build(body: BodyInit, key: string) { const replacement = { first: new FormData(), second: 'fixed' }; body = 'fixed'; ({ [key]: body } = replacement); return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'computed-key-let-reassigned-alias-form-data-after-parameter-cut',
    source:
      "export function build(body: BodyInit, key: string) { let replacement: Record<string, BodyInit> = { first: 'one' }; replacement = { first: 'one', second: new FormData() }; body = 'fixed'; ({ [key]: body } = replacement); return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'computed-key-member-mutated-alias-form-data-into-local-let',
    source:
      "export function build(key: string) { let body: BodyInit = 'fixed'; const replacement: Record<string, BodyInit> = { first: 'one' }; replacement.second = new FormData(); ({ [key]: body } = replacement); return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'computed-key-nested-projected-alias-form-data',
    source:
      "export function build(body: BodyInit, key: string) { const holder = { replacement: { first: 'fixed', second: new FormData() } }; body = 'fixed'; ({ replacement: { [key]: body } } = holder); return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'computed-key-spread-object-alias-form-data',
    source:
      "export function build(body: BodyInit, key: string) { const base = { first: new FormData() }; const replacement = { ...base, second: 'fixed' }; body = 'fixed'; ({ [key]: body } = replacement); return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'computed-key-opaque-parameter-source-after-plain-parameter-cut',
    source:
      "export function build(body: BodyInit, source: Record<string, BodyInit>, key: string) { body = 'fixed'; ({ [key]: body } = source); return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'array-spread-second-element-form-data-after-parameter-cut',
    source:
      "export function build(body: BodyInit) { const items = ['fixed', new FormData()]; const wrapped = [...items]; body = 'fixed'; [, body] = wrapped; return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'array-spread-after-prefix-element-form-data',
    source:
      "export function build(body: BodyInit) { const items = ['fixed', new FormData()]; const wrapped = ['prefix', ...items]; body = 'fixed'; [, , body] = wrapped; return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'array-spread-after-unknown-spread-second-element-form-data',
    source:
      "export function build(body: BodyInit, prefix: string[]) { const items = ['fixed', new FormData()]; const wrapped = [...prefix, ...items]; body = 'fixed'; [, body] = wrapped; return new Response(body); }",
  },
  {
    expected: undefined,
    id: 'computed-key-const-alias-strings-only-allowed-pin',
    source:
      "export function build(body: BodyInit, key: string) { const replacement = { first: 'one', second: 'two' }; body = 'fixed'; ({ [key]: body } = replacement); return new Response(body); }",
  },
  {
    expected: undefined,
    id: 'array-spread-exact-second-element-skips-first-form-data-pin',
    source:
      "export function build(body: BodyInit) { const items = [new FormData(), 'fixed']; const wrapped = [...items]; body = 'fixed'; [, body] = wrapped; return new Response(body); }",
  },
  {
    expected: undefined,
    id: 'array-spread-after-requested-first-element-ignored-pin',
    source:
      "export function build(body: BodyInit) { const items = [new FormData()]; const wrapped = ['fixed', ...items]; body = 'fixed'; [body] = wrapped; return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'array-spread-first-element-form-data-pin',
    source:
      "export function build(body: BodyInit) { const items = [new FormData(), 'fixed']; const wrapped = [...items]; body = 'fixed'; [body] = wrapped; return new Response(body); }",
  },
  {
    expected: undefined,
    id: 'writable-define-property-form-data-superseded-by-direct-body-write',
    source:
      "export function build() { const opts: RequestInit = { method: 'POST' }; Object.defineProperty(opts, 'body', { value: new FormData(), writable: true }); opts.body = 'fixed'; return new Request('https://example.com/', opts); }",
  },
  {
    expected: undefined,
    id: 'writable-define-properties-form-data-superseded-by-direct-body-write',
    source:
      "export function build() { const opts: RequestInit = { method: 'POST' }; Object.defineProperties(opts, { body: { value: new FormData(), writable: true } }); opts.body = 'fixed'; return new Request('https://example.com/', opts); }",
  },
  {
    expected: undefined,
    id: 'writable-define-property-form-data-superseded-by-object-assign',
    source:
      "export function build() { const opts: RequestInit = { method: 'POST' }; Object.defineProperty(opts, 'body', { value: new FormData(), writable: true }); Object.assign(opts, { body: 'fixed' }); return new Request('https://example.com/', opts); }",
  },
  {
    expected: undefined,
    id: 'configurable-define-property-form-data-superseded-by-redefinition',
    source:
      "export function build() { const opts: RequestInit = { method: 'POST' }; Object.defineProperty(opts, 'body', { value: new FormData(), configurable: true }); Object.defineProperty(opts, 'body', { value: 'fixed' }); return new Request('https://example.com/', opts); }",
  },
  {
    expected: undefined,
    id: 'let-define-property-form-data-superseded-by-whole-variable-rebind',
    source:
      "export function build() { let opts: RequestInit = { method: 'POST' }; Object.defineProperty(opts, 'body', { value: new FormData() }); opts = { method: 'POST', body: 'fixed' }; return new Request('https://example.com/', opts); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'parameter-non-writable-define-property-not-cut-by-direct-body-write',
    source:
      "export function build(opts: RequestInit) { opts = { method: 'POST' }; Object.defineProperty(opts, 'body', { value: new FormData() }); opts.body = 'fixed'; return new Request('https://example.com/', opts); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'non-writable-define-property-on-const-not-cut-by-direct-body-write-pin',
    source:
      "export function build() { const opts: RequestInit = { method: 'POST' }; Object.defineProperty(opts, 'body', { value: new FormData() }); opts.body = 'fixed'; return new Request('https://example.com/', opts); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'writable-non-enumerable-define-property-cut-still-withholds-spread-overwrite-pin',
    source:
      "export function build() { const opts: RequestInit = { method: 'POST' }; Object.defineProperty(opts, 'body', { value: 'initial', writable: true }); opts.body = 'fixed'; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...opts }); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'writable-define-property-conditional-body-write-retains-form-data-pin',
    source:
      "export function build(flag: boolean) { const opts: RequestInit = { method: 'POST' }; Object.defineProperty(opts, 'body', { value: new FormData(), writable: true }); if (flag) { opts.body = 'fixed'; } return new Request('https://example.com/', opts); }",
  },
  {
    expected: undefined,
    id: 'descriptor-conditional-alias-diamond-30-levels-fixed-pin',
    source: `export function build(flag: boolean) { const opts: RequestInit = { method: 'POST' }; ${descriptorAliasDiamond("{ value: 'fixed' }")} Object.defineProperty(opts, 'body', d30); return new Request('https://example.com/', opts); }`,
  },
  {
    expected: MULTIPART_REASON,
    id: 'descriptor-conditional-alias-diamond-30-levels-form-data',
    source: `export function build(flag: boolean) { const opts: RequestInit = { method: 'POST' }; ${descriptorAliasDiamond('{ value: new FormData() }')} Object.defineProperty(opts, 'body', d30); return new Request('https://example.com/', opts); }`,
  },
  {
    expected: MULTIPART_REASON,
    id: 'descriptor-cyclic-var-conditional-aliases-retain-form-data',
    source:
      "export function build(flag: boolean) { const opts: RequestInit = { method: 'POST' }; var d1: PropertyDescriptor = flag ? d2 : { value: new FormData() }; var d2: PropertyDescriptor = flag ? d1 : { value: 'fixed' }; Object.defineProperty(opts, 'body', d1); return new Request('https://example.com/', opts); }",
  },
  {
    expected: undefined,
    id: 'typed-box-parameter-definitely-replaced-with-string-literal-destructured',
    source:
      "export function build(box: { body: FormData | string }) { box = { body: 'fixed' }; const { body } = box; return new Response(body); }",
  },
  {
    expected: undefined,
    id: 'typed-nested-box-parameter-definitely-replaced-with-string-literal-destructured',
    source:
      "export function build(box: { inner: { body: FormData | string } }) { box = { inner: { body: 'fixed' } }; const { body } = box.inner; return new Response(body); }",
  },
  {
    expected: undefined,
    id: 'typed-box-let-variable-definitely-replaced-with-string-literal-destructured',
    source:
      "export function build() { let box: { body: FormData | string } = { body: new FormData() }; box = { body: 'fixed' }; const { body } = box; return new Response(body); }",
  },
  {
    expected: undefined,
    id: 'typed-box-parameter-replaced-by-plain-string-typed-parameter',
    source:
      'export function build(box: { body: FormData | string }, plain: { body: string }) { box = plain; const { body } = box; return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'typed-box-parameter-unreplaced-destructured-retains-type-fallback',
    source:
      'export function build(box: { body: FormData | string }) { const { body } = box; return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'typed-box-parameter-conditionally-replaced-destructured-retains-type-fallback',
    source:
      "export function build(box: { body: FormData | string }, flag: boolean) { if (flag) { box = { body: 'fixed' }; } const { body } = box; return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'typed-box-const-initialized-from-opaque-call-destructured-retains-type-fallback',
    source:
      'declare function getBox(): { body: FormData | string }; export function build() { const box: { body: FormData | string } = getBox(); const { body } = box; return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'typed-box-literal-with-opaque-call-body-destructured-retains-type-fallback',
    source:
      'declare function readBody(): FormData | string; export function build() { const box: { body: FormData | string } = { body: readBody() }; const { body } = box; return new Response(body); }',
  },
  {
    expected: undefined,
    id: 'typed-box-literal-with-fixed-string-body-destructured-not-flagged-pin',
    source:
      "export function build() { const box: { body: FormData | string } = { body: 'fixed' }; const { body } = box; return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'typed-nested-box-literal-with-opaque-call-body-destructured-flagged',
    source:
      'declare function readBody(): FormData | string; export function build() { const box: { inner: { body: FormData | string } } = { inner: { body: readBody() } }; const { body } = box.inner; return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'typed-parameter-box-replaced-with-opaque-call-body-destructured-flagged',
    source:
      'declare function readBody(): FormData | string; export function build(box: { body: FormData | string }) { box = { body: readBody() }; const { body } = box; return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'typed-direct-body-initialized-from-opaque-call-response-flagged',
    source:
      'declare function readBody(): FormData | string; export function build() { const body: FormData | string = readBody(); return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'typed-options-literal-with-opaque-call-body-request-flagged',
    source:
      "declare function readBody(): FormData | string; export function build() { const opts: { body: FormData | string } = { body: readBody() }; return new Request('https://example.com/', opts); }",
  },
  {
    expected: undefined,
    id: 'self-spread-let-object-reassignment-fixed-body-not-cyclic',
    source:
      "export function build() { let box = { body: 'fixed' }; box = { ...box }; const { body } = box; return new Response(body); }",
  },
  {
    expected: undefined,
    id: 'self-spread-chained-let-object-reassignments-fixed-body-not-cyclic',
    source:
      "export function build() { let box: { body: string; extra?: number } = { body: 'fixed' }; box = { ...box }; box = { ...box, extra: 1 }; const { body } = box; return new Response(body); }",
  },
  {
    expected: undefined,
    id: 'self-spread-array-reassignment-fixed-body-not-cyclic',
    source:
      "export function build() { let items = ['fixed']; items = [...items]; const [body] = items; return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'self-spread-let-object-reassignment-form-data-body-detected',
    source:
      'export function build() { let box = { body: new FormData() }; box = { ...box }; const { body } = box; return new Response(body); }',
  },
  {
    expected: MULTIPART_REASON,
    id: 'self-spread-while-loop-reassignment-handled-soundly',
    source:
      "export function build(flag: boolean) { let box = { body: 'fixed' }; while (flag) { box = { ...box }; } const { body } = box; return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'captured-sub-holder-before-rebind-retains-initial-form-data',
    source:
      "export function build() { let inner: { body: BodyInit } = { body: new FormData() }; const box = { inner }; inner = { body: 'fixed' }; const { body } = box.inner; return new Response(body); }",
  },
  {
    expected: undefined,
    id: 'typed-union-conditional-same-string-variable-diamond-response',
    source:
      "export function build(flag: boolean) { const text = 'fixed'; const body: FormData | string = flag ? text : text; return new Response(body); }",
  },
  {
    expected: undefined,
    id: 'typed-holder-projected-conditional-same-string-variable-diamond-response',
    source:
      "export function build(flag: boolean) { const text = 'fixed'; const box: { body: FormData | string } = { body: flag ? text : text }; const { body } = box; return new Response(body); }",
  },
  {
    expected: undefined,
    id: 'typed-union-deep-24-level-alias-diamond-response',
    source:
      "export function build(flag: boolean) { const m0 = 'fixed'; const m1 = flag ? m0 : m0; const m2 = flag ? m1 : m1; const m3 = flag ? m2 : m2; const m4 = flag ? m3 : m3; const m5 = flag ? m4 : m4; const m6 = flag ? m5 : m5; const m7 = flag ? m6 : m6; const m8 = flag ? m7 : m7; const m9 = flag ? m8 : m8; const m10 = flag ? m9 : m9; const m11 = flag ? m10 : m10; const m12 = flag ? m11 : m11; const m13 = flag ? m12 : m12; const m14 = flag ? m13 : m13; const m15 = flag ? m14 : m14; const m16 = flag ? m15 : m15; const m17 = flag ? m16 : m16; const m18 = flag ? m17 : m17; const m19 = flag ? m18 : m18; const m20 = flag ? m19 : m19; const m21 = flag ? m20 : m20; const m22 = flag ? m21 : m21; const m23 = flag ? m22 : m22; const m24 = flag ? m23 : m23; const body: FormData | string = m24; return new Response(body); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'typed-union-genuine-loop-comma-self-cycle-still-flagged-pin',
    source:
      "export function build(flag: boolean) { let text: FormData | string = 'fixed'; while (flag) { text = (0, text); } return new Response(text); }",
  },
  {
    expected: MULTIPART_REASON,
    id: 'typed-holder-mutual-loop-cycle-terminates-and-flags-pin',
    source:
      "export function build(flag: boolean) { let text: FormData | string = 'fixed'; let box: { v: FormData | string } = { v: 'fixed' }; while (flag) { box = { v: text }; text = box.v; } return new Response(text); }",
  },
] as const;

describe('multipart destructured parameter reassignments, expansion cycles, and descriptor cuts', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api.close();
  });

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(checkMultipartModule(api, source)).toBe(expected);
  });
});

/** Evaluates `multipartMaking` on the `Request` or `Response` construction in `source`. */
function checkMultipartModule(api: API, source: string): string | undefined {
  using parsed = parseModule(
    api,
    'multipart-reassignment-cycles-and-cuts.ts',
    `${source}
`,
  );
  let target: { readonly kind: 'Request' | 'Response'; readonly node: NewExpression } | undefined;
  const pending: Node[] = [parsed.sourceFile];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (
      isNewExpression(at) &&
      isIdentifier(at.expression) &&
      (at.expression.text === 'Request' || at.expression.text === 'Response')
    ) {
      target = { kind: at.expression.text, node: at };
    }
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  if (target === undefined) {
    throw new Error(`No Request or Response construction found in ${source}.`);
  }
  return multipartMaking(target.node, target.kind);
}
