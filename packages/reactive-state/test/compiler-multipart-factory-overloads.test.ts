import { isIdentifier, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { multipartMaking } from '../src/compiler/multipart.ts';

const MULTIPART_REASON =
  'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random';

const CASES = [
  {
    body: "function make(kind: 'form'): FormData; function make(kind: 'text'): string; function make(kind: string): BodyInit { return kind === 'form' ? new FormData() : 'x'; } return new Response(make('form'));",
    expected: MULTIPART_REASON,
    id: 'overloaded-factory-returning-form-data-in-its-implementation',
  },
  {
    body: "function make(kind: 'form'): FormData; function make(kind: 'text'): string; function make(kind: string): BodyInit { return kind === 'form' ? new FormData() : 'x'; } const body = make('form'); return new Response(body);",
    expected: MULTIPART_REASON,
    id: 'overloaded-factory-result-held-in-a-variable',
  },
  {
    body: "function makeInit(kind: 'form'): RequestInit; function makeInit(kind: 'text'): RequestInit; function makeInit(kind: string): RequestInit { return kind === 'form' ? { method: 'POST', body: new FormData() } : { method: 'POST', body: 'x' }; } return new Request('https://example.com/', makeInit('form'));",
    expected: MULTIPART_REASON,
    id: 'overloaded-options-factory-with-a-form-data-branch',
  },
  {
    body: "function make(kind: 'a'): BodyInit; function make(kind: 'b'): BodyInit; function make(kind: string): BodyInit { return kind === 'a' ? 'x' : 'y'; } return new Response(make('a'));",
    expected: undefined,
    id: 'overloaded-factory-returning-text',
  },
  {
    body: "function make(kind: 'a'): Promise<BodyInit>; function make(kind: 'b'): Promise<BodyInit>; async function make(kind: string): Promise<BodyInit> { void kind; return new FormData(); } return new Response(make('a'));",
    expected: undefined,
    id: 'overloaded-factory-with-an-async-implementation-answers-a-promise',
  },
  {
    body: "declare function make(kind: string): BodyInit; return new Response(make('a'));",
    expected: undefined,
    id: 'ambient-factory-without-a-body',
  },
  {
    body: 'function make(): FormData { return new FormData(); } return new Response(make());',
    expected: MULTIPART_REASON,
    id: 'plain-factory-pin',
  },
] as const;

describe('multipart factories declared over overloads', () => {
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
      'multipart-factory-overloads.ts',
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
