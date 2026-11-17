import { isIdentifier, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { multipartMaking } from '../src/compiler/multipart.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const MULTIPART_REASON =
  'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random';

const CHAIN_STEPS = {
  bodyLength: 16,
  budgetMs: 500,
  diamondLength: 7,
  linearLength: 14,
} as const;

/** Builds chained `RequestInit` declarations `o1` .. `oN` after `first`. */
function optionsChain(length: number, first: string, step: (previous: string) => string): string {
  const declarations = Array.from({ length }, (_, index) => {
    const previous = `o${String(index)}`;
    return `const o${String(index + 1)}: RequestInit = ${step(previous)};`;
  });
  return [first, ...declarations].join(' ');
}

/** Builds chained `BodyInit` declarations `b1` .. `bN` after `first`. */
function responseBodyChain(
  length: number,
  first: string,
  step: (previous: string) => string,
): string {
  const declarations = Array.from({ length }, (_, index) => {
    const previous = `b${String(index)}`;
    return `const b${String(index + 1)}: BodyInit = ${step(previous)};`;
  });
  return [first, ...declarations].join(' ');
}

const LAST_LINEAR = `o${String(CHAIN_STEPS.linearLength)}`;
const LAST_DIAMOND = `o${String(CHAIN_STEPS.diamondLength)}`;
const LAST_BODY = `b${String(CHAIN_STEPS.bodyLength)}`;

const LINEAR_FIXED_CHAIN = optionsChain(
  CHAIN_STEPS.linearLength,
  "const o0: RequestInit = { method: 'POST', body: 'fixed' };",
  (prev) => `{ ...${prev} }`,
);
const LINEAR_FORM_DATA_CHAIN = optionsChain(
  CHAIN_STEPS.linearLength,
  "const o0: RequestInit = { method: 'POST', body: new FormData() };",
  (prev) => `{ ...${prev} }`,
);
const DIAMOND_CONDITIONAL_CHAIN = optionsChain(
  CHAIN_STEPS.diamondLength,
  "const o0: RequestInit = { method: 'POST', body: 'fixed' };",
  (prev) => `flag ? { ...${prev} } : { ...${prev} }`,
);
const DIAMOND_ASSIGN_CHAIN = optionsChain(
  CHAIN_STEPS.diamondLength,
  "const o0: RequestInit = { method: 'POST', body: 'fixed' };",
  (prev) => `Object.assign({}, ${prev}, { ...${prev} })`,
);
const DIAMOND_BODY_CHAIN = responseBodyChain(
  CHAIN_STEPS.bodyLength,
  "const b0: BodyInit = 'fixed';",
  (prev) => `flag ? ${prev} : (${prev})`,
);

const CASES = [
  {
    body: `${LINEAR_FIXED_CHAIN} return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...${LAST_LINEAR} });`,
    expected: undefined,
    id: 'linear-spread-chain-overwriting-form-data',
  },
  {
    body: `${LINEAR_FORM_DATA_CHAIN} return new Request('https://example.com/', ${LAST_LINEAR});`,
    expected: MULTIPART_REASON,
    id: 'linear-spread-chain-retaining-form-data',
  },
  {
    body: `${DIAMOND_CONDITIONAL_CHAIN} return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...${LAST_DIAMOND} });`,
    expected: undefined,
    id: 'diamond-conditional-spread-chain-overwriting',
  },
  {
    body: `${DIAMOND_ASSIGN_CHAIN} return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...${LAST_DIAMOND} });`,
    expected: undefined,
    id: 'diamond-object-assign-spread-chain',
  },
  {
    body: `${DIAMOND_BODY_CHAIN} return new Response(${LAST_BODY});`,
    expected: undefined,
    id: 'diamond-response-body-conditional-chain',
  },
  {
    body: "const o0: RequestInit = { method: 'POST' }; const o1: RequestInit = { ...o0 }; const o2: RequestInit = { ...o1 }; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...o2 });",
    expected: MULTIPART_REASON,
    id: 'partial-spread-chain-does-not-overwrite-earlier-form-data',
  },
  {
    body: "const a: RequestInit = { ...(b as RequestInit) }; const b: RequestInit = { body: new FormData(), ...(a as RequestInit) }; return new Request('https://example.com/', { ...(a as RequestInit), ...(b as RequestInit) });",
    expected: MULTIPART_REASON,
    id: 'cyclic-spread-with-sibling-entry-stays-cycle-safe',
  },
  {
    body: "const a: RequestInit = { ...(b as RequestInit) }; const b: RequestInit = { ...(a as RequestInit) }; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...(a as RequestInit) });",
    expected: MULTIPART_REASON,
    id: 'cyclic-non-overwriting-spread-preserves-earlier-form-data',
  },
] as const;

describe('multipart body analysis reuse across spread chains and diamonds', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `multipartMaking` and elapsed milliseconds on the Request/Response in `body`. */
  function analyzed(body: string): { readonly answer: string | undefined; readonly took: number } {
    using parsed = parseModule(
      api,
      'multipart-spread-chains.ts',
      `export function build(flag: boolean): Request | Response { ${body} }\n`,
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
    const started = performance.now();
    const answer = multipartMaking(target.node, target.kind);
    return { answer, took: performance.now() - started };
  }

  it.each(CASES)('$id', ({ body, expected }) => {
    const done = analyzed(body);

    expect(done.answer).toBe(expected);
    expect(done.took).toBeLessThan(CHAIN_STEPS.budgetMs);
  });
});
