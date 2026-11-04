import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'inner-ownkeys-stays-fixed',
    source:
      'function frames(error:Error){return Object.getOwnPropertyNames(new Proxy(new Proxy(error,{ownKeys(){return["fixed"];}}),{get(){return"fixed";}}));}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'conditional-inner-proxy-stays-fixed',
    source:
      'function frames(error:Error,flag:boolean){return Object.getOwnPropertyNames(new Proxy(flag?new Proxy(error,{ownKeys(){return["fixed"];}}):new Proxy(error,{ownKeys(){return["fixed"];}}),{get(){return"fixed";}}));}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"),true)',
  },
  {
    id: 'reflect-wrapper-tail-changes-handler',
    source:
      'function frames(error:Error){const handler:ProxyHandler<Error>={get(){return"fixed";}};const proxy=new Proxy(error,handler);return(Reflect.apply as(...args:unknown[])=>string[])(Object.getOwnPropertyNames,null,[proxy],Object.assign(handler,{ownKeys:()=>["fixed"]}));}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'apply-wrapper-tail-changes-handler',
    source:
      'function frames(error:Error){const handler:ProxyHandler<Error>={get(){return"fixed";}};const proxy=new Proxy(error,handler);return(Object.getOwnPropertyNames.apply as(...args:unknown[])=>string[])(null,[proxy],Object.assign(handler,{ownKeys:()=>["fixed"]}));}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'whole-fresh-error-alias',
    source:
      'function frames(error:Error){const cause=new Error("ours");return Object.getOwnPropertyNames(new Proxy(cause,{get(){return"fixed";}}));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'whole-parameter-alias-chain',
    source:
      'function frames(error:Error){const cause=error;const failure=cause;return Object.getOwnPropertyNames(new Proxy(failure,{get(){return"fixed";}}));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'prior-own-presence-data',
    source:
      'function frames(error:Error){Object.defineProperty(error,"fileName",{value:"fixed"});return Object.hasOwn(new Proxy(error,{get(){return"fixed";}}),"fileName");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'captured-handler-replacement',
    source:
      'function frames(error:Error){const handler:ProxyHandler<Error>={get(){return"fixed";}};const prepare=()=>{handler.ownKeys=()=>["fixed"];};const proxy=new Proxy(error,handler);prepare();return Object.getOwnPropertyNames(proxy);}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'inner-descriptor-hides-presence',
    source:
      'function frames(error:Error){return Object.hasOwn(new Proxy(new Proxy(error,{getOwnPropertyDescriptor(){return undefined;}}),{get(){return"fixed";}}),"stack");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'quiet-constructor-tail',
    source:
      'function frames(error:Error){return Object.getOwnPropertyNames(new(Proxy as new(...args:unknown[])=>Error)(error,{get(){return"fixed";}},0));}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('quiet Proxy shape boundary readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-reduce.ts', source);
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

describe('quiet Proxy shape boundary shared', () => {
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
