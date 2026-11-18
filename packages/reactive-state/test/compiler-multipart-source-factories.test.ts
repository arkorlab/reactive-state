import { isIdentifier, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { multipartMaking } from '../src/compiler/multipart.ts';

const MULTIPART_REASON =
  'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random';

const CASES = [
  {
    body: 'function makeBody() { return new FormData(); } return new Response(makeBody());',
    expected: MULTIPART_REASON,
    id: 'response-of-function-declaration-factory',
  },
  {
    body: 'const makeBody = () => new FormData(); return new Response(makeBody());',
    expected: MULTIPART_REASON,
    id: 'response-of-constant-arrow-factory',
  },
  {
    body: 'const makeBody = function () { return new FormData(); }; return new Response(makeBody());',
    expected: MULTIPART_REASON,
    id: 'response-of-constant-function-expression-factory',
  },
  {
    body: 'const factories = { make() { return new FormData(); } }; return new Response(factories.make());',
    expected: MULTIPART_REASON,
    id: 'response-of-literal-method-factory',
  },
  {
    body: 'function makeBody() { return new FormData(); } const body = makeBody(); return new Response(body);',
    expected: MULTIPART_REASON,
    id: 'response-of-variable-holding-factory-result',
  },
  {
    body: "function makeBody() { const form = new FormData(); form.append('a', 'b'); return form; } return new Response(makeBody());",
    expected: MULTIPART_REASON,
    id: 'response-of-factory-that-fills-a-local-form',
  },
  {
    body: "function makeBody(flag: boolean) { if (flag) { return 'text'; } return new FormData(); } return new Response(makeBody(flag));",
    expected: MULTIPART_REASON,
    id: 'response-of-factory-with-a-form-data-branch',
  },
  {
    body: 'function inner() { return new FormData(); } function outer() { return inner(); } return new Response(outer());',
    expected: MULTIPART_REASON,
    id: 'response-of-factory-of-a-factory',
  },
  {
    body: 'function pass(value: BodyInit) { return value; } return new Response(pass(new FormData()));',
    expected: MULTIPART_REASON,
    id: 'response-of-pass-through-of-form-data-argument',
  },
  {
    body: "function makeInit() { return { method: 'POST', body: new FormData() }; } return new Request('https://example.com/', makeInit());",
    expected: MULTIPART_REASON,
    id: 'request-options-from-factory',
  },
  {
    body: "function makeInit() { const init: RequestInit = { method: 'POST' }; init.body = new FormData(); return init; } return new Request('https://example.com/', makeInit());",
    expected: MULTIPART_REASON,
    id: 'request-options-factory-assigns-form-data-body',
  },
  {
    body: "const makeInit = () => ({ method: 'POST', body: new FormData() }); const init = makeInit(); return new Request('https://example.com/', { ...init });",
    expected: MULTIPART_REASON,
    id: 'request-options-spread-of-factory-result',
  },
  {
    body: "function makeBody() { return 'text'; } return new Response(makeBody());",
    expected: undefined,
    id: 'response-of-text-factory',
  },
  {
    body: 'function makeBody() { return JSON.stringify({ a: 1 }); } return new Response(makeBody());',
    expected: undefined,
    id: 'response-of-json-factory',
  },
  {
    body: 'function pass(value: BodyInit) { return value; } return new Response(pass(JSON.stringify(1)));',
    expected: undefined,
    id: 'response-of-pass-through-of-text-argument',
  },
  {
    body: 'return new Response(readBody());',
    expected: undefined,
    id: 'response-of-unknown-call',
  },
  {
    body: 'async function makeBody() { return new FormData(); } return new Response(makeBody());',
    expected: undefined,
    id: 'response-of-async-factory-is-a-promise',
  },
  {
    body: 'function* makeBody() { yield new FormData(); } return new Response(makeBody());',
    expected: undefined,
    id: 'response-of-generator-factory-is-an-iterator',
  },
  {
    body: 'function makeBody(): BodyInit { return makeBody(); } return new Response(makeBody());',
    expected: undefined,
    id: 'self-recursive-factory-terminates',
  },
  {
    body: "function makeInit() { return { method: 'POST', body: 'text' }; } return new Request('https://example.com/', makeInit());",
    expected: undefined,
    id: 'request-options-factory-with-text-body',
  },
  {
    body: "function makeInit() { return { method: 'POST' }; } return new Request('https://example.com/', makeInit());",
    expected: undefined,
    id: 'request-options-factory-without-body',
  },
  {
    body: 'return new Response(new FormData());',
    expected: MULTIPART_REASON,
    id: 'direct-form-data-pin',
  },
] as const;

/** `n` factories, each returning the previous one's result from both branches of a conditional. */
function factoryDiamond(count: number): string {
  const lines = ['function f0() { return new FormData(); }'];
  for (let index = 1; index <= count; index += 1) {
    const previous = `f${String(index - 1)}`;
    lines.push(
      `function f${String(index)}(): BodyInit { return flag ? ${previous}() : ${previous}(); }`,
    );
  }
  return `${lines.join(' ')} return new Response(f${String(count)}());`;
}

const DIAMOND_DEPTH = 40;

describe('multipart bodies and options returned by source-written functions', () => {
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
      'multipart-source-factories.ts',
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

  it('follows a conditional diamond of factories without repeating work', () => {
    expect(multipartOf(factoryDiamond(DIAMOND_DEPTH))).toBe(MULTIPART_REASON);
  });
});
