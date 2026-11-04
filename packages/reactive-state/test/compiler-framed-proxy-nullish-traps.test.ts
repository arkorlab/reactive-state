import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A Proxy `get` trap that forwards the read answers the target's member of the read key. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'undefined-nested-target',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get:undefined} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'undefined-whole-error',
    source: 'function frames(error:Error){return new Proxy(error,{get:undefined} as never).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'undefined-message',
    source:
      'function frames(error:Error){return new Proxy(error,{get:undefined} as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'undefined-bracket-member',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get:undefined} as never)["x"]["stack"];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'undefined-revocable',
    source:
      'function frames(error:Error){return Proxy.revocable({x:error},{get:undefined} as never).proxy.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'undefined-constant-trap',
    source:
      'function frames(error:Error){const trap=undefined;return new Proxy({x:error},{get:trap} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'undefined-handler-alias',
    source:
      'function frames(error:Error){const handler={get:undefined} as never;return new Proxy({x:error},handler).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'undefined-getter-trap',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get get(){return undefined;}} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'undefined-later-nullish-entry',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get(){return {stack:"fixed"};},get:undefined} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'undefined-data-target',
    source:
      'function frames(error:Error){return new Proxy({x:{stack:"fixed"}},{get:undefined} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'undefined-later-own-trap',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get:undefined,get(){return {stack:"fixed"};}} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'null-nested-target',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get:null} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'null-whole-error',
    source: 'function frames(error:Error){return new Proxy(error,{get:null} as never).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'null-message',
    source: 'function frames(error:Error){return new Proxy(error,{get:null} as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'null-bracket-member',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get:null} as never)["x"]["stack"];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'null-revocable',
    source:
      'function frames(error:Error){return Proxy.revocable({x:error},{get:null} as never).proxy.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'null-constant-trap',
    source:
      'function frames(error:Error){const trap=null;return new Proxy({x:error},{get:trap} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'null-handler-alias',
    source:
      'function frames(error:Error){const handler={get:null} as never;return new Proxy({x:error},handler).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'null-getter-trap',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get get(){return null;}} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'null-later-nullish-entry',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get(){return {stack:"fixed"};},get:null} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'null-data-target',
    source:
      'function frames(error:Error){return new Proxy({x:{stack:"fixed"}},{get:null} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'null-later-own-trap',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get:null,get(){return {stack:"fixed"};}} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'void-zero-nested-target',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get:void 0} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'void-zero-whole-error',
    source: 'function frames(error:Error){return new Proxy(error,{get:void 0} as never).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'void-zero-message',
    source: 'function frames(error:Error){return new Proxy(error,{get:void 0} as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'void-zero-bracket-member',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get:void 0} as never)["x"]["stack"];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'void-zero-revocable',
    source:
      'function frames(error:Error){return Proxy.revocable({x:error},{get:void 0} as never).proxy.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'void-zero-constant-trap',
    source:
      'function frames(error:Error){const trap=void 0;return new Proxy({x:error},{get:trap} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'void-zero-handler-alias',
    source:
      'function frames(error:Error){const handler={get:void 0} as never;return new Proxy({x:error},handler).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'void-zero-getter-trap',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get get(){return void 0;}} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'void-zero-later-nullish-entry',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get(){return {stack:"fixed"};},get:void 0} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'void-zero-data-target',
    source:
      'function frames(error:Error){return new Proxy({x:{stack:"fixed"}},{get:void 0} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'void-zero-later-own-trap',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get:void 0,get(){return {stack:"fixed"};}} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'globalThis-undefined',
    source:
      'function frames(error:Error){return new Proxy({x:error},{get:globalThis.undefined} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'lexical-undefined-shadow',
    source:
      'function frames(error:Error){const undefined=()=>({stack:"fixed"});return new Proxy({x:error},{get:undefined}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'noncallable-trap-throws',
    source: 'function frames(error:Error){return new Proxy({x:error},{get:1} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'empty-handler-pin',
    source: 'function frames(error:Error){return new Proxy({x:error},{}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'forwarding-handler-pin',
    source: 'function frames(error:Error){return new Proxy({x:error},{get:Reflect.get}).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-Proxy-pin',
    source:
      'function frames(error:Error){class Proxy {x={stack:"fixed"};constructor(_target:unknown,_handler:unknown){}}return new Proxy({x:error},{get:undefined} as never).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'replaced-handler-before-construction',
    source:
      'function frames(error:Error){const handler:{get:undefined|(()=>{stack:string})}={get:undefined};handler.get=()=>({stack:"fixed"});return new Proxy({x:error},handler).x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'replaced-handler-after-construction',
    source:
      'function frames(error:Error){const handler:{get:undefined|(()=>{stack:string})}={get:undefined};const proxy=new Proxy({x:error},handler);handler.get=()=>({stack:"fixed"});return proxy.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'saved-proxy-data-write',
    source:
      'function frames(error:Error){const proxy=new Proxy({x:error},{get:undefined} as never);proxy.x={stack:"fixed"} as Error;return proxy.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'unchanged-saved-proxy',
    source:
      'function frames(error:Error){const proxy=new Proxy({x:error},{get:undefined} as never);return proxy.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unchanged-saved-handler-and-proxy',
    source:
      'function frames(error:Error){const handler={get:undefined};const proxy=new Proxy({x:error},handler);return proxy.x.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('nullish get trap readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'proxy-nullish-traps.ts', source);
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

describe('shared nullish get trap admissions', () => {
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
