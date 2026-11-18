import { isIdentifier, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { multipartMaking } from '../src/compiler/multipart.ts';

const MULTIPART_REASON =
  'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random';

const CASES = [
  {
    body: "options.body = new FormData(); return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'parameter-options-body-assigned-form-data',
  },
  {
    body: "options['body'] = new FormData(); return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'parameter-options-bracket-body-assigned-form-data',
  },
  {
    body: "(options as Record<string, unknown>)[key] = new FormData(); return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'parameter-options-dynamic-key-assigned-form-data',
  },
  {
    body: "Object.assign(options, { body: new FormData() }); return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'parameter-options-object-assign-literal-form-data',
  },
  {
    body: "const extra: RequestInit = { body: new FormData() }; Object.assign(options, extra); return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'parameter-options-object-assign-variable-form-data',
  },
  {
    body: "Object.defineProperty(options, 'body', { value: new FormData() }); return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'parameter-options-define-property-form-data',
  },
  {
    body: "options.body = new FormData(); return new Request('https://example.com/', { method: 'POST', ...options });",
    expected: MULTIPART_REASON,
    id: 'parameter-options-mutated-then-spread',
  },
  {
    body: "const alias = options; alias.body = new FormData(); return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'parameter-options-mutated-through-const-alias',
  },
  {
    body: "const alias = options; options.body = new FormData(); return new Request('https://example.com/', alias);",
    expected: MULTIPART_REASON,
    id: 'parameter-options-const-alias-read-after-parameter-mutation',
  },
  {
    body: "options = { method: 'POST', body: new FormData() }; options.body = 'fixed'; return new Request('https://example.com/', options);",
    expected: undefined,
    id: 'parameter-options-reassigned-fresh-then-body-overwritten-with-text',
  },
  {
    body: "return new Request('https://example.com/', defaulted);",
    expected: MULTIPART_REASON,
    id: 'parameter-options-default-initializer-form-data',
  },
  {
    body: "(options as Record<string, unknown>).other = new FormData(); return new Request('https://example.com/', options);",
    expected: undefined,
    id: 'parameter-options-unrelated-member-write',
  },
  {
    body: "const request = new Request('https://example.com/', options); options.body = new FormData(); return request;",
    expected: undefined,
    id: 'parameter-options-body-mutated-after-request',
  },
  {
    body: "options.body = new FormData(); options = { method: 'POST', body: 'fixed' }; return new Request('https://example.com/', options);",
    expected: undefined,
    id: 'parameter-options-mutated-then-rebound-to-text',
  },
  {
    body: "options = { method: 'POST', body: new FormData() }; return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'parameter-options-rebound-to-form-data',
  },
] as const;

describe('multipart tracking across parameter options member writes and mutators', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Reads `multipartMaking` on the `new Request(...)` construction in `body`. */
  function multipartOf(body: string): string | undefined {
    using parsed = api.createSourceFile(
      'multipart-parameter-writes.ts',
      `export function build(options: RequestInit, key: string, defaulted: RequestInit = { method: 'POST', body: new FormData() }): Request { ${body} }\n`,
    );
    let target: NewExpression | undefined;
    const pending: Node[] = [parsed.sourceFile];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (isNewExpression(at) && isIdentifier(at.expression) && at.expression.text === 'Request') {
        target = at;
      }
      at.forEachChild((child) => {
        pending.push(child);
      });
    }
    if (target === undefined) {
      throw new Error(`No Request construction found in ${body}.`);
    }
    return multipartMaking(target, 'Request');
  }

  it.each(CASES)('$id', ({ body, expected }) => {
    expect(multipartOf(body)).toBe(expected);
  });
});
