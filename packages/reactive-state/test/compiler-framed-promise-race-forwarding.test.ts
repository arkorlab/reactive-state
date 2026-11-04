import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'race-single-review-case',
    source: 'async function frames(error:Error){return(await Promise.race([error])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-single-supplied-message',
    source: 'async function frames(error:Error){return(await Promise.race([error])).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-input-array-alias',
    source:
      'async function frames(error:Error){const input=[error];return(await Promise.race(input)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-input-whole-alias-chain',
    source:
      'async function frames(error:Error){const input=[error];const alias=input;return(await Promise.race(alias)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-native-constructor-alias',
    source:
      'async function frames(error:Error){const Native=Promise;return(await Native.race([error])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-error-value-alias',
    source:
      'async function frames(error:Error){const value=error;return(await Promise.race([value])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-native-global-this',
    source:
      'async function frames(error:Error){return(await globalThis.Promise.race([error])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-resolved-error',
    source:
      'async function frames(error:Error){return(await Promise.race([Promise.resolve(error)])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-nested-resolve-error',
    source:
      'async function frames(error:Error){return(await Promise.race([Promise.resolve(Promise.resolve(error))])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-first-error-before-data',
    source:
      'async function frames(error:Error){return(await Promise.race([error,{stack:"fixed"}])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-two-error-inputs',
    source: 'async function frames(error:Error){return(await Promise.race([error,error])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-first-resolved-error',
    source:
      'async function frames(error:Error){return(await Promise.race([Promise.resolve(error),{stack:"fixed"}])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-ordinary-data-pin',
    source:
      'async function frames(error:Error){return(await Promise.race([{stack:"fixed"}])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-first-data-before-error-pin',
    source:
      'async function frames(error:Error){return(await Promise.race([{stack:"fixed"},error])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-first-resolved-data-pin',
    source:
      'async function frames(error:Error){return(await Promise.race([Promise.resolve({stack:"fixed"}),error])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-local-words-pin',
    source:
      'async function frames(error:Error){return(await Promise.race([new Error("fixed")])).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-empty-input-pin',
    source: 'async function frames(error:Error){return(await Promise.race([]as Error[]))?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-leading-hole-pin',
    source: 'async function frames(error:Error){return(await Promise.race([,error]))?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-later-creation-rewrites-pin',
    source:
      'async function frames(error:Error){return(await Promise.race([error,Object.assign(error,{stack:"fixed"})])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-later-then-getter-rewrites-pin',
    source:
      'async function frames(error:Error){const later={get then(){Object.assign(error,{stack:"fixed"});return undefined;}};return(await Promise.race([error,later]as any[])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-prior-written-stack-pin',
    source:
      'async function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return(await Promise.race([error])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-input-later-written-stack-pin',
    source:
      'async function frames(error:Error){const input=[error];Object.defineProperty(error,"stack",{value:"fixed"});return(await Promise.race(input)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-ignored-tail-rewrites-pin',
    source:
      'async function frames(error:Error){return(await(Promise.race as(...args:unknown[])=>Promise<Error>)([error],Object.assign(error,{stack:"fixed"}))).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-quiet-tail-sensitivity',
    source:
      'async function frames(error:Error){return(await(Promise.race as(...args:unknown[])=>Promise<Error>)([error],0)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-local-promise-shadow-pin',
    source:
      'async function frames(error:Error){const Promise={race(_values:unknown){return globalThis.Promise.resolve({stack:"fixed"});}};return(await Promise.race([error])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-local-resolve-shadow-pin',
    source:
      'async function frames(error:Error){const Promise={race(values:{stack:string}[]){return globalThis.Promise.race(values);},resolve(_value:unknown){return{stack:"fixed"};}};return(await Promise.race([Promise.resolve(error)])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-own-iterable-override-pin',
    source:
      'async function frames(error:Error){const input=[error];input[Symbol.iterator]=()=>[{stack:"fixed"}].values()as never;return(await Promise.race(input)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-source-slot-replacement-pin',
    source:
      'async function frames(error:Error){const input:[{stack?:string}]=[error];input[0]={stack:"fixed"};return(await Promise.race(input)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-source-thenable-error-pin',
    source:
      'async function frames(error:Error){const value=Object.assign(error,{then(resolve:(value:{stack:string})=>unknown){return resolve({stack:"fixed"});}});return(await Promise.race([value])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-annotated-thenable-error-pin',
    source:
      'async function frames(error:Error&{then(resolve:(value:{stack:string})=>unknown):unknown}){return(await Promise.race([error])).stack;}',
    invocation:
      'frames(Object.assign(new Error("ours"),{then(resolve:(value:{stack:string})=>unknown){return resolve({stack:"fixed"});}}))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-resolve-ignored-argument-rewrites-pin',
    source:
      'async function frames(error:Error){return(await Promise.race([(Promise.resolve as(...args:unknown[])=>Promise<Error>)(error,Object.assign(error,{stack:"fixed"}))])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-resolve-quiet-tail-sensitivity',
    source:
      'async function frames(error:Error){return(await Promise.race([(Promise.resolve as(...args:unknown[])=>Promise<Error>)(error,0)])).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-saved-result-later-stack-data-pin',
    source:
      'async function frames(error:Error){const value=await Promise.race([error]);Object.assign(error,{stack:"fixed"});return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'race-saved-result-later-message-data-pin',
    source:
      'async function frames(error:Error){const value=await Promise.race([error]);Object.assign(error,{message:"fixed"});return value.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'race-saved-alias-stack-pin',
    source:
      'async function frames(error:Error){const value=await Promise.race([error]);Object.assign(value,{stack:"fixed"});return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-saved-alias-message-pin',
    source:
      'async function frames(error:Error){const value=await Promise.race([error]);Object.assign(value,{message:"fixed"});return value.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-saved-result-opaque-pin',
    source:
      'async function frames(error:Error){const value=await Promise.race([error]);return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'race-transparent-cast-computed-control',
    source:
      'async function frames(error:Error){return((await Promise.race([error]))as{stack?:string})["stack"];}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-constant-computed-control',
    source:
      'async function frames(error:Error){const key="stack";return(await Promise.race([error]))[key];}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'race-effectful-computed-key-pin',
    source:
      'async function frames(error:Error){return(await Promise.race([error]))[(Object.assign(error,{stack:"fixed"}),"stack")];}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
] as const;

describe('native Promise race words', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'promise-race-forwarding.ts', source);
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

describe('shared native Promise race admission', () => {
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
