import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-written native arguments retain their exact selected element behavior. */
const CASES = [
  {
    id: 'reported-omitted-value',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);(map.set as (key:string)=>unknown)("key");return map.get("key")?.stack??"fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'computed-set-omission',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);(map["set"] as (key:string)=>unknown)("key");return map.get("key")?.stack??"fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'whole-map-alias-omission',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);const alias=map;(alias.set as (key:string)=>unknown)("key");return map.get("key")?.stack??"fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'constant-key-omission',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);const key="key";(map.set as (key:string)=>unknown)(key);return map.get("key")?.stack??"fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'closed-spread-omission',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);(map.set as (...args:[string])=>unknown)(...(["key"] as [string]));return map.get("key")?.stack??"fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-call-omission',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);(Map.prototype.set.call as unknown as (receiver:Map<string,Error>,key:string)=>unknown)(map,"key");return map.get("key")?.stack??"fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-apply-omission',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);(Map.prototype.set.apply as unknown as (receiver:Map<string,Error>,args:[string])=>unknown)(map,["key"]);return map.get("key")?.stack??"fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reflected-omission',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);Reflect.apply(Map.prototype.set,map,["key"]);return map.get("key")?.stack??"fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-method-alias-omission',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);const set=Map.prototype.set;Reflect.apply(set,map,["key"]);return map.get("key")?.stack??"fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'same-receiver-set-chain',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);return (map.set as (key:string)=>typeof map)("key").get("key")?.stack??"fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'other-key-retains-error',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);(map.set as (key:string)=>unknown)("other");return map.get("key")?.stack??"fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unknown-key-retains-error',
    source:
      'function frames(error:Error,key:string){const map=new Map([["key",error]]);(map.set as (key:string)=>unknown)(key);return map.get("key")?.stack??"fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"),"other")',
  },
  {
    id: 'possible-branch-retains-error',
    source:
      'function frames(error:Error,flag:boolean){const map=new Map([["key",error]]);if(flag){(map.set as (key:string)=>unknown)("key");}return map.get("key")?.stack??"fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"),false)',
  },
  {
    id: 'own-set-retains-error',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);map.set=()=>map;(map.set as (key:string)=>unknown)("key");return map.get("key")?.stack??"fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'later-explicit-error-wins',
    source:
      'function frames(error:Error){const map=new Map([["key",new Error("fixed")]]);(map.set as (key:string)=>unknown)("key");map.set("key",error);return map.get("key")?.stack??"fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'opaque-apply-list-keeps-boundary',
    source:
      'function frames(error:Error,args:readonly unknown[]){const map=new Map([["key",error]]);Reflect.apply(Map.prototype.set,map,args);return map.get("key")?.stack??"fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"),["key",new Error("ours")])',
  },
  {
    id: 'exposed-apply-list-keeps-error',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);const args:(string|Error)[]=["key"];args.push(error);Reflect.apply(Map.prototype.set,map,args);return map.get("key")?.stack??"fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'explicit-generic-fallback-pin',
    source:
      'function frames(error:Error){const map=new Map<string,Error>([["key",error]]);(map.set as (key:string)=>unknown)("key");return map.get("key")?.stack??"fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'outer-error-assertion-pin',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);(map.set as (key:string)=>unknown)("key");const value=map.get("key") as Error|undefined;return value?.stack??"fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'own-get-fixed-result',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);map.get=()=>new Error("fixed");(map.set as (key:string)=>unknown)("key");return map.get("key")!.message;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-map-own-set',
    source:
      'class Map{set(_key:string){return this;}get(_key:string){return {stack:"fixed"};}}function frames(error:Error){const map=new Map();map.set("key");return map.get("key").stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unrelated-map-cannot-clear',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);const other=new Map([["key",error]]);(other.set as (key:string)=>unknown)("key");return map.get("key")?.stack??"fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'later-omission-cannot-clear-read',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);const value=map.get("key")?.stack??"fixed";(map.set as (key:string)=>unknown)("key");return value;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'later-local-words-win',
    source:
      'function frames(error:Error){const map=new Map([["key",error]]);(map.set as (key:string)=>unknown)("key");map.set("key",new Error("fixed"));return map.get("key")!.message;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'missing-key-keeps-existing-boundary',
    source:
      'function frames(error:Error){const map=new Map<undefined,Error>([[undefined,error]]);(map.set as ()=>unknown)();return map.get(undefined)?.stack??"fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
] as const;

describe('omitted native Map set value readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-map-omitted-values.ts', source);
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

describe('shared omitted native Map set values', () => {
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
