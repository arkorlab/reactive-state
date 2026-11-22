import { isIdentifier, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { multipartMaking } from '../src/compiler/multipart.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const MULTIPART_REASON =
  'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random';

const LIMITS = {
  budgetMs: 100,
  diamondLevels: 30,
} as const;

const LAST_DIAMOND = `o${String(LIMITS.diamondLevels)}`;

/** Builds `count` diamond spread declarations `o1`..`oN` starting from `seed`. */
function diamondSpreadChain(count: number, seed: string): string {
  const lines = [seed];
  for (let index = 1; index <= count; index += 1) {
    const previous = `o${String(index - 1)}`;
    lines.push(
      `const o${String(index)}: RequestInit = flag ? { ...${previous} } : { ...${previous} };`,
    );
  }
  return lines.join(' ');
}

const CASES = [
  {
    body: "const old = options; options = { method: 'POST', body: new FormData() }; old.body = 'fixed'; return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'old-const-alias-write-does-not-overwrite-replaced-options',
  },
  {
    body: "const alias = options; options = {}; alias.body = 'fixed'; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...options });",
    expected: MULTIPART_REASON,
    id: 'old-const-alias-write-does-not-prove-spread-overwrite',
  },
  {
    body: "const first = options; const second = first; options = {}; second.body = 'fixed'; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...options });",
    expected: MULTIPART_REASON,
    id: 'chained-old-const-alias-write-does-not-prove-spread-overwrite',
  },
  {
    body: "options = {}; const alias = options; options = { method: 'POST' }; options.body = 'fixed'; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...alias });",
    expected: MULTIPART_REASON,
    id: 'later-parameter-write-after-reassignment-does-not-overwrite-earlier-alias',
  },
  {
    body: "options = {}; const alias = options; if (flag) { options = { method: 'POST' }; } options.body = 'fixed'; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...alias });",
    expected: MULTIPART_REASON,
    id: 'later-parameter-write-after-conditional-reassignment-keeps-earlier-alias-open',
  },
  {
    body: "const old = options; options = { method: 'POST', body: 'fixed' }; old.body = new FormData(); return new Request('https://example.com/', options);",
    expected: undefined,
    id: 'old-const-alias-form-data-write-does-not-taint-fresh-replacement',
  },
  {
    body: "options = { method: 'POST', body: new FormData() }; const fresh = options; fresh.body = 'fixed'; return new Request('https://example.com/', options);",
    expected: undefined,
    id: 'post-replacement-const-alias-overwrites-fresh-form-data',
  },
  {
    body: "options = {}; Object.assign(options, { body: new FormData() }, { body: 'fixed' }); return new Request('https://example.com/', options);",
    expected: undefined,
    id: 'object-assign-on-parameter-applies-later-body-overwrite-in-order',
  },
  {
    body: "Object.assign(options, { body: 'fixed' }, { body: new FormData() }); return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'object-assign-on-parameter-retains-later-form-data-source',
  },
  {
    body: "return new Request('https://example.com/', Object.assign({ method: 'POST' }, ...[{ body: new FormData() }]));",
    expected: MULTIPART_REASON,
    id: 'object-assign-spread-array-literal-source-with-form-data',
  },
  {
    body: "const sources = [{ body: new FormData() }] as const; return new Request('https://example.com/', Object.assign({ method: 'POST' }, ...sources));",
    expected: MULTIPART_REASON,
    id: 'object-assign-spread-const-tuple-source-with-form-data',
  },
  {
    body: "return new Request('https://example.com/', Object.assign({ method: 'POST' }, ...(flag ? [{ body: new FormData() }] : [])));",
    expected: MULTIPART_REASON,
    id: 'object-assign-spread-conditional-array-source-with-form-data',
  },
  {
    body: "return new Request('https://example.com/', Object.assign({ method: 'POST' }, ...[{ body: new FormData() }], { body: 'fixed' }));",
    expected: undefined,
    id: 'object-assign-spread-form-data-overwritten-by-later-source',
  },
  {
    body: 'return new Response(defaultedBody);',
    expected: MULTIPART_REASON,
    id: 'response-body-parameter-default-initializer-form-data',
  },
  {
    body: "defaultedBody = 'fixed'; return new Response(defaultedBody);",
    expected: undefined,
    id: 'response-body-parameter-default-replaced-before-construction',
  },
  {
    body: 'function inner({ payload = new FormData() }: { payload?: BodyInit } = {}): Response { return new Response(payload); } return inner({});',
    expected: MULTIPART_REASON,
    id: 'response-body-destructured-parameter-default-form-data',
  },
  {
    body: `${diamondSpreadChain(LIMITS.diamondLevels, "const o0: RequestInit = { method: 'POST', body: new FormData() };")} return new Request('https://example.com/', ${LAST_DIAMOND});`,
    expected: MULTIPART_REASON,
    id: 'diamond-conditional-spread-with-form-data-deduplicates-candidates',
  },
] as const;

describe('multipart alias replacements, Object.assign spreads, defaults, and candidate deduplication', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `multipartMaking` and elapsed milliseconds on the Request or Response in `body`. */
  function analyzed(body: string): { readonly answer: string | undefined; readonly took: number } {
    using parsed = parseModule(
      api,
      'multipart-alias-replacements.ts',
      `export function build(options: RequestInit, flag: boolean, defaultedBody: BodyInit = new FormData()): Request | Response { ${body} }
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
    const started = performance.now();
    const answer = multipartMaking(target.node, target.kind);
    return { answer, took: performance.now() - started };
  }

  it.each(CASES)('$id', ({ body, expected }) => {
    const done = analyzed(body);

    expect(done.answer).toBe(expected);
    expect(done.took).toBeLessThan(LIMITS.budgetMs);
  });
});
