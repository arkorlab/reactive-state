import { isIdentifier, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { multipartMaking } from '../src/compiler/multipart.ts';

const MULTIPART_REASON =
  'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random';

const CASES = [
  {
    body: "function makeInit(flag: boolean) { if (flag) return { body: 'text' }; } return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...makeInit(flag) });",
    expected: MULTIPART_REASON,
    id: 'spread-of-factory-that-falls-through-keeps-earlier-form-data',
  },
  {
    body: "function makeInit(flag: boolean) { if (!flag) { return; } return { body: 'text' }; } return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...makeInit(flag) });",
    expected: MULTIPART_REASON,
    id: 'spread-of-factory-with-bare-return-keeps-earlier-form-data',
  },
  {
    body: "function makeInit(kind: string) { switch (kind) { case 'a': return { body: 'text' }; } } return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...makeInit('b') });",
    expected: MULTIPART_REASON,
    id: 'spread-of-factory-with-open-switch-keeps-earlier-form-data',
  },
  {
    body: "function makeInit() { return { body: 'text' }; } return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...makeInit() });",
    expected: MULTIPART_REASON,
    id: 'spread-of-factory-keeps-earlier-form-data-by-the-coarse-rule-pin',
  },
  {
    body: "const makeInit = () => ({ body: 'text' }); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...makeInit() });",
    expected: MULTIPART_REASON,
    id: 'spread-of-arrow-factory-keeps-earlier-form-data-by-the-coarse-rule-pin',
  },
  {
    body: "function makeInit(flag: boolean) { if (flag) return { body: 'text' }; } const extra = makeInit(flag); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...extra });",
    expected: MULTIPART_REASON,
    id: 'spread-of-variable-holding-factory-result-keeps-earlier-form-data',
  },
  {
    body: "function makeInit() { return { method: 'POST' }; } return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...makeInit() });",
    expected: MULTIPART_REASON,
    id: 'spread-of-factory-without-body-keeps-earlier-form-data-pin',
  },
  {
    body: "function makeInit(flag: boolean) { if (flag) return { body: new FormData() }; } return new Request('https://example.com/', { method: 'POST', ...makeInit(flag) });",
    expected: MULTIPART_REASON,
    id: 'spread-of-factory-that-may-return-form-data-pin',
  },
  {
    body: "function makeInit(flag: boolean) { if (flag) return { body: 'text' }; } return new Request('https://example.com/', makeInit(flag));",
    expected: undefined,
    id: 'options-from-factory-that-falls-through-without-earlier-body',
  },
  {
    body: "function makeInit(flag: boolean) { if (flag) return { body: 'text' }; } return new Request('https://example.com/', { method: 'POST', body: 'text', ...makeInit(flag) });",
    expected: undefined,
    id: 'spread-of-factory-after-an-earlier-text-body',
  },
] as const;

describe('multipart options spread from a factory that may return nothing', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `multipartMaking` on the last `Request` or `Response` construction in `body`. */
  function multipartOf(body: string): string | undefined {
    using parsed = api.createSourceFile(
      'multipart-factory-fallthrough.ts',
      `declare function readBody(): BodyInit;\nexport function build(flag: boolean): unknown { void flag; ${body} }\n`,
    );
    let target: NewExpression | undefined;
    const pending: Node[] = [parsed.sourceFile];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (
        isNewExpression(at) &&
        isIdentifier(at.expression) &&
        (at.expression.text === 'Request' || at.expression.text === 'Response') &&
        (target === undefined || at.pos > target.pos)
      ) {
        target = at;
      }
      at.forEachChild((child) => {
        pending.push(child);
      });
    }
    if (target === undefined || !isIdentifier(target.expression)) {
      throw new Error(`No Request or Response construction found in ${body}.`);
    }
    return multipartMaking(target, target.expression.text);
  }

  it.each(CASES)('$id', ({ body, expected }) => {
    expect(multipartOf(body)).toBe(expected);
  });
});
