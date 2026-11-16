import { isIdentifier, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { multipartMaking } from '../src/compiler/multipart.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const MULTIPART_REASON =
  'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random';

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
