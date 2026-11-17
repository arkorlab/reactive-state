import { isIdentifier, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { multipartMaking } from '../src/compiler/multipart.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const MULTIPART_REASON =
  'makes a `Request` or `Response` of `FormData`, whose multipart boundary is random';

const CASES = [
  {
    body: "options = {}; Object.defineProperty(options, 'body', { value: 'fixed' }); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...options });",
    expected: MULTIPART_REASON,
    id: 'parameter-define-property-default-non-enumerable-spread',
  },
  {
    body: "options = {}; Object.defineProperty(options, 'body', { value: 'fixed' }); return new Request('https://example.com/', Object.assign({ method: 'POST', body: new FormData() }, options));",
    expected: MULTIPART_REASON,
    id: 'parameter-define-property-non-enumerable-object-assign-source',
  },
  {
    body: "options = {}; Object.defineProperties(options, { body: { value: 'fixed' } }); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...options });",
    expected: MULTIPART_REASON,
    id: 'parameter-define-properties-default-non-enumerable-spread',
  },
  {
    body: "options = { method: 'POST', body: 'fixed' }; Object.defineProperty(options, 'body', { enumerable: false }); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...options });",
    expected: MULTIPART_REASON,
    id: 'parameter-define-property-enumerable-false-on-fresh-literal-spread',
  },
  {
    body: "options = {}; Object.defineProperty(options, 'body', { value: 'init', writable: true }); options.body = 'fixed'; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...options });",
    expected: MULTIPART_REASON,
    id: 'parameter-define-property-writable-non-enumerable-then-member-write-spread',
  },
  {
    body: "const local: RequestInit = {}; Object.defineProperty(local, 'body', { value: 'fixed' }); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...local });",
    expected: MULTIPART_REASON,
    id: 'const-holder-define-property-default-non-enumerable-spread',
  },
  {
    body: "const local: RequestInit = { method: 'POST' }; Object.defineProperties(local, { body: { value: new FormData() } }); return new Request('https://example.com/', local);",
    expected: MULTIPART_REASON,
    id: 'const-holder-define-properties-form-data-direct',
  },
  {
    body: "Reflect.defineProperty(options, 'body', { value: new FormData() }); return new Request('https://example.com/', options);",
    expected: MULTIPART_REASON,
    id: 'parameter-reflect-define-property-form-data-direct',
  },
  {
    body: "return new Request('https://example.com/', Object.defineProperty({ method: 'POST' }, 'body', { value: new FormData() }));",
    expected: MULTIPART_REASON,
    id: 'object-define-property-return-expression-form-data',
  },
  {
    body: "return new Request('https://example.com/', Object.create(null, { method: { value: 'POST' }, body: { value: new FormData() } }));",
    expected: MULTIPART_REASON,
    id: 'object-create-descriptors-form-data-direct',
  },
  {
    body: "return new Request('https://example.com/', Object.create({ method: 'POST', body: new FormData() }));",
    expected: MULTIPART_REASON,
    id: 'object-create-prototype-form-data-direct',
  },
  {
    body: "const created: RequestInit = Object.create(null, { body: { value: 'fixed' } }); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...created });",
    expected: MULTIPART_REASON,
    id: 'object-create-default-non-enumerable-spread',
  },
  {
    body: "const local: RequestInit = {}; Object.defineProperty(local, 'body', { value: 'init', writable: true }); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...Object.assign(local, { body: 'fixed' }) });",
    expected: MULTIPART_REASON,
    id: 'spread-object-assign-onto-non-enumerable-target',
  },
  {
    body: "options = {}; Object.defineProperty(options, 'body', { value: 'fixed', enumerable: true }); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...options });",
    expected: undefined,
    id: 'parameter-define-property-enumerable-true-spread-overwrites',
  },
  {
    body: "options = {}; Object.defineProperties(options, { body: { value: 'fixed', enumerable: true } }); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...options });",
    expected: undefined,
    id: 'parameter-define-properties-enumerable-true-spread-overwrites',
  },
  {
    body: "const local: RequestInit = {}; Object.defineProperty(local, 'body', { value: 'fixed', enumerable: true }); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...local });",
    expected: undefined,
    id: 'const-holder-define-property-enumerable-true-spread-overwrites',
  },
  {
    body: "const created: RequestInit = Object.create(null, { body: { value: 'fixed', enumerable: true } }); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...created });",
    expected: undefined,
    id: 'object-create-enumerable-true-spread-overwrites',
  },
  {
    body: "options = { method: 'POST', body: new FormData() }; Object.defineProperty(options, 'body', { value: 'fixed' }); return new Request('https://example.com/', options);",
    expected: undefined,
    id: 'parameter-direct-read-after-non-enumerable-define-property-overwrites',
  },
  {
    body: "options = {}; options.body = 'fixed'; return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...options });",
    expected: undefined,
    id: 'parameter-ordinary-member-assignment-spread-overwrites',
  },
  {
    body: "return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...Object.defineProperty({}, 'body', { value: 'fixed', [flag ? 'enumerable' : 'writable']: true }) });",
    expected: MULTIPART_REASON,
    id: 'computed-flag-possibly-non-enumerable-spread-retains-earlier-form-data',
  },
  {
    body: "const local: RequestInit = {}; Object.defineProperty(local, 'body', { value: 'fixed', [flag ? 'enumerable' : 'configurable']: true }); return new Request('https://example.com/', { method: 'POST', body: new FormData(), ...local });",
    expected: MULTIPART_REASON,
    id: 'const-holder-computed-possibly-non-enumerable-spread-retains-form-data',
  },
  {
    body: "const opts: RequestInit = { method: 'POST' }; Object.defineProperty(opts, 'body', { value: new FormData(), [flag ? 'writable' : 'enumerable']: true }); opts.body = 'fixed'; return new Request('https://example.com/', opts);",
    expected: MULTIPART_REASON,
    id: 'computed-possibly-non-writable-define-property-not-cut-by-body-write',
  },
  {
    body: "const opts: RequestInit = { method: 'POST', body: new FormData() }; Object.defineProperty(opts, 'body', { [flag ? 'value' : 'writable']: 'fixed', enumerable: true }); return new Request('https://example.com/', opts);",
    expected: MULTIPART_REASON,
    id: 'computed-possibly-absent-value-define-property-retains-prior-form-data',
  },
  {
    body: "const opts = { body: new FormData() }; Object.defineProperty(opts, 'body', { writable: true }); opts.body = 'fixed'; return new Request('https://example.com/', opts);",
    expected: undefined,
    id: 'writable-only-define-property-followed-by-body-assignment-replaces-form-data',
  },
  {
    body: "const opts = { body: new FormData() }; Object.defineProperties(opts, { body: { writable: true } }); opts.body = 'fixed'; return new Request('https://example.com/', opts);",
    expected: undefined,
    id: 'writable-only-define-properties-followed-by-body-assignment-replaces-form-data',
  },
  {
    body: "const opts = { body: new FormData() }; Object.defineProperty(opts, 'body', { enumerable: false }); opts.body = 'fixed'; return new Request('https://example.com/', opts);",
    expected: undefined,
    id: 'omitted-writable-on-existing-own-body-preserves-writability-for-later-cut',
  },
  {
    body: "options = { body: new FormData() }; Object.defineProperty(options, 'body', { writable: true }); options.body = 'fixed'; return new Request('https://example.com/', options);",
    expected: undefined,
    id: 'parameter-writable-only-define-property-followed-by-body-assignment-replaces-form-data',
  },
  {
    body: "const opts = { body: new FormData() }; Object.defineProperty(opts, 'body', { writable: false }); opts.body = 'fixed'; return new Request('https://example.com/', opts);",
    expected: MULTIPART_REASON,
    id: 'writable-false-define-property-blocks-later-body-assignment-cut-pin',
  },
  {
    body: "const opts: RequestInit = { body: 'init' }; delete opts.body; Object.defineProperty(opts, 'body', { value: new FormData() }); opts.body = 'fixed'; return new Request('https://example.com/', opts);",
    expected: MULTIPART_REASON,
    id: 'deleted-initial-body-before-omitted-writable-define-property-blocks-later-cut-pin',
  },
] as const;

describe('multipart enumerability checks across spreads, Object.assign, and descriptor mutators', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `multipartMaking` on the `new Request(...)` construction in `body`. */
  function multipartOf(body: string): string | undefined {
    using parsed = parseModule(
      api,
      'multipart-enumerable-spreads.ts',
      `export function build(options: RequestInit, flag: boolean): Request { void flag; ${body} }\n`,
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
