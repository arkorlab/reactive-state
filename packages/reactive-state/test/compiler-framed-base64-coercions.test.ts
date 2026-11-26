import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A known own encoder method does not convert arguments by native Web IDL rules. */
const CASES = [
  {
    id: 'btoa-caught-canonical',
    source:
      'function frames(){try{JSON.parse("{");}catch(error){return btoa(error as never);}return "fixed";}',
    refused: true,
    invocation: 'frames()',
    effect: 'observedWords',
  },
  {
    id: 'btoa-supplied',
    source: 'function frames(error:Error){return btoa(error as never);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    effect: 'observedWords',
  },
  {
    id: 'btoa-global',
    source: 'function frames(error:Error){return globalThis.btoa(error as never);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    effect: 'observedWords',
  },
  {
    id: 'btoa-immutable-alias',
    source: 'function frames(error:Error){const encode=btoa;return encode(error as never);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    effect: 'observedWords',
  },
  {
    id: 'btoa-array-input',
    source: 'function frames(error:Error){return btoa([error] as never);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    effect: 'observedWords',
  },
  {
    id: 'btoa-receiver-spread',
    source: 'function frames(error:Error){return btoa.call(...[null]as[null],error as never);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    effect: 'observedWords',
  },
  {
    id: 'atob-input-coercion',
    source: 'function frames(error:Error){return atob(error as never);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
    effect: 'coercionThrows',
  },
  {
    id: 'btoa-made-words',
    source: 'function frames(){return btoa(new Error("ours") as never);}',
    refused: false,
    invocation: 'frames()',
    effect: 'safe',
  },
  {
    id: 'btoa-data',
    source: 'function frames(){return btoa("fixed");}',
    refused: false,
    invocation: 'frames()',
    effect: 'safe',
  },
  {
    id: 'btoa-local-shadow',
    source:
      'function frames(error:Error){const btoa=(_value:unknown)=>"fixed";return btoa(error);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    effect: 'safe',
  },
  {
    id: 'btoa-global-shadow',
    source:
      'function frames(error:Error){const globalThis={btoa:(_value:unknown)=>"fixed"};return globalThis.btoa(error);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    effect: 'safe',
  },
  {
    id: 'btoa-custom-method',
    source:
      'function frames(error:Error){const codec={btoa:(_value:unknown)=>"fixed"};return codec.btoa(error);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    effect: 'safe',
  },
  {
    id: 'btoa-ignored-receiver-tail',
    source:
      'function frames(error:Error){return (btoa.call as (...args:unknown[])=>string)(...[error]as[Error],"fixed",error);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
    effect: 'safe',
  },
  {
    id: 'atob-data',
    source: 'function frames(){return atob("Zml4ZWQ=");}',
    refused: false,
    invocation: 'frames()',
    effect: 'safe',
  },
];

describe('native base64 text readers', () => {
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

describe('native base64 text shared', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused }) => {
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
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
