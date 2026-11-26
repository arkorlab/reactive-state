import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'all-single-review',
    source: 'async function frames(error:Error){return(await Promise.all([error]))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'all-supplied-message',
    source: 'async function frames(error:Error){return(await Promise.all([error]))[0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'all-second-slot',
    source:
      'async function frames(error:Error){return(await Promise.all([{stack:"fixed"},error]))[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'all-resolve-envelope',
    source:
      'async function frames(error:Error){return(await Promise.all([Promise.resolve(error)]))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'all-nested-resolve-envelope',
    source:
      'async function frames(error:Error){return(await Promise.all([Promise.resolve(Promise.resolve(error))]))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'all-array-alias',
    source:
      'async function frames(error:Error){const input=[error];const alias=input;return(await Promise.all(alias))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'all-error-alias',
    source:
      'async function frames(error:Error){const value=error;return(await Promise.all([value]))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'all-native-constructor-alias',
    source:
      'async function frames(error:Error){const Native=Promise;return(await Native.all([error]))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'all-global-computed',
    source:
      'async function frames(error:Error){const index=0;return(await globalThis.Promise["all"]([error]))[index]!["stack"];}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'all-fresh-error-frames',
    source:
      'async function frames(error:Error){return(await Promise.all([new Error("fixed")]))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'all-fresh-resolved-frames',
    source:
      'async function frames(error:Error){return(await Promise.all([Promise.resolve(new TypeError("fixed"))]))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'all-data-pin',
    source:
      'async function frames(error:Error){return(await Promise.all([{stack:"fixed"}]))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-first-data-pin',
    source:
      'async function frames(error:Error){return(await Promise.all([{stack:"fixed"},error]))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-local-words-pin',
    source:
      'async function frames(error:Error){return(await Promise.all([new Error("fixed")]))[0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-resolved-local-words-pin',
    source:
      'async function frames(error:Error){return(await Promise.all([Promise.resolve(new TypeError("fixed"))]))[0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-empty-pin',
    source:
      'async function frames(error:Error){return(await(Promise.all as(values:unknown[])=>Promise<{stack?:string}[]>)([]))[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-hole-pin',
    source:
      'async function frames(error:Error){return(await(Promise.all as(values:unknown[])=>Promise<{stack?:string}[]>)([,error]))[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-after-hole-control',
    source: 'async function frames(error:Error){return(await Promise.all([,error]))[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'all-past-end-pin',
    source:
      'async function frames(error:Error){return(await(Promise.all as(values:unknown[])=>Promise<{stack?:string}[]>)([error]))[2]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-local-promise-pin',
    source:
      'async function frames(error:Error){const Promise={all(_input:unknown){return[{stack:"fixed"}];}};return(await Promise.all([error]))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-own-callee-pin',
    source:
      'async function frames(error:Error){const holder={all(_input:unknown){return[{stack:"fixed"}];}};return(await holder.all([error]))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-ignored-argument-rewrite-pin',
    source:
      'async function frames(error:Error){return(await(Promise.all as(...args:unknown[])=>Promise<{stack?:string}[]>)([error],Object.assign(error,{stack:"fixed"})))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-resolve-tail-rewrite-pin',
    source:
      'async function frames(error:Error){return(await Promise.all([(Promise.resolve as(...args:unknown[])=>Promise<Error>)(error,Object.assign(error,{stack:"fixed"}))]))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-later-then-getter-rewrite-pin',
    source:
      'async function frames(error:Error){const later={get then(){Object.assign(error,{stack:"fixed"});return undefined;}};return(await Promise.all([error,later]))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-later-source-effect-pin',
    source:
      'async function frames(error:Error){return(await Promise.all([error,Object.assign(error,{stack:"fixed"})]))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-prior-field-rewrite-pin',
    source:
      'async function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return(await Promise.all([error]))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-input-iterator-replacement-pin',
    source:
      'async function frames(error:Error){const input=[error];input[Symbol.iterator]=function*(){yield{stack:"fixed"}as Error;return undefined;};return(await Promise.all(input))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-saved-result-input-write-pin',
    source:
      'async function frames(error:Error){const values=await Promise.all([error]);Object.assign(error,{stack:"fixed"});return values[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-saved-element-field-write-pin',
    source:
      'async function frames(error:Error){const value=(await Promise.all([error]))[0]!;Object.assign(value,{stack:"fixed"});return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-saved-result-opaque-pin',
    source:
      'async function frames(error:Error){const values=await Promise.all([error]);return values[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-computed-key-effect-pin',
    source:
      'async function frames(error:Error){return(await Promise.all([error]))[(Object.assign(error,{stack:"fixed"}),0)]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'settled-review',
    source:
      'async function frames(error:Error){return(await(Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string;message?:string}}[]>)([error]))[0]!.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'settled-supplied-message',
    source:
      'async function frames(error:Error){return(await(Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string;message?:string}}[]>)([error]))[0]!.value.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'settled-resolve-envelope',
    source:
      'async function frames(error:Error){return(await(Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string;message?:string}}[]>)([Promise.resolve(error)]))[0]!.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'settled-second-slot',
    source:
      'async function frames(error:Error){return(await(Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string;message?:string}}[]>)([{stack:"fixed"},error]))[1]!.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'settled-assertion-review',
    source:
      'async function frames(error:Error){return((await Promise.allSettled([error]))[0]!as PromiseFulfilledResult<Error>).value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'settled-array-alias',
    source:
      'async function frames(error:Error){const input=[error];return(await(Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string;message?:string}}[]>)(input))[0]!.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'settled-fresh-frames',
    source:
      'async function frames(error:Error){return(await(Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string;message?:string}}[]>)([new Error("fixed")]))[0]!.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'settled-plain-data-pin',
    source:
      'async function frames(error:Error){return(await(Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string;message?:string}}[]>)([{stack:"fixed"}]))[0]!.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'settled-local-words-pin',
    source:
      'async function frames(error:Error){return(await(Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string;message?:string}}[]>)([new Error("fixed")]))[0]!.value.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'settled-status-data-pin',
    source:
      'async function frames(error:Error){return(await Promise.allSettled([error]))[0]!.status;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'settled-empty-pin',
    source:
      'async function frames(error:Error){return(await(Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string;message?:string}}[]>)([]))[0]?.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'settled-saved-result-write-pin',
    source:
      'async function frames(error:Error){const values=await(Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string;message?:string}}[]>)([error]);Object.assign(error,{stack:"fixed"});return values[0]!.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'settled-saved-element-write-pin',
    source:
      'async function frames(error:Error){const value=(await(Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string;message?:string}}[]>)([error]))[0]!.value;Object.assign(value,{stack:"fixed"});return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'settled-local-promise-pin',
    source:
      'async function frames(error:Error){const Promise={allSettled(_input:unknown){return[{value:{stack:"fixed"}}];}};return(await Promise.allSettled([error]))[0]!.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'settled-ignored-tail-rewrite-pin',
    source:
      'async function frames(error:Error){return(await(Promise.allSettled as(...args:unknown[])=>Promise<{value:{stack?:string}}[]>)([error],Object.assign(error,{stack:"fixed"})))[0]!.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'settled-rejection-not-fulfillment-pin',
    source:
      'async function frames(error:Error){return((await Promise.allSettled([Promise.reject(error)]))[0]!as PromiseRejectedResult).reason.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-prefix-bridge-pin',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void){prepare();return(await Promise.all([value]))[0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-quiet-prefix-control',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void){const unused=0;return(await Promise.all([value]))[0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'all-same-owner-alias-control',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void){const picked=value;return(await Promise.all([picked]))[0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'all-captured-owner-bridge-pin',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void){prepare();async function read(){return(await Promise.all([value]))[0]!.stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-default-bridge-pin',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void,unused=prepare()){return(await Promise.all([value]))[0]!.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-destructure-bridge-pin',
    source:
      'async function frames(error:Error){async function collect(value:Error,{ready}:{readonly ready:string}){return(await Promise.all([value]))[0]!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'all-field-getter-bridge-pin',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:{readonly ready:string}){const ready=prepare.ready;return(await Promise.all([value]))[0]!.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'allSettled-prefix-bridge-pin',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void){prepare();return(await (Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string}}[]>)([value]))[0]!.value.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'allSettled-quiet-prefix-control',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void){const unused=0;return(await (Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string}}[]>)([value]))[0]!.value.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'allSettled-same-owner-alias-control',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void){const picked=value;return(await (Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string}}[]>)([picked]))[0]!.value.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'allSettled-captured-owner-bridge-pin',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void){prepare();async function read(){return(await (Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string}}[]>)([value]))[0]!.value.stack;}return read();}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'allSettled-default-bridge-pin',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:()=>void,unused=prepare()){return(await (Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string}}[]>)([value]))[0]!.value.stack;}return collect(error,()=>{Object.assign(error,{stack:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'allSettled-destructure-bridge-pin',
    source:
      'async function frames(error:Error){async function collect(value:Error,{ready}:{readonly ready:string}){return(await (Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string}}[]>)([value]))[0]!.value.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'allSettled-field-getter-bridge-pin',
    source:
      'async function frames(error:Error){async function collect(value:Error,prepare:{readonly ready:string}){const ready=prepare.ready;return(await (Promise.allSettled as(values:readonly unknown[])=>Promise<{value:{stack?:string}}[]>)([value]))[0]!.value.stack;}return collect(error,{get ready(){Object.assign(error,{stack:"fixed"});return "done";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
] as const;

describe('native Promise batches words', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'promise-batches-forwarding.ts', source);
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

describe('shared native Promise batches admission', () => {
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
