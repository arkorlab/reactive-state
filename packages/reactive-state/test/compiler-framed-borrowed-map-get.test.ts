import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Only the native operation's consumed values expose supplied Error words. */
const CASES = [
  {
    id: 'borrowed-map-call',
    source:
      'function frames(error:Error){return Map.prototype.get.call(new Map([["x",error]]),"x")!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-map-apply',
    source:
      'function frames(error:Error){return Map.prototype.get.apply(new Map([["x",error]]),["x"])!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-map-reflect',
    source:
      'function frames(error:Error){return Reflect.apply(Map.prototype.get,new Map([["x",error]]),["x"])!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-weakmap-call',
    source:
      'function frames(error:Error){const key={};return WeakMap.prototype.get.call(new WeakMap([[key,error]]),key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-get-constant-alias',
    source:
      'const read=Map.prototype.get;function frames(error:Error){return read.call(new Map([["x",error]]),"x")!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-get-typed-weakmap',
    source:
      'function frames(map:WeakMap<object,Error>,key:object){return Reflect.apply(WeakMap.prototype.get,map,[key])!.stack;}',
    invocation: '(()=>{const key={};return frames(new WeakMap([[key,new Error("ours")]]),key);})()',
    refused: true,
  },
  {
    id: 'borrowed-get-native-overrides-own',
    source:
      'function frames(error:Error){const map=new Map<string,{stack:string}>([["x",error as never]]);map.get=()=>({stack:"fixed"});return Map.prototype.get.call(map,"x")!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-get-own-direct-data',
    source:
      'function frames(error:Error){const map=new Map<string,{stack:string}>([["x",error as never]]);map.get=()=>({stack:"fixed"});return map.get("x")!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'borrowed-get-selected-data',
    source:
      'function frames(error:Error){return Map.prototype.get.call(new Map<string,{stack:string}>([["bad",error as never],["safe",{stack:"fixed"}]]),"safe")!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'borrowed-get-local-map-shadow',
    source:
      'function frames(error:Error){const Map={prototype:{get:()=>({stack:"fixed"})}};return Map.prototype.get.call(error,"x").stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'borrowed-get-local-weakmap-shadow',
    source:
      'function frames(error:Error){const WeakMap={prototype:{get:()=>({stack:"fixed"})}};return Reflect.apply(WeakMap.prototype.get,error,["x"]).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'borrowed-get-local-written-words',
    source:
      'function frames(){return Map.prototype.get.call(new Map([["x",new Error("fixed")]]),"x")!.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'borrowed-get-ignored-extra-argument',
    source:
      'function frames(error:Error){return Reflect.apply(Map.prototype.get,new Map([["x",{stack:"fixed"}]]),["x",error])!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('borrowed map result readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'borrowed-map-get.ts', source);
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

describe('shared borrowed map results', () => {
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
