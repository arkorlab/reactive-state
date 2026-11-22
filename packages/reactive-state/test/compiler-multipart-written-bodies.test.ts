import { isIdentifier, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { multipartMaking } from '../src/compiler/multipart.ts';

const MULTIPART_REASON =
  'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random';

const CASES = [
  {
    body: "let body: BodyInit = 'fixed'; body = new FormData(); return new Response(body);",
    expected: MULTIPART_REASON,
    id: 'reassigned-response-to-form-data',
  },
  {
    body: "let body: BodyInit = new FormData(); body = 'fixed'; return new Response(body);",
    expected: undefined,
    id: 'reassigned-response-from-form-data-to-text',
  },
  {
    body: "let body: BodyInit = 'fixed'; if (flag) { body = new FormData(); } return new Response(body);",
    expected: MULTIPART_REASON,
    id: 'conditional-reassigned-response-to-form-data',
  },
  {
    body: "let body: BodyInit = 'fixed'; [body] = [new FormData()]; return new Response(body);",
    expected: MULTIPART_REASON,
    id: 'destructured-reassigned-response-to-form-data',
  },
  {
    body: "let options: RequestInit = { method: 'POST', body: 'fixed' }; options = { method: 'POST', body: new FormData() }; return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'reassigned-request-options-to-form-data',
  },
  {
    body: "let options: RequestInit = { method: 'POST', body: new FormData() }; options = { method: 'POST', body: 'fixed' }; return new Request('https://example.com/', options);",
    expected: undefined,
    id: 'reassigned-request-options-from-form-data-to-text',
  },
  {
    body: "const options: RequestInit = { method: 'POST' }; options.body = new FormData(); return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'mutated-request-options-body-to-form-data',
  },
  {
    body: "const options: RequestInit = { method: 'POST', body: new FormData() }; options.body = 'fixed'; return new Request('https://example.com/', options);",
    expected: undefined,
    id: 'mutated-request-options-body-from-form-data-to-text',
  },
  {
    body: "const options: RequestInit = { method: 'POST' }; Object.assign(options, { body: new FormData() }); return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'object-assign-request-options-form-data',
  },
  {
    body: "let key = 'other'; key = 'body'; return new Request('https://example.com/', { method: 'POST', [key]: new FormData() });",
    expected: MULTIPART_REASON,
    id: 'reassigned-computed-key-to-body',
  },
  {
    body: 'plainParam = new FormData(); return new Response(plainParam);',
    expected: MULTIPART_REASON,
    id: 'reassigned-parameter-to-form-data',
  },
  {
    body: "multipartParam = 'fixed'; return new Response(multipartParam);",
    expected: undefined,
    id: 'reassigned-parameter-from-form-data-to-text',
  },
  {
    body: 'const body = new FormData(); return new Response(body);',
    expected: MULTIPART_REASON,
    id: 'const-response-form-data-alias',
  },
  {
    body: 'return new Response(multipartParam);',
    expected: MULTIPART_REASON,
    id: 'unmodified-multipart-parameter',
  },
  {
    body: "let body: BodyInit = new FormData(); if (flag) { body = 'fixed'; } return new Response(body);",
    expected: MULTIPART_REASON,
    id: 'conditional-overwrite-retains-initial-form-data',
  },
  {
    body: "let body: BodyInit = new FormData(); const options: RequestInit = { method: 'POST', body }; body = 'fixed'; return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'captured-before-reassignment-retains-form-data',
  },
  {
    body: "const options: Record<string, unknown> = { method: 'POST', body: 'fixed' }; options.other = new FormData(); return new Request('https://example.com/', options as RequestInit);",
    expected: undefined,
    id: 'mutated-other-request-option',
  },
] as const;

describe('multipart body and options tracking across assignments and mutations', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Reads `multipartMaking` on the `new Request(...)` or `new Response(...)` construction in `body`. */
  function multipartOf(body: string): string | undefined {
    using parsed = api.createSourceFile(
      'multipart-written-bodies.ts',
      `export function build(flag: boolean, plainParam: BodyInit, multipartParam: FormData | string): Request | Response { ${body} }
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
      throw new Error(`No Request or Response construction found in ${body}.`);
    }
    return multipartMaking(target.node, target.kind);
  }

  it.each(CASES)('$id', ({ body, expected }) => {
    expect(multipartOf(body)).toBe(expected);
  });
});
