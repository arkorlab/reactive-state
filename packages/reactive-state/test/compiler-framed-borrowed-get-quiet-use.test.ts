import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A native `get` called on a Map through `call`, `apply` or `Reflect.apply` reads an entry and
 * replaces no method of the Map, as a borrowed `set` writes one entry and replaces none. The Map
 * handed to it is no use that may replace its `get`, in a loop that runs the call again or before a
 * read through the Map's own `get`: the entry the key names is the one that answers. A `get` the
 * file replaces, on the Map or on the prototype, still may answer any entry.
 */
const READ = '{stack?:string}';
const MAP = "const map=new Map<string,unknown>([['a','fixed'],['b',error]]);";

const CASES = [
  {
    id: 'reflect-apply-get-in-a-loop-data',
    source: `function frames(error:Error){${MAP}const args:[string]=['a'];let out:unknown;let i=0;do{out=Reflect.apply(Map.prototype.get,map,args);}while(i++<1);return (out as ${READ}).stack;}`,
    refused: false,
  },
  {
    id: 'call-get-in-a-loop-data',
    source: `function frames(error:Error){${MAP}let out:unknown;let i=0;do{out=Map.prototype.get.call(map,'a');}while(i++<1);return (out as ${READ}).stack;}`,
    refused: false,
  },
  {
    id: 'apply-get-in-a-loop-data',
    source: `function frames(error:Error){${MAP}let out:unknown;let i=0;do{out=Map.prototype.get.apply(map,['a']);}while(i++<1);return (out as ${READ}).stack;}`,
    refused: false,
  },
  {
    id: 'weak-map-call-get-in-a-loop-data',
    source: `function frames(error:Error){const key={};const map=new WeakMap<object,unknown>([[key,'fixed']]);let out:unknown;let i=0;do{out=WeakMap.prototype.get.call(map,key);}while(i++<1);return (out as ${READ}).stack;}`,
    refused: false,
  },
  {
    id: 'reflect-apply-get-before-own-get-data',
    source: `function frames(error:Error){${MAP}Reflect.apply(Map.prototype.get,map,['a']);return (map.get('a') as ${READ}).stack;}`,
    refused: false,
  },
  {
    id: 'call-get-in-a-loop-of-the-error-key',
    source: `function frames(error:Error){${MAP}let out:unknown;let i=0;do{out=Map.prototype.get.call(map,'b');}while(i++<1);return (out as ${READ}).stack;}`,
    refused: true,
  },
  {
    id: 'call-get-in-a-loop-own-get-replaced-after',
    source: `function frames(error:Error){const map=new Map<string,unknown>([['a','fixed']]);let out:unknown;let i=0;do{out=Map.prototype.get.call(map,'a');(map as unknown as {get:unknown}).get=()=>error;}while(i++<1);return (map.get('a') as ${READ}).stack;}`,
    refused: true,
  },
  {
    id: 'call-get-in-a-loop-prototype-get-replaced',
    source: `function frames(error:Error){const map=new Map<string,unknown>([['a','fixed']]);(Map.prototype as unknown as {get:unknown}).get=()=>error;let out:unknown;let i=0;do{out=Map.prototype.get.call(map,'a');}while(i++<1);return (out as ${READ}).stack;}`,
    refused: true,
  },
  {
    id: 'own-get-borrowing-by-name-prototype-get-replaced',
    source: `function frames(error:Error){const key={};const weak=new WeakMap<object,unknown>([[key,'fixed']]);(WeakMap.prototype as unknown as {get:unknown}).get=()=>error;weak.get=function(k:object){return WeakMap.prototype.get.call(weak,k);};return (weak.get(key) as ${READ}).stack;}`,
    refused: true,
  },
  {
    id: 'own-get-borrowing-by-this-prototype-get-replaced',
    source: `function frames(error:Error){const key={};const weak=new WeakMap<object,unknown>([[key,'fixed']]);(WeakMap.prototype as unknown as {get:unknown}).get=()=>error;weak.get=function(k:object){return WeakMap.prototype.get.call(this,k);};return (weak.get(key) as ${READ}).stack;}`,
    refused: true,
  },
  {
    id: 'own-get-borrowing-by-this-is-refused-as-the-own-method-escapes',
    source: `function frames(error:Error){void error;const key={};const weak=new WeakMap<object,{message:string}>([[key,{message:"fixed"}]]);weak.get=function(k:object){return WeakMap.prototype.get.call(this,k);};return weak.get(key)!.message;}`,
    refused: true,
  },
  {
    id: 'own-get-borrowing-by-name-data',
    source: `function frames(error:Error){void error;const key={};const weak=new WeakMap<object,unknown>([[key,'fixed']]);weak.get=function(k:object){return WeakMap.prototype.get.call(weak,k);};return (weak.get(key) as ${READ}).stack;}`,
    refused: false,
  },
  {
    id: 'call-get-in-a-loop-map-handed-to-a-function',
    source: `function handOn(value:unknown){void value;}function frames(error:Error){${MAP}let out:unknown;let i=0;do{out=Map.prototype.get.call(map,'a');handOn(map);}while(i++<1);return (out as ${READ}).stack;}`,
    refused: true,
  },
] as const;

describe('a Map handed to a borrowed native get', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error('ours'))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });

  it.each(CASES)('reads $id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'borrowed-get-quiet-use.ts', source);
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
