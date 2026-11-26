import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A member read through a native Proxy answers what its directly written get trap returns. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-caught-get-stack',
    source:
      'function frames(error:Error){try{throw new Error("ours");}catch(caught){return(new Proxy<Record<string,any>>({},{get(){return caught;}}).x).stack;}}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'supplied-error-get-stack',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({},{get(){return error;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'arrow-trap',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({},{get:()=>error}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'function-expression-trap',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({},{get:function(){return error;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'string-trap-name',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({},{"get"(){return error;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'computed-trap-name',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({},{["get"](){return error;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'element-selections',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({},{get(){return error;}})["x"])["stack"];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unknown-key-selection',
    source:
      'function frames(error:Error,key:string){return(new Proxy<Record<string,any>>({},{get(){return error;}})[key]).stack;}',
    invocation: 'frames(new Error("ours"),"x")',
    refused: true,
  },
  {
    id: 'whole-proxy-const-alias',
    source:
      'function frames(error:Error){const proxy=new Proxy<Record<string,any>>({},{get(){return error;}});const alias=proxy;return alias.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-handler-const-alias',
    source:
      'function frames(error:Error){const handler={get(){return error;}};return(new Proxy<Record<string,any>>({},handler).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'trap-error-const-alias',
    source:
      'function frames(error:Error){const alias=error;return(new Proxy<Record<string,any>>({},{get(){return alias;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proxy-constructor-alias',
    source:
      'function frames(error:Error){const Native=Proxy;return(new Native<Record<string,any>>({},{get(){return error;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'global-this-proxy',
    source:
      'function frames(error:Error){return(new globalThis.Proxy<Record<string,any>>({},{get(){return error;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'supplied-error-words',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({},{get(){return error;}}).x).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'fresh-error-stack',
    source:
      'function frames(error:Error){const value=new Error("ours");return(new Proxy<Record<string,any>>({},{get(){return value;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'saved-get-result',
    source:
      'function frames(error:Error){const value=new Proxy<Record<string,any>>({},{get(){return error;}}).x;return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-returned-path',
    source:
      'function frames(error:Error){return new Proxy<Record<string,any>>({},{get(){return{inner:error};}}).x.inner.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'text-conversion-words',
    source:
      'function frames(error:Error){return String(new Proxy<Record<string,any>>({},{get(){return error;}}).x);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'keyed-branch-return',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({},{get(_target,key){if(key==="x")return error;return undefined;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'guarded-trap-throw',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({},{get(_target,key){if(typeof key==="symbol")throw new TypeError("symbol");return error;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'array-target',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>([],{get(){return error;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unknown-target',
    source:
      'function frames(error:Error,target:Record<string,any>){return(new Proxy(target,{get(){return error;}}).x).stack;}',
    invocation: 'frames(new Error("ours"),{})',
    refused: true,
  },
  {
    id: 'revocable-proxy',
    source:
      'function frames(error:Error){return Proxy.revocable<Record<string,any>>({},{get(){return error;}}).proxy.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'literal-data-trap',
    source:
      'function frames(error:Error){const value={stack:"fixed"};return(new Proxy<Record<string,any>>({},{get(){return value;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'inline-data-return',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({},{get(){return{stack:"fixed"};}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'fresh-error-local-words',
    source:
      'function frames(error:Error){const value=new Error("fixed");return(new Proxy<Record<string,any>>({},{get(){return value;}}).x).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'async-trap',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({},{async get(){return error;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'generator-trap',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({},{*get(){return error;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'nested-function-return',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({},{get(){function make(){return error;}return typeof make;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-proxy-shadow',
    source:
      'function frames(error:Error){const Proxy=class{constructor(_target:unknown,_handler:unknown){}x={stack:"fixed"};};return(new Proxy({},{get(){return error;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'unrelated-trap-only',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({x:{stack:"fixed"}},{has(){return true;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'accessor-trap',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({},{get get(){return()=>error;}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spread-after-trap',
    source:
      'function frames(error:Error,base:ProxyHandler<Record<string,any>>){return(new Proxy<Record<string,any>>({},{get(){return error;},...base}).x).stack;}',
    invocation: 'frames(new Error("ours"),{})',
    refused: true,
  },
  {
    id: 'spread-before-trap',
    source:
      'function frames(error:Error,base:ProxyHandler<Record<string,any>>){return(new Proxy<Record<string,any>>({},{...base,get(){return error;}}).x).stack;}',
    invocation: 'frames(new Error("ours"),{get(){return{stack:"fixed"};}})',
    refused: true,
  },
  {
    id: 'unknown-computed-trap',
    source:
      'function frames(error:Error,name:string){return(new Proxy<Record<string,any>>({},{[name]:()=>error}).x).stack;}',
    invocation: 'frames(new Error("ours"),"get")',
    refused: true,
  },
  {
    id: 'shorthand-const-trap',
    source:
      'function frames(error:Error){const get=()=>error;return(new Proxy<Record<string,any>>({},{get}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'shorthand-function-trap',
    source:
      'function frames(error:Error){function get(){return error;}return(new Proxy<Record<string,any>>({},{get}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'optional-chain-selection',
    source:
      'function frames(error:Error){return new Proxy<Record<string,any>>({},{get(){return error;}}).x?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'literal-held-proxy',
    source:
      'function frames(error:Error){return({p:new Proxy<Record<string,any>>({},{get(){return error;}})}).p.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'get-undefined-forwards',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({x:{stack:"fixed"}},{get:undefined}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'target-parameter-data',
    source:
      'function frames(error:Error){return(new Proxy<Record<string,any>>({x:{stack:"fixed"}},{get(target,key){return target[key as string];}}).x).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'empty-handler-error-words',
    source: 'function frames(error:Error){return new Proxy(error,{}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'asserted-data-result',
    source:
      'function frames(error:Error){return((new Proxy<Record<string,any>>({},{get(){return{stack:"fixed"};}}).x)as Error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('proxy get trap readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'proxy-get-results.ts', source);
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

describe('shared Proxy get trap admissions', () => {
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
