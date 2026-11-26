import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'weak-chain-review',
    source:
      'function frames(error:Error){const key={};return new WeakMap<object,{stack?:string}>().set(key,error).get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-statement-review',
    source:
      'function frames(error:Error){const key={};const values=new WeakMap<object,{stack?:string}>();values.set(key,error);return values.get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-borrowed-chain',
    source:
      'function frames(error:Error){const key={};return(WeakMap.prototype.get.call(WeakMap.prototype.set.call(new WeakMap(),key,error),key)as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-data-pin',
    source:
      'function frames(error:Error){const key={};return new WeakMap<object,{stack?:string}>().set(key,{stack:"fixed"}).get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-replaced-data-pin',
    source:
      'function frames(error:Error){const key={};const values=new WeakMap<object,{stack?:string}>();values.set(key,error);values.set(key,{stack:"fixed"});return values.get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-other-key-pin',
    source:
      'function frames(error:Error){const key={};const other={};const values=new WeakMap<object,{stack?:string}>();values.set(other,error);values.set(key,{stack:"fixed"});return values.get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  // Through a set that answers another WeakMap, the get reads the declared value type.
  {
    id: 'weak-own-set-pin',
    source:
      'function frames(error:Error){const key={};const values=new WeakMap<object,{stack?:string}>();values.set=function(){return new WeakMap([[key,{stack:"fixed"}]]);};return values.set(key,error).get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-own-set-borrows-call',
    source:
      'function frames(error:Error){const key={};const weak=new WeakMap<object,{message:string}>([[key,{message:"fixed"}]]);weak.set=function(k:object,v:{message:string}){return WeakMap.prototype.set.call(this,k,v);};weak.set(key,error);return weak.get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-own-set-borrows-reflect',
    source:
      'function frames(error:Error){const key={};const weak=new WeakMap<object,{message:string}>([[key,{message:"fixed"}]]);weak.set=function(k:object,v:{message:string}){return Reflect.apply(WeakMap.prototype.set,this,[k,v]);};weak.set(key,error);return weak.get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-possible-own-set',
    source:
      'function frames(error:Error,flag:boolean){const key={};const weak=new WeakMap<object,{message:string}>([[key,{message:"fixed"}]]);if(flag)weak.set=()=>weak;weak.set(key,error);return weak.get(key)!.message;}',
    invocation: 'frames(new Error("ours"),false)',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-own-get-borrows-call',
    source:
      'function frames(error:Error){const key={};const weak=new WeakMap<object,{message:string}>([[key,error]]);weak.get=function(k:object){return WeakMap.prototype.get.call(this,k);};return weak.get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-own-get-borrows-after-write',
    source:
      'function frames(error:Error){const key={};const weak=new WeakMap<object,{message:string}>([[key,{message:"fixed"}]]);weak.get=function(k:object){return WeakMap.prototype.get.call(this,k);};weak.set(key,error);return weak.get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-own-get-unread-body',
    source:
      'function frames(error:Error){const key={};const weak=new WeakMap<object,{message:string}|Error>([[key,{message:"fixed"}]]);weak.get=function(k:object){if(k)return error;return {message:"fixed"};};return weak.get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  // Re-pinned: `this` handed to a borrowed native get inside an own method escapes (round 4).
  {
    id: 'weak-own-get-borrows-data-pin',
    source:
      'function frames(error:Error){void error;const key={};const weak=new WeakMap<object,{message:string}>([[key,{message:"fixed"}]]);weak.get=function(k:object){return WeakMap.prototype.get.call(this,k);};weak.set(key,{message:"fixed"});return weak.get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-unknown-get-other-key-write',
    source:
      'function frames(error:Error){const key={};const other={};const weak=new WeakMap<object,{message:string}>([[key,{message:"fixed"}]]);const methods=[function(this:WeakMap<object,{message:string}>,k:object){void k;return WeakMap.prototype.get.call(this,other);}];weak.get=methods[0]!;weak.set(other,error);return weak.get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-native-get-reinstalled-pin',
    source:
      'function frames(error:Error){const bad={};const safe={};const weak=new WeakMap<object,{message:string}>([[safe,{message:"fixed"}]]);weak.set(bad,error);weak.get=WeakMap.prototype.get;return weak.get(safe)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-own-set-returns-this-pin',
    source:
      'function frames(error:Error){const key={};const weak=new WeakMap<object,{message:string}>([[key,{message:"fixed"}]]);weak.set=function(){return this;};weak.set(key,error);return weak.get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-native-set-data-pin',
    source:
      'function frames(error:Error){void error;const key={};const weak=new WeakMap<object,{message:string}>([[key,{message:"fixed"}]]);weak.set(key,{message:"fixed"});return weak.get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-possible-own-set-data-pin',
    source:
      'function frames(error:Error,flag:boolean){void error;const key={};const weak=new WeakMap<object,{message:string}>([[key,{message:"fixed"}]]);if(flag)weak.set=()=>weak;weak.set(key,{message:"fixed"});return weak.get(key)!.message;}',
    invocation: 'frames(new Error("ours"),false)',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-whole-key-alias',
    source:
      'function frames(error:Error){const key={};const alias=key;const values=new WeakMap<object,{stack?:string}>();values.set(alias,error);return values.get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-whole-map-alias',
    source:
      'function frames(error:Error){const key={};const values=new WeakMap<object,{message:string}>();const alias=values;alias.set(key,error);return values.get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-global-constructor-alias',
    source:
      'function frames(error:Error){const Native=globalThis.WeakMap;const key={};return new Native<object,{message:string}>().set(key,error).get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-computed-methods',
    source:
      'function frames(error:Error){const key={};return new WeakMap<object,{message:string}>()["set"](key,error)["get"](key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-borrowed-statement',
    source:
      'function frames(error:Error){const key={};const values=new WeakMap<object,{stack?:string}>();WeakMap.prototype.set.call(values,key,error);return values.get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-reflect-apply',
    source:
      'function frames(error:Error){const key={};const values=new WeakMap<object,{stack?:string}>();Reflect.apply(WeakMap.prototype.set,values,[key,error]);return(Reflect.apply(WeakMap.prototype.get,values,[key])as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-borrowed-apply-chain',
    source:
      'function frames(error:Error){const key={};return(WeakMap.prototype.get.apply(WeakMap.prototype.set.apply(new WeakMap(),[key,error]),[key])as{stack?:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-branch-write',
    source:
      'function frames(error:Error,flag:boolean){const key={};const values=new WeakMap<object,{message:string}>([[key,{message:"fixed"}]]);if(flag)values.set(key,error);return values.get(key)!.message;}',
    invocation: 'frames(new Error("ours"),true)',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-last-error-chain',
    source:
      'function frames(error:Error){const key={};return new WeakMap<object,{message:string}>().set(key,{message:"fixed"}).set(key,error).get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-local-error-stack',
    source:
      'function frames(error:Error){const key={};return new WeakMap<object,{stack?:string}>().set(key,new Error("fixed")).get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-last-data-chain-pin',
    source:
      'function frames(error:Error){const key={};return new WeakMap<object,{message:string}>().set(key,error).set(key,{message:"fixed"}).get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-key-alias-data-pin',
    source:
      'function frames(error:Error){const key={};const alias=key;const values=new WeakMap<object,{message:string}>();values.set(key,error);values.set(alias,{message:"fixed"});return values.get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-local-error-message-pin',
    source:
      'function frames(error:Error){const key={};return new WeakMap<object,{message:string}>().set(key,new Error("fixed")).get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-own-get-pin',
    source:
      'function frames(error:Error){const key={};const values=new WeakMap<object,{message:string}>();values.set(key,error);values.get=()=>({message:"fixed"});return values.get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  // A set the reader cannot prove answers the WeakMap leaves the get the declared value type.
  {
    id: 'weak-own-set-returns-self-pin',
    source:
      'function frames(error:Error){const key={};const values=new WeakMap<object,{message:string}>([[key,{message:"fixed"}]]);values.set=()=>values;return values.set(key,error).get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-later-write-pin',
    source:
      'function frames(error:Error){const key={};const values=new WeakMap<object,{message:string}>([[key,{message:"fixed"}]]);const answer=values.get(key)!.message;values.set(key,error);return answer;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-false-branch-pin',
    source:
      'function frames(error:Error){const key={};const values=new WeakMap<object,{message:string}>([[key,{message:"fixed"}]]);if(false)values.set(key,error);return values.get(key)!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-prior-stack-write-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});const key={};return new WeakMap<object,{stack?:string}>().set(key,error).get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-later-key-rewrites-pin',
    source:
      'function frames(error:Error){const key={};return new WeakMap<object,{stack?:string}>().set(key,error).get(Object.assign(key,{unused:Object.assign(error,{stack:"fixed"})}))!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-ignored-set-tail-rewrites-pin',
    source:
      'function frames(error:Error){const key={};const values=new WeakMap<object,{stack?:string}>();(values.set as(...args:unknown[])=>unknown)(key,error,Object.assign(error,{stack:"fixed"}));return values.get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-ignored-get-tail-rewrites-pin',
    source:
      'function frames(error:Error){const key={};const values=new WeakMap<object,{stack?:string}>();values.set(key,error);return(values.get as(...args:unknown[])=>{stack?:string})(key,Object.assign(error,{stack:"fixed"})).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-reflect-tail-rewrites-pin',
    source:
      'function frames(error:Error){const key={};return(Reflect.apply as(...args:unknown[])=>{stack?:string})(WeakMap.prototype.get,WeakMap.prototype.set.call(new WeakMap(),key,error),[key],Object.assign(error,{stack:"fixed"})).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-apply-tail-rewrites-pin',
    source:
      'function frames(error:Error){const key={};return(WeakMap.prototype.get.apply as(...args:unknown[])=>{stack?:string})(WeakMap.prototype.set.call(new WeakMap(),key,error),[key],Object.assign(error,{stack:"fixed"})).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-quiet-ignored-tail',
    source:
      'function frames(error:Error){const key={};const values=new WeakMap<object,{stack?:string}>();(values.set as(...args:unknown[])=>unknown)(key,error,0);return(values.get as(...args:unknown[])=>{stack?:string})(key,0).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-local-constructor-pin',
    source:
      'function frames(error:Error){const WeakMap=class{set(_key:unknown,_value:unknown){return this;}get(_key:unknown){return{stack:"fixed"};}};const key={};return new WeakMap().set(key,error).get(key).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-existing-pin',
    source:
      'function frames(error:Error){return new Map<string,{message:string}>().set("x",error).get("x")!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-opaque-key-replacement-pin',
    source:
      'function frames(error:Error,key:object){return new WeakMap<object,{stack?:string}>().set(key,error).set(key,{stack:"fixed"}).get(key)!.stack;}',
    invocation: 'frames(new Error("ours"),{})',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-ignored-constructor-options-pin',
    source:
      'function frames(error:Error){const key={};const values=new WeakMap<object,{stack?:string}>();(values.set as(...args:unknown[])=>unknown)(key,error,new Error("ignored",{get cause(){Object.assign(error,{stack:"fixed"});return 0;}}));return values.get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-quiet-ignored-constructor-control',
    source:
      'function frames(error:Error){const key={};const values=new WeakMap<object,{stack?:string}>();(values.set as(...args:unknown[])=>unknown)(key,error,new Error("ignored"));return values.get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-ignored-constructor-tail-data-pin',
    source:
      'function frames(error:Error){const key={};return new(WeakMap as new(...args:unknown[])=>WeakMap<object,{stack?:string}>)([],Object.assign(error,{stack:"fixed"})).set(key,error).get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'weak-evaluated-iterable-creation-data-pin',
    source:
      'function frames(error:Error){const key={};return new WeakMap<object,{stack?:string}>(Object.assign([],{side:Object.assign(error,{stack:"fixed"})})).set(key,error).get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'weak-quiet-constructor-sensitive-control',
    source:
      'function frames(error:Error){const key={};return new WeakMap<object,{stack?:string}>([]).set(key,error).get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'weak-entry-accessor-rewrites-pin',
    source:
      'function frames(error:Error){const key={};return new WeakMap<object,{stack?:string}>([{get 0(){Object.assign(error,{stack:"fixed"});return key;},1:{stack:"fixed"}}]as unknown as[object,{stack?:string}][]).set(key,error).get(key)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-saved-get-later-field-write-pin',
    source:
      'function frames(error:Error){const key={};const selected=new WeakMap<object,{stack?:string}>().set(key,error).get(key)!;Object.assign(error,{stack:"fixed"});return selected.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-saved-alias-field-write-pin',
    source:
      'function frames(error:Error){const key={};const selected=new WeakMap<object,{stack?:string}>().set(key,error).get(key)!;Object.assign(selected,{stack:"fixed"});return selected.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-saved-get-opaque-pin',
    source:
      'function frames(error:Error){const key={};const selected=new WeakMap<object,{stack?:string}>().set(key,error).get(key)!;return selected.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
] as const;

describe('native WeakMap writes words', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'weak-map-writes-forwarding.ts', source);
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

describe('shared native WeakMap writes admission', () => {
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
