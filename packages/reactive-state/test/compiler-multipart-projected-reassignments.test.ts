import { isIdentifier, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { multipartMaking } from '../src/compiler/multipart.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const MULTIPART_REASON =
  'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random';

const CASES = [
  {
    code: "const replacement = { body: new FormData() }; body = 'fixed'; ({ body } = replacement); return new Response(body);",
    expected: MULTIPART_REASON,
    id: 'object-destructured-const-holder-after-typed-parameter-cut',
  },
  {
    code: "const replacement = { body: new FormData() }; plainBody = 'fixed'; ({ body: plainBody } = replacement); return new Response(plainBody);",
    expected: MULTIPART_REASON,
    id: 'object-destructured-const-holder-after-plain-parameter-cut',
  },
  {
    code: 'const replacement = { body: new FormData() }; ({ body: plainBody } = replacement); return new Response(plainBody);',
    expected: MULTIPART_REASON,
    id: 'object-destructured-const-holder-without-prior-parameter-cut',
  },
  {
    code: "const items = [new FormData()]; plainBody = 'fixed'; [plainBody] = items; return new Response(plainBody);",
    expected: MULTIPART_REASON,
    id: 'array-destructured-const-tuple-after-plain-parameter-cut',
  },
  {
    code: "plainBody = 'fixed'; ({ body: plainBody } = typedBox); return new Response(plainBody);",
    expected: MULTIPART_REASON,
    id: 'object-destructured-typed-parameter-container-after-plain-cut',
  },
  {
    code: "body = 'fixed'; ({ body } = opaqueBox); return new Response(body);",
    expected: MULTIPART_REASON,
    id: 'object-destructured-opaque-source-after-typed-parameter-cut-retains-fallback',
  },
  {
    code: "body = 'fixed'; ({ [key]: body } = opaqueBox); return new Response(body);",
    expected: MULTIPART_REASON,
    id: 'computed-key-destructured-after-typed-parameter-cut-retains-fallback',
  },
  {
    code: "plainBody = 'fixed'; ({ [key]: plainBody } = { first: new FormData(), second: 'fixed' }); return new Response(plainBody);",
    expected: MULTIPART_REASON,
    id: 'computed-key-destructured-literal-form-data-after-plain-parameter-cut',
  },
  {
    code: "let localBody: BodyInit = 'fixed'; const replacement = { body: new FormData() }; ({ body: localBody } = replacement); return new Response(localBody);",
    expected: MULTIPART_REASON,
    id: 'object-destructured-const-holder-into-local-let-variable',
  },
  {
    code: "const holder = { options: { method: 'POST', body: new FormData() } }; options = { method: 'POST', body: 'fixed' }; ({ options } = holder); return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'object-destructured-options-holder-after-options-parameter-cut',
  },
  {
    code: "let localOptions: RequestInit = { method: 'POST', body: 'fixed' }; const holder = { options: { method: 'POST', body: new FormData() } }; ({ options: localOptions } = holder); return new Request('https://example.com/', localOptions);",
    expected: MULTIPART_REASON,
    id: 'object-destructured-options-holder-into-local-let-variable',
  },
  {
    code: "const holder = { options: {} as RequestInit }; options = { method: 'POST', body: 'fixed' }; ({ options } = holder); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...options });",
    expected: MULTIPART_REASON,
    id: 'object-destructured-empty-options-holder-withholds-spread-overwrite',
  },
  {
    code: "options = { method: 'POST', body: 'fixed' }; ({ ...options } = { method: 'POST', body: new FormData() }); return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'object-rest-reassignment-copies-form-data-into-replaced-options',
  },
  {
    code: "const replacement = { body: 'still-fixed' }; plainBody = 'fixed'; ({ body: plainBody } = replacement); return new Response(plainBody);",
    expected: undefined,
    id: 'object-destructured-string-holder-after-plain-parameter-cut-allowed',
  },
  {
    code: "body = 'fixed'; return new Response(body);",
    expected: undefined,
    id: 'direct-string-replacement-on-typed-parameter-still-allowed',
  },
  {
    code: "let discarded: BodyInit = 'unused'; options = { method: 'POST', body: 'fixed' }; ({ body: discarded, ...options } = { method: 'POST', body: new FormData() }); void discarded; return new Request('https://example.com/', options);",
    expected: undefined,
    id: 'object-rest-reassignment-excluding-named-body-sibling-allowed',
  },
  {
    code: "const holder = { options: { method: 'POST', body: new FormData() } }; options = {}; options.body = 'fixed'; ({ options } = holder); return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'member-cut-followed-by-destructured-options-replacement',
  },
  {
    code: "options = { method: 'POST', body: 'fixed' }; ({ options } = {} as { options?: RequestInit }); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...options });",
    expected: MULTIPART_REASON,
    id: 'object-destructured-missing-property-resets-options-to-undefined',
  },
  {
    code: "let discarded: BodyInit = 'unused'; options = { method: 'POST', body: 'fixed' }; ({ body: discarded, ...options } = { method: 'POST', body: 'replaced' }); void discarded; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...options });",
    expected: MULTIPART_REASON,
    id: 'object-rest-reassignment-excluding-body-withholds-spread-overwrite',
  },
] as const;

describe('multipart projected reassignments after parameter replacements', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api.close();
  });

  it.each(CASES)('$id', ({ code, expected }) => {
    expect(checkProjectedReassignment(api, code)).toBe(expected);
  });
});

/** Evaluates `multipartMaking` on the `Request` or `Response` construction in `code`. */
function checkProjectedReassignment(api: API, code: string): string | undefined {
  using parsed = parseModule(
    api,
    'multipart-projected-reassignments.ts',
    `export function build(body: FormData | string, plainBody: BodyInit, options: RequestInit, typedBox: { body: FormData | string }, opaqueBox: Record<string, FormData | string>, key: string): Request | Response { ${code} }\n`,
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
    throw new Error(`No Request or Response construction found in ${code}.`);
  }
  return multipartMaking(target.node, target.kind);
}
