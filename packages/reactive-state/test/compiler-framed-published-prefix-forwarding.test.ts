import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'race-prefix-bridge-pin',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void){prepare();return(await Promise.race([value])).stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-quiet-prefix-control',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void){const unused=0;return(await Promise.race([value])).stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-same-owner-alias-control',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void){const picked=value;return(await Promise.race([picked])).stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-captured-owner-bridge-pin',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void){prepare();async function read(){return(await Promise.race([value])).stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-default-bridge-pin',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void,unused=prepare()){return(await Promise.race([value])).stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-destructure-bridge-pin',
    source:
      'async function frames(error:Error){async function collect(value:Error,{ready}:{readonly ready:string}){return(await Promise.race([value])).stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-field-getter-bridge-pin',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:{readonly ready:string}){const ready=prepare.ready;return(await Promise.race([value])).stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-map-prefix-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();const key={};const values=new WeakMap<object,{stack?:string}>();return values.set(key,value).get(key)!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-map-quiet-prefix-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const unused=0;const key={};const values=new WeakMap<object,{stack?:string}>();return values.set(key,value).get(key)!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-map-same-owner-alias-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const picked=value;const key={};const values=new WeakMap<object,{stack?:string}>();return values.set(key,picked).get(key)!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'weak-map-captured-owner-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){const key={};const values=new WeakMap<object,{stack?:string}>();return values.set(key,value).get(key)!.stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-map-default-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,unused=prepare()){const key={};const values=new WeakMap<object,{stack?:string}>();return values.set(key,value).get(key)!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-map-destructure-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,{ready}:{readonly ready:string}){const key={};const values=new WeakMap<object,{stack?:string}>();return values.set(key,value).get(key)!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-map-field-getter-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:{readonly ready:string}){const ready=prepare.ready;const key={};const values=new WeakMap<object,{stack?:string}>();return values.set(key,value).get(key)!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-group-prefix-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return Map.groupBy([value],()=>"failure").get("failure")![0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-group-quiet-prefix-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const unused=0;return Map.groupBy([value],()=>"failure").get("failure")![0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-group-same-owner-alias-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const picked=value;return Map.groupBy([picked],()=>"failure").get("failure")![0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-group-captured-owner-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){return Map.groupBy([value],()=>"failure").get("failure")![0]!.stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-group-default-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,unused=prepare()){return Map.groupBy([value],()=>"failure").get("failure")![0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-group-destructure-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,{ready}:{readonly ready:string}){return Map.groupBy([value],()=>"failure").get("failure")![0]!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-group-field-getter-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:{readonly ready:string}){const ready=prepare.ready;return Map.groupBy([value],()=>"failure").get("failure")![0]!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'weak-map-after-birth-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const key={};const values=new WeakMap<object,{stack?:string}>();prepare();return values.set(key,value).get(key)!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
] as const;

describe('native Published owner prefix words', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'published-owner-prefix.ts', source);
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

describe('shared native Published owner prefix admission', () => {
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
