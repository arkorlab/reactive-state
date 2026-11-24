import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'array-values-prefix-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return [value].values().next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-values-quiet-prefix-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const unused=0;return [value].values().next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-values-same-owner-alias-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const picked=value;return [picked].values().next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'array-values-captured-owner-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){return [value].values().next().value!.stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-values-default-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,unused=prepare()){return [value].values().next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-values-destructure-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,{ready}:{readonly ready:string}){return [value].values().next().value!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-values-field-getter-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:{readonly ready:string}){const ready=prepare.ready;return [value].values().next().value!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-values-saved-value-write-pin',
    source:
      'function frames(error:Error){function collect(value:Error){const picked=[value].values().next().value!;Object.assign(value,{stack:"fixed"});return picked.stack;}return collect(error);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'array-values-saved-step-write-pin',
    source:
      'function frames(error:Error){function collect(value:Error){const step=[value].values().next();Object.assign(step.value!,{stack:"fixed"});return step.value!.stack;}return collect(error);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-default-prefix-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return new Set([value])[Symbol.iterator]().next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-default-quiet-prefix-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const unused=0;return new Set([value])[Symbol.iterator]().next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-default-same-owner-alias-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const picked=value;return new Set([picked])[Symbol.iterator]().next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'set-default-captured-owner-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){return new Set([value])[Symbol.iterator]().next().value!.stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-default-default-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,unused=prepare()){return new Set([value])[Symbol.iterator]().next().value!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-default-destructure-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,{ready}:{readonly ready:string}){return new Set([value])[Symbol.iterator]().next().value!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-default-field-getter-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:{readonly ready:string}){const ready=prepare.ready;return new Set([value])[Symbol.iterator]().next().value!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-default-saved-value-write-pin',
    source:
      'function frames(error:Error){function collect(value:Error){const picked=new Set([value])[Symbol.iterator]().next().value!;Object.assign(value,{stack:"fixed"});return picked.stack;}return collect(error);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'set-default-saved-step-write-pin',
    source:
      'function frames(error:Error){function collect(value:Error){const step=new Set([value])[Symbol.iterator]().next();Object.assign(step.value!,{stack:"fixed"});return step.value!.stack;}return collect(error);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-default-prefix-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return new Map<string,{stack?:string}>([["failure",value]])[Symbol.iterator]().next().value![1].stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-default-quiet-prefix-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const unused=0;return new Map<string,{stack?:string}>([["failure",value]])[Symbol.iterator]().next().value![1].stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-default-same-owner-alias-control',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){const picked=value;return new Map<string,{stack?:string}>([["failure",picked]])[Symbol.iterator]().next().value![1].stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-default-captured-owner-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){return new Map<string,{stack?:string}>([["failure",value]])[Symbol.iterator]().next().value![1].stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-default-default-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,unused=prepare()){return new Map<string,{stack?:string}>([["failure",value]])[Symbol.iterator]().next().value![1].stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-default-destructure-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,{ready}:{readonly ready:string}){return new Map<string,{stack?:string}>([["failure",value]])[Symbol.iterator]().next().value![1].stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-default-field-getter-bridge-pin',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:{readonly ready:string}){const ready=prepare.ready;return new Map<string,{stack?:string}>([["failure",value]])[Symbol.iterator]().next().value![1].stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-default-saved-value-write-pin',
    source:
      'function frames(error:Error){function collect(value:Error){const picked=new Map<string,{stack?:string}>([["failure",value]])[Symbol.iterator]().next().value![1];Object.assign(value,{stack:"fixed"});return picked.stack;}return collect(error);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-default-saved-step-write-pin',
    source:
      'function frames(error:Error){function collect(value:Error){const step=new Map<string,{stack?:string}>([["failure",value]])[Symbol.iterator]().next();Object.assign(step.value![1],{stack:"fixed"});return step.value![1].stack;}return collect(error);}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-default-primitive-alias-overwrite-pin',
    source:
      'function frames(error:Error){const first="failure";const last="failure";return new Map<string,{stack?:string}>([[first,error],[last,{stack:"fixed"}]])[Symbol.iterator]().next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'map-default-primitive-alias-distinct-control',
    source:
      'function frames(error:Error){const first="failure";const last="other";return new Map<string,{stack?:string}>([[first,error],[last,{stack:"fixed"}]])[Symbol.iterator]().next().value![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'map-default-object-alias-overwrite-pin',
    source:
      'function frames(error:Error){const key={};const alias=key;return new Map<object,{stack?:string}>([[key,error],[alias,{stack:"fixed"}]])[Symbol.iterator]().next().value![1].stack;}',
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
