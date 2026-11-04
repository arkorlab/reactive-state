import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A known own encoder method does not convert arguments by native Web IDL rules. */
const CASES: readonly {
  id: string;
  source: string;
  refused: boolean;
  invocation: string;
  effect: string;
  actualRefused?: boolean;
  actualBoundary?: string;
}[] = [
  {
    id: 'url-input-canonical',
    source:
      'function frames(error:Error){return new URL(error as never,"https://example.test/").pathname;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    effect: 'observedWords',
  },
  {
    id: 'url-caught-input',
    source:
      'function frames(){try{JSON.parse("{");}catch(error){return new URL(error as never,"https://example.test/").pathname;}return "fixed";}',
    refused: true,
    invocation: 'frames()',
    effect: 'observedWords',
  },
  {
    id: 'url-global-constructor',
    source:
      'function frames(error:Error){return new globalThis.URL(error as never,"https://example.test/").pathname;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    effect: 'observedWords',
  },
  {
    id: 'url-immutable-alias',
    source:
      'function frames(error:Error){const Address=URL;return new Address(error as never,"https://example.test/").pathname;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    effect: 'observedWords',
    actualBoundary: 'already refused by another shared-module gate; reader remains a miss',
  },
  {
    id: 'url-array-input',
    source:
      'function frames(error:Error){return new URL([error] as never,"https://example.test/").pathname;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    effect: 'observedWords',
  },
  {
    id: 'url-input-spread',
    source:
      'function frames(error:Error){return new URL(...[error as never,"https://example.test/"]as[never,string]).pathname;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    effect: 'observedWords',
  },
  {
    id: 'url-base-coercion',
    source: 'function frames(error:Error){return new URL("fixed",error as never).pathname;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    effect: 'coercionThrows',
  },
  {
    id: 'url-made-words',
    source:
      'function frames(){return new URL(new Error("ours") as never,"https://example.test/").pathname;}',
    refused: false,
    invocation: 'frames()',
    effect: 'safe',
  },
  {
    id: 'url-data',
    source: 'function frames(){return new URL("fixed","https://example.test/").pathname;}',
    refused: false,
    invocation: 'frames()',
    effect: 'safe',
  },
  {
    id: 'url-local-shadow',
    source:
      'class URL{pathname="fixed";constructor(_value:unknown,_base?:unknown){}}function frames(error:Error){return new URL(error).pathname;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    effect: 'safe',
  },
  {
    id: 'url-global-shadow',
    source:
      'function frames(error:Error){const globalThis={URL:class {pathname="fixed";constructor(_value:unknown){}}};return new globalThis.URL(error).pathname;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    effect: 'safe',
  },
  {
    id: 'url-ignored-tail',
    source:
      'function frames(error:Error){const Address=URL as unknown as new(...args:unknown[])=>URL;return new Address("fixed","https://example.test/",error).pathname;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    effect: 'safe',
    actualRefused: true,
    actualBoundary: 'existing URL value-holder gate; text input contains no Error',
  },
  {
    id: 'url-omitted-base',
    source: 'function frames(){return new URL("https://example.test/fixed").pathname;}',
    refused: false,
    invocation: 'frames()',
    effect: 'safe',
  },
  {
    id: 'url-fixed-base-alias',
    source:
      'function frames(){const base="https://example.test/";return new URL("fixed",base).pathname;}',
    refused: false,
    invocation: 'frames()',
    effect: 'safe',
  },
];

describe('native url text readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'recursive-error-members.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(refused);
  });
});

describe('native url text shared', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused, actualRefused = refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = actualRefused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
