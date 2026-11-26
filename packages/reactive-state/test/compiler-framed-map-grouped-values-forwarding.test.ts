import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'group-direct-review',
    source:
      'function frames(error:Error){return Map.groupBy([error],()=>"failure").get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-supplied-message',
    source:
      'function frames(error:Error){return Map.groupBy([error],()=>"failure").get("failure")![0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-global-bracket',
    source:
      'function frames(error:Error){return globalThis.Map["groupBy"]([error],()=>"failure").get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-constructor-alias',
    source:
      'function frames(error:Error){const Native=Map;return Native.groupBy([error],()=>"failure").get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-input-whole-alias',
    source:
      'function frames(error:Error){const input=[error];const alias=input;return Map.groupBy(alias,()=>"failure").get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-result-whole-alias',
    source:
      'function frames(error:Error){const groups=Map.groupBy([error],()=>"failure");const alias=groups;return alias.get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-callback-alias',
    source:
      'function frames(error:Error){const classify=()=>"failure";const alias=classify;return Map.groupBy([error],alias).get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-callback-block',
    source:
      'function frames(error:Error){return Map.groupBy([error],function(){return"failure";}).get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-key-constant-alias',
    source:
      'function frames(error:Error){const key="failure";return Map.groupBy([error],()=>key).get(key)![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-second-element',
    source:
      'function frames(error:Error){return Map.groupBy([{stack:"fixed"},error],()=>"failure").get("failure")![1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-numeric-key',
    source: 'function frames(error:Error){return Map.groupBy([error],()=>1).get(1)![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-boolean-key',
    source:
      'function frames(error:Error){return Map.groupBy([error],()=>true).get(true)![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-borrowed-get',
    source:
      'function frames(error:Error){return(Map.prototype.get.call(Map.groupBy([error],()=>"failure"),"failure")as Error[])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-reflect-get',
    source:
      'function frames(error:Error){return(Reflect.apply(Map.prototype.get,Map.groupBy([error],()=>"failure"),["failure"])as Error[])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-quiet-get-tail',
    source:
      'function frames(error:Error){return(Map.groupBy([error],()=>"failure").get as(...args:unknown[])=>Error[])("failure",0)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-quiet-group-tail',
    source:
      'function frames(error:Error){return(Map.groupBy as(...args:unknown[])=>Map<string,Error[]>)([error],()=>"failure",0).get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'group-plain-data-pin',
    source:
      'function frames(error:Error){return Map.groupBy([{stack:"fixed"}],()=>"failure").get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-first-data-pin',
    source:
      'function frames(error:Error){return Map.groupBy([{stack:"fixed"},error],()=>"failure").get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-local-words-pin',
    source:
      'function frames(error:Error){return Map.groupBy([new Error("fixed")],()=>"failure").get("failure")![0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-absent-key-pin',
    source:
      'function frames(error:Error){return Map.groupBy([error],()=>"failure").get("other")?.[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-out-of-range-pin',
    source:
      'function frames(error:Error){return Map.groupBy([error],()=>"failure").get("failure")?.[1]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-hole-first-pin',
    source:
      'function frames(error:Error){return Map.groupBy([,error],()=>"failure").get("failure")?.[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-callback-rewrites-pin',
    source:
      'function frames(error:Error){return Map.groupBy([error],()=>{Object.assign(error,{stack:"fixed"});return"failure";}).get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-prior-written-stack-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return Map.groupBy([error],()=>"failure").get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-input-creation-rewrites-pin',
    source:
      'function frames(error:Error){return Map.groupBy([error,{stack:"fixed",unused:Object.assign(error,{stack:"fixed"})}],()=>"failure").get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-ignored-group-tail-rewrites-pin',
    source:
      'function frames(error:Error){return(Map.groupBy as(...args:unknown[])=>Map<string,Error[]>)([error],()=>"failure",Object.assign(error,{stack:"fixed"})).get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-ignored-get-tail-rewrites-pin',
    source:
      'function frames(error:Error){return(Map.groupBy([error],()=>"failure").get as(...args:unknown[])=>Error[])("failure",Object.assign(error,{stack:"fixed"}))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-ignored-reflect-tail-rewrites-pin',
    source:
      'function frames(error:Error){return(Reflect.apply as(...args:unknown[])=>Error[])(Map.prototype.get,Map.groupBy([error],()=>"failure"),["failure"],Object.assign(error,{stack:"fixed"}))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-own-get-pin',
    source:
      'function frames(error:Error){const groups=Map.groupBy([error],()=>"failure");groups.get=()=>[Object.assign(error,{stack:"fixed"})];return groups.get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-replaced-entry-pin',
    source:
      'function frames(error:Error){const groups=Map.groupBy<string,{stack?:string}>([error],()=>"failure");groups.set("failure",[{stack:"fixed"}]);return groups.get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'group-local-constructor-pin',
    source:
      'function frames(error:Error){const Map={groupBy(values:unknown[],key:()=>string){return new globalThis.Map([[key(),[{stack:"fixed"}]]]);}};return Map.groupBy([error],()=>"failure").get("failure")![0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
] as const;

describe('native Map grouped values words', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'map-grouped-values-forwarding.ts', source);
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

describe('shared native Map grouped values admission', () => {
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
