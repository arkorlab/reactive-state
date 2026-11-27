import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'supplied-borrowed-review-case',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call(Map.prototype.set.call(values,"x",error),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-borrowed-message',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call(Map.prototype.set.call(values,"x",error),"x").message;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-receiver-alias',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){const alias=values;return Map.prototype.get.call(Map.prototype.set.call(alias,"x",error),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-result-alias',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){const result=Map.prototype.set.call(values,"x",error);return Map.prototype.get.call(result,"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-apply-pair',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.apply(Map.prototype.set.apply(values,["x",error]),["x"]).stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-reflected-pair',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Reflect.apply(Map.prototype.get,Reflect.apply(Map.prototype.set,values,["x",error]),["x"]).stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-mixed-native-wrappers',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.apply(Reflect.apply(Map.prototype.set,values,["x",error]),["x"]).stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-constant-key',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){const slot="x";return Map.prototype.get.call(Map.prototype.set.call(values,slot,error),slot).stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-unknown-key',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call(Map.prototype.set.call(values,key,error),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-outer-error-wins',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call(Map.prototype.set.call(Map.prototype.set.call(values,"x",{stack:"fixed"}),"x",error),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-outer-unrelated-key',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call(Map.prototype.set.call(Map.prototype.set.call(values,"x",error),"other",{stack:"fixed"}),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-own-set-bypassed',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){values.set=()=>values;return Map.prototype.get.call(Map.prototype.set.call(values,"x",error),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-own-get-bypassed',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){values.get=()=>({stack:"fixed"});return Map.prototype.get.call(Map.prototype.set.call(values,"x",error),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-quiet-extra-sensitivity',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return(Map.prototype.get as(...args:unknown[])=>any).call((Map.prototype.set as(...args:unknown[])=>any).call(values,"x",error,0),"x",0).stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-data-value-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call(Map.prototype.set.call(values,"x",{stack:"fixed"}),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-different-key-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call(Map.prototype.set.call(values,"other",error),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-outer-data-wins-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call(Map.prototype.set.call(Map.prototype.set.call(values,"x",error),"x",{stack:"fixed"}),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-local-words-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call(Map.prototype.set.call(values,"x",new Error("fixed")),"x").message;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-direct-own-get-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){values.get=()=>({stack:"fixed"});return Map.prototype.set.call(values,"x",error).get("x")!.stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-set-extra-rewrite-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call((Map.prototype.set as(...args:unknown[])=>any).call(values,"x",error,Object.assign(error,{stack:"fixed",message:"fixed"})),"x").message;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-get-extra-rewrite-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return(Map.prototype.get as(...args:unknown[])=>any).call(Map.prototype.set.call(values,"x",error),"x",Object.assign(error,{stack:"fixed",message:"fixed"})).message;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-set-key-rewrite-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call(Map.prototype.set.call(values,(Object.assign(error,{stack:"fixed",message:"fixed"}),"x"),error),"x").message;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-get-key-rewrite-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call(Map.prototype.set.call(values,"x",error),(Object.assign(error,{stack:"fixed",message:"fixed"}),"x")).message;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-local-map-shadow-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){const Map={prototype:{set(_key:unknown,_value:unknown){return{stack:"fixed"};},get(_key:unknown){return{stack:"fixed"};}}};return Map.prototype.get.call(Map.prototype.set.call(values,"x",error),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-local-reflect-shadow-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){const Reflect={apply(_target:unknown,_receiver:unknown,_args:unknown[]){return{stack:"fixed"};}};return Reflect.apply(Map.prototype.get,Reflect.apply(Map.prototype.set,values,["x",error]),["x"]).stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-unrelated-map-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){const other=new Map<string,unknown>();Map.prototype.set.call(other,"x",error);return Map.prototype.get.call(values,"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-unrelated-lexical-key-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){const slot="other";{const slot="x";void slot;}return Map.prototype.get.call(Map.prototype.set.call(values,slot,error),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-existing-error-type-pin',
    source:
      'function frames(error:Error,values:Map<string,Error>){return Map.prototype.get.call(values,"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-omitted-get-key-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return(Map.prototype.get as(...args:unknown[])=>any).call(Map.prototype.set.call(values,"x",error)).stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-explicit-undefined-key',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call(Map.prototype.set.call(values,undefined,error),undefined).stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-omitted-value-overwrite-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call((Map.prototype.set as(...args:unknown[])=>any).call(Map.prototype.set.call(values,"x",error),"x"),"x")?.stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-result-alias-later-map-overwrite-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){const result=Map.prototype.set.call(values,"x",error);Map.prototype.set.call(result,"x",{stack:"fixed",message:"fixed"});return Map.prototype.get.call(result,"x").message;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-result-alias-later-error-rewrite-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){const result=Map.prototype.set.call(values,"x",error);Object.assign(error,{stack:"fixed",message:"fixed"});return Map.prototype.get.call(result,"x").message;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-result-alias-clear-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){const result=Map.prototype.set.call(values,"x",error);result.clear();return Map.prototype.get.call(result,"x")?.stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-result-alias-earlier-write',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){Map.prototype.set.call(values,"x",{stack:"fixed"});const result=Map.prototype.set.call(values,"x",error);return Map.prototype.get.call(result,"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-result-alias-later-write',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){const result=Map.prototype.set.call(values,"x",error);const word=Map.prototype.get.call(result,"x").stack;Map.prototype.set.call(result,"x",{stack:"fixed"});return word;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-wrapper-map-reflect-get-ignored-tail-rewrite',
    source:
      'function frames(values:Map<string,{stack:string}>,error:Error){return(Reflect.apply as(...args:unknown[])=>{stack:string})(Map.prototype.get,Map.prototype.set.call(values,"failure",error),["failure"],Object.assign(error,{stack:"fixed"})).stack;}',
    invocation: 'frames(new Map(),new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'supplied-wrapper-quiet-map-reflect-get-ignored-tail-rewrite',
    source:
      'function frames(values:Map<string,{stack:string}>,error:Error){return(Reflect.apply as(...args:unknown[])=>{stack:string})(Map.prototype.get,Map.prototype.set.call(values,"failure",error),["failure"],0).stack;}',
    invocation: 'frames(new Map(),new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'supplied-wrapper-map-apply-get-ignored-tail-rewrite',
    source:
      'function frames(values:Map<string,{stack:string}>,error:Error){return(Map.prototype.get.apply as(...args:unknown[])=>{stack:string})(Map.prototype.set.call(values,"failure",error),["failure"],Object.assign(error,{stack:"fixed"})).stack;}',
    invocation: 'frames(new Map(),new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'supplied-wrapper-quiet-map-apply-get-ignored-tail-rewrite',
    source:
      'function frames(values:Map<string,{stack:string}>,error:Error){return(Map.prototype.get.apply as(...args:unknown[])=>{stack:string})(Map.prototype.set.call(values,"failure",error),["failure"],0).stack;}',
    invocation: 'frames(new Map(),new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'supplied-prior-map-prior-written-stack-pin',
    source:
      'function frames(values:Map<string,{stack:string}>,error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return Map.prototype.get.call(Map.prototype.set.call(values,"failure",error),"failure").stack;}',
    invocation: 'frames(new Map(),new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'supplied-prior-written-message-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){Object.defineProperty(error,"message",{value:"fixed"});return Map.prototype.get.call(Map.prototype.set.call(values,"x",error),"x").message;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-prior-written-value-alias-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){Object.defineProperty(error,"stack",{value:"fixed"});const item=error;return Map.prototype.get.call(Map.prototype.set.call(values,"x",item),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-value-alias-unexposed',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){const item=error;return Map.prototype.get.call(Map.prototype.set.call(values,"x",item),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-repeated-native-value-use',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call(Map.prototype.set.call(Map.prototype.set.call(values,"x",error),"x",error),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-call-long-get-rewrite-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return(Map.prototype.get as(...args:unknown[])=>any).call(Map.prototype.set.call(values,"x",error),"x",0,0,Object.assign(error,{stack:"fixed"})).stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-call-long-get-quiet',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return(Map.prototype.get as(...args:unknown[])=>any).call(Map.prototype.set.call(values,"x",error),"x",0,0,0).stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-call-long-set-rewrite-pin',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call((Map.prototype.set as(...args:unknown[])=>any).call(values,"x",error,0,Object.assign(error,{stack:"fixed"})),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
  {
    id: 'supplied-call-long-set-quiet',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>,key:string="x"){return Map.prototype.get.call((Map.prototype.set as(...args:unknown[])=>any).call(values,"x",error,0,0),"x").stack;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'chain-loop-condition-use',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>){let result:unknown;let i=0;do{result=Map.prototype.get.call(Map.prototype.set.call(values,"x",error),"x").stack;}while((void error,i++<1));return result;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: true,
    refused: true,
  },
  {
    id: 'chain-loop-condition-data',
    source:
      'function frames(error:Error,values:Map<string,{stack:string;message?:string}>){let result:unknown;let i=0;do{result=Map.prototype.get.call(Map.prototype.set.call(values,"x",{stack:"fixed"}),"x").stack;}while((void values,i++<1));return result;}',
    invocation: 'frames(new Error("ours"),new Map())',
    reader: false,
    refused: false,
  },
] as const;

describe('native supplied Map chain words', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'supplied-map-chains.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(reader);
  });
});

describe('shared supplied Map chain admission', () => {
  let api: API;
  const apps: Application[] = [];
  const observations: unknown[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    const file = process.env['RECOVERY_FORWARDING_OBSERVATIONS'];
    if (file !== undefined) writeFileSync(file, JSON.stringify(observations, null, 2));
    api[Symbol.dispose]();
    await Promise.all(apps.map(async (app) => removed(app)));
  });

  it.each(CASES)('$id', async ({ id, source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compiledApp(app, api).refusals.map((item) => item.reason);
    observations.push({ id, source, expectedRefused: refused, reasons });
    const shared = expect.stringContaining('a shared module that answers otherwise');

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
