import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A known own encoder method does not convert arguments by native Web IDL rules. */
const CASES = [
  {
    id: 'registry-direct',
    source: 'function frames(error:Error){return Symbol.for(error as never).description;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'registry-global',
    source:
      'function frames(error:Error){return globalThis.Symbol.for(error as never).description;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'registry-const-alias',
    source:
      'function frames(error:Error){const make=Symbol.for;return make(error as never).description;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'registry-call',
    source:
      'function frames(error:Error){return Symbol.for.call(null,error as never).description;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'registry-apply',
    source:
      'function frames(error:Error){return Symbol.for.apply(null,[error as never]).description;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'registry-reflect-apply',
    source:
      'function frames(error:Error){return Reflect.apply(Symbol.for,null,[error]).description;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'registry-spread',
    source:
      'function frames(error:Error){return Symbol.for(...[error as never]as[never]).description;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'registry-caught',
    source:
      'function frames(){try{JSON.parse("{");}catch(error){return Symbol.for(error as never).description;}return "fixed";}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'registry-local-words',
    source: 'function frames(){return Symbol.for(new Error("ours")as never).description;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'registry-data',
    source: 'function frames(){return Symbol.for("fixed").description;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'registry-shadow',
    source:
      'function frames(error:Error){const Symbol={for(_value:unknown){return{description:"fixed"}}};return Symbol.for(error).description;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'registry-ignored-tail',
    source:
      'function frames(error:Error){return(Symbol.for as(...args:unknown[])=>symbol)("fixed",error).description;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'registry-ignored-receiver',
    source: 'function frames(error:Error){return Symbol.for.call(error,"fixed").description;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'registry-global-shadow',
    source:
      'function frames(error:Error){const globalThis={Symbol:{for(_value:unknown){return{description:"fixed"}}}};return globalThis.Symbol.for(error).description;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('symbol-registry readers', () => {
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

describe('shared symbol-registrys', () => {
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
