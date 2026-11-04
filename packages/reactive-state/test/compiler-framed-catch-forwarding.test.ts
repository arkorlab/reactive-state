import { writeFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application, compiledApp, removed } from './fixtures/application.ts';

const CASES = [
  {
    id: 'catch-omitted-local-frames',
    source:
      'async function frames(error:Error){return(await Promise.resolve(new Error("fixed")).catch()).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'catch-omitted-supplied-words',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).catch()).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'catch-undefined-handler',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).catch(undefined)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'catch-void-handler',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).catch(void 0)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'catch-constant-undefined-handler',
    source:
      'async function frames(error:Error){const handler=undefined;return(await Promise.resolve(error).catch(handler)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'catch-computed-method',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error)["catch"]()).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'catch-native-constructor-alias',
    source:
      'const NativePromise=Promise;async function frames(error:Error){return(await NativePromise.resolve(error).catch()).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'catch-global-native-constructor',
    source:
      'async function frames(error:Error){return(await globalThis.Promise.resolve(error).catch()).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'catch-then-chain',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).catch().then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'catch-finally-chain',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).finally(()=>{}).catch()).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'catch-resolved-data-pin',
    source:
      'async function frames(error:Error){return(await Promise.resolve({stack:"fixed"}).catch()).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'catch-local-error-words-pin',
    source:
      'async function frames(error:Error){return(await Promise.resolve(new Error("fixed")).catch()).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'catch-local-promise-shadow-pin',
    source:
      'async function frames(error:Error){const Promise={resolve(_value:unknown){return{catch(){return{stack:"fixed"};}};}};return(await Promise.resolve(error).catch()).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'catch-own-method-pin',
    source:
      'async function frames(error:Error){const value=Object.assign(Promise.resolve(error),{catch:()=>Promise.resolve({stack:"fixed"})})as unknown as{catch():Promise<{stack:string}>};return(await value.catch()).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'catch-local-undefined-shadow-pin',
    source:
      'async function frames(error:Error){const undefined=()=>error;return(await Promise.resolve({stack:"fixed"}).catch(undefined)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'catch-ignored-extra-argument-pin',
    source:
      'async function frames(error:Error){return(await(Promise.resolve({stack:"fixed"}).catch as(...args:unknown[])=>Promise<{stack:string}>)(undefined,error)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'catch-effectful-ignored-message-pin',
    source:
      'async function frames(error:Error){return(await(Promise.resolve(error).catch as(...args:unknown[])=>Promise<Error>)(undefined,Object.assign(error,{message:"fixed",stack:"fixed"}))).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'catch-effectful-ignored-stack-pin',
    source:
      'async function frames(error:Error){return(await(Promise.resolve(error).catch as(...args:unknown[])=>Promise<Error>)(undefined,Object.assign(error,{message:"fixed",stack:"fixed"}))).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'catch-quiet-extra-sensitivity',
    source:
      'async function frames(error:Error){return(await(Promise.resolve(error).catch as(...args:unknown[])=>Promise<Error>)(undefined,0)).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
] as const;

describe('native catch forwarding words', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'catch-forwarding.ts', source);
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

describe('shared catch forwarding admission', () => {
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
