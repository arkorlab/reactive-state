import { isIdentifier, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { multipartMaking } from '../src/compiler/multipart.ts';

const MULTIPART_REASON =
  'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random';

const CASES = [
  {
    body: "function makeInit(body: BodyInit) { return { method: 'POST', body }; } return new Request('https://example.com/', makeInit(new FormData()));",
    expected: MULTIPART_REASON,
    id: 'options-factory-given-form-data',
  },
  {
    body: "function makeInit(body: BodyInit) { return { body }; } const form = new FormData(); return new Request('https://example.com/', makeInit(form));",
    expected: MULTIPART_REASON,
    id: 'options-factory-given-variable-holding-form-data',
  },
  {
    body: "const makeInit = (body: BodyInit) => ({ method: 'POST', body }); return new Request('https://example.com/', makeInit(new FormData()));",
    expected: MULTIPART_REASON,
    id: 'arrow-options-factory-given-form-data',
  },
  {
    body: "function makeInit(body: BodyInit) { return { body }; } return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...makeInit(new FormData()) });",
    expected: MULTIPART_REASON,
    id: 'spread-of-options-factory-given-form-data-keeps-earlier-candidate',
  },
  {
    body: "function wrap(opts: RequestInit) { return { ...opts, method: 'POST' }; } return new Request('https://example.com/', wrap({ body: new FormData() }));",
    expected: MULTIPART_REASON,
    id: 'options-wrapper-given-options-with-form-data',
  },
  {
    body: "function pick(flag: boolean, a: BodyInit, b: BodyInit) { return flag ? a : b; } return new Response(pick(flag, new FormData(), 'x'));",
    expected: MULTIPART_REASON,
    id: 'conditional-of-parameters-given-form-data',
  },
  {
    body: 'function pass(this: void, body: BodyInit) { return body; } return new Response(pass(new FormData()));',
    expected: MULTIPART_REASON,
    id: 'pass-through-with-explicit-this-parameter',
  },
  {
    body: 'function makeBody() { return new FormData(); } function pass(body: BodyInit) { return body; } return new Response(pass(makeBody()));',
    expected: MULTIPART_REASON,
    id: 'pass-through-given-factory-result',
  },
  {
    body: "function select(this: void, text: string, fallback: FormData) { return text; } return new Response(select('text', new FormData()));",
    expected: MULTIPART_REASON,
    id: 'helper-given-form-data-anywhere-is-refused-pin',
  },
  {
    body: "function normalize(body: BodyInit) { body = 'text'; return body; } return new Response(normalize(new FormData()));",
    expected: MULTIPART_REASON,
    id: 'helper-that-replaces-its-argument-is-refused-pin',
  },
  {
    body: 'function serialize(form: FormData) { return JSON.stringify([...form]); } const form = new FormData(); return new Response(serialize(form));',
    expected: MULTIPART_REASON,
    id: 'text-helper-given-form-data-is-refused-pin',
  },
  {
    body: "function makeInit(body: BodyInit) { return { body }; } return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...makeInit('text') });",
    expected: undefined,
    id: 'spread-of-options-factory-given-text-overwrites-earlier-form-data',
  },
  {
    body: "function makeInit(body: BodyInit) { return { method: 'POST', body }; } return new Request('https://example.com/', makeInit(JSON.stringify(1)));",
    expected: undefined,
    id: 'options-factory-given-text-from-a-native-call',
  },
  {
    body: "function makeInit(body: BodyInit) { return { method: 'POST', body }; } return new Request('https://example.com/', makeInit(readBody()));",
    expected: undefined,
    id: 'options-factory-given-unknown-call-result',
  },
  {
    body: "function wrap(opts: RequestInit) { return { ...opts, method: 'POST' }; } return new Request('https://example.com/', wrap({ body: 'text' }));",
    expected: undefined,
    id: 'options-wrapper-given-options-with-text',
  },
  {
    body: "function pick(flag: boolean, a: BodyInit, b: BodyInit) { return flag ? a : b; } return new Response(pick(flag, 'a', 'b'));",
    expected: undefined,
    id: 'conditional-of-parameters-given-text',
  },
  {
    body: "function makeBody() { return 'x'; } function pass(body: BodyInit) { return body; } return new Response(pass(makeBody()));",
    expected: undefined,
    id: 'pass-through-given-text-factory-result',
  },
] as const;

describe('multipart bodies and options that a source-written function is given', () => {
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
      'multipart-factory-arguments.ts',
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
