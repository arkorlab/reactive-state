import { isIdentifier, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { multipartMaking } from '../src/compiler/multipart.ts';

const MULTIPART_REASON =
  'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random';

const CASES = [
  {
    body: "return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...(flag ? { body: 'text' } : {}) });",
    expected: MULTIPART_REASON,
    id: 'ternary-empty-branch-after-form-data',
  },
  {
    body: "return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...(flag ? { body: 'text' } : { method: 'PUT' }) });",
    expected: MULTIPART_REASON,
    id: 'ternary-other-field-branch-after-form-data',
  },
  {
    body: "return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...(flag && { body: 'text' }) });",
    expected: MULTIPART_REASON,
    id: 'logical-and-spread-after-form-data',
  },
  {
    body: "return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...(extra ?? { body: 'text' }) });",
    expected: MULTIPART_REASON,
    id: 'nullish-coalescing-unknown-spread-after-form-data',
  },
  {
    body: "const base = { method: 'POST', body: new FormData() }; return new Request('https://example.com/', { ...base, ...(flag ? { body: 'text' } : {}) });",
    expected: MULTIPART_REASON,
    id: 'spread-base-form-data-with-conditional-override',
  },
  {
    body: "const override = flag ? { body: 'text' } : null; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...override });",
    expected: MULTIPART_REASON,
    id: 'nested-conditional-spread-after-form-data',
  },
  {
    body: "return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...{ body: 'fixed' } });",
    expected: undefined,
    id: 'unconditional-spread-override',
  },
  {
    body: "return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...(flag ? { body: 'a' } : { body: 'b' }) });",
    expected: undefined,
    id: 'both-ternary-branches-override',
  },
  {
    body: "return new Request('https://example.com/', { method: 'POST', ...{ body: new FormData() }, body: 'fixed' });",
    expected: undefined,
    id: 'direct-body-after-form-data-spread',
  },
  {
    body: "return new Request('https://example.com/', { method: 'POST', body: 'fixed', ...(flag ? { body: new FormData() } : {}) });",
    expected: MULTIPART_REASON,
    id: 'conditional-spread-introducing-form-data',
  },
] as const;

describe('multipart request body retention across conditional spreads', () => {
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
      'multipart-conditional-spreads.ts',
      `export function build(flag: boolean, extra?: RequestInit): Request { ${body} }
`,
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
