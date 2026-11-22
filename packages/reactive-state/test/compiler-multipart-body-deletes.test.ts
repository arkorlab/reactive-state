import { isIdentifier, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { multipartMaking } from '../src/compiler/multipart.ts';

const MULTIPART_REASON =
  'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random';

const CASES = [
  {
    body: "const override: RequestInit = { body: 'fixed', headers: {} }; delete override.headers; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...override });",
    expected: undefined,
    id: 'delete-unrelated-headers-preserves-body-overwrite',
  },
  {
    body: "const override: RequestInit = { body: 'fixed', headers: {} }; Reflect.deleteProperty(override, 'headers'); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...override });",
    expected: undefined,
    id: 'reflect-delete-unrelated-property-preserves-body-overwrite',
  },
  {
    body: "const override: Record<string, unknown> = { body: 'fixed', headers: {}, mode: 'cors' }; delete override[flag ? 'headers' : 'mode']; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...(override as RequestInit) });",
    expected: undefined,
    id: 'delete-conditional-non-body-keys-preserves-overwrite',
  },
  {
    body: "const override = { body: 'fixed', headers: { accept: 'text/plain' } as Record<string, string> }; delete override.headers.accept; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...override });",
    expected: undefined,
    id: 'delete-nested-subproperty-preserves-body-overwrite',
  },
  {
    body: "function touch(headers: Record<string, string>) { delete headers.accept; } const override = { body: 'fixed', headers: { accept: 'text/plain' } as Record<string, string> }; touch(override.headers); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...override });",
    expected: undefined,
    id: 'handoff-nested-subobject-preserves-body-overwrite',
  },
  {
    body: "const override: RequestInit = { body: 'fixed' }; const request = new Request('https://example.com/', { method: 'POST', body: new FormData(), ...override }); delete override.body; return request;",
    expected: undefined,
    id: 'delete-body-after-request-read-preserves-overwrite',
  },
  {
    body: "const override: RequestInit = { body: 'fixed' }; if (false) { delete override.body; } return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...override });",
    expected: undefined,
    id: 'dead-branch-delete-body-preserves-overwrite',
  },
  {
    body: "const base: RequestInit = { body: 'fixed' }; const override: RequestInit = { ...base }; delete base.body; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...override });",
    expected: undefined,
    id: 'spread-copy-before-delete-body-preserves-overwrite',
  },
  {
    body: "const override: RequestInit = { body: 'fixed' }; delete override.body; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...override });",
    expected: MULTIPART_REASON,
    id: 'delete-body-invalidates-overwrite',
  },
  {
    body: "const override: RequestInit = { body: 'fixed' }; Reflect.deleteProperty(override, 'body'); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...override });",
    expected: MULTIPART_REASON,
    id: 'reflect-delete-body-invalidates-overwrite',
  },
  {
    body: "const override: Record<string, unknown> = { body: 'fixed' }; delete override[dynamicKey]; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...(override as RequestInit) });",
    expected: MULTIPART_REASON,
    id: 'delete-dynamic-key-invalidates-overwrite',
  },
  {
    body: "function clear(init: RequestInit) { delete init.body; } const override: RequestInit = { body: 'fixed' }; clear(override); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...override });",
    expected: MULTIPART_REASON,
    id: 'handoff-whole-override-to-helper-invalidates-overwrite',
  },
  {
    body: "const override: RequestInit = { body: 'fixed' }; let last: Request | undefined; for (let i = 0; i < 2; i++) { last = new Request('https://example.com/', { method: 'POST', body: new FormData(), ...override }); delete override.body; } return last!;",
    expected: MULTIPART_REASON,
    id: 'loop-back-edge-delete-body-invalidates-overwrite',
  },
  {
    body: "const base: RequestInit = { body: 'fixed' }; let override: RequestInit = base; delete base.body; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...override });",
    expected: MULTIPART_REASON,
    id: 'let-alias-before-delete-body-invalidates-overwrite',
  },
  {
    body: "const override: RequestInit = { body: 'fixed' }; const make = () => { const request = new Request('https://example.com/', { method: 'POST', body: new FormData(), ...override }); delete override.body; return request; }; make(); return make();",
    expected: MULTIPART_REASON,
    id: 'closure-shared-delete-after-read-invalidates-overwrite',
  },
  {
    body: "options = { method: 'POST', body: 'fixed', headers: {} }; delete options.headers; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...options });",
    expected: undefined,
    id: 'parameter-delete-unrelated-headers-preserves-overwrite',
  },
] as const;

describe('multipart body overwrite preservation across unrelated and post-read deletes', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `multipartMaking` on the `new Request(...)` node in `body`. */
  function checkRequest(body: string): string | undefined {
    using parsed = api.createSourceFile(
      'multipart-body-deletes.ts',
      `export function build(options: RequestInit, flag: boolean, dynamicKey: string): Request { ${body} }\n`,
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
    expect(checkRequest(body)).toBe(expected);
  });
});
