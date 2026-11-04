import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'reported-root-assignment',
    source:
      'async function frames(error:Error){return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,Object.assign(error,{stack:"fixed"})).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-define-property',
    source:
      'async function frames(error:Error){return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,Object.defineProperty(error,"stack",{value:"fixed"})).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-bracket-assignment',
    source:
      'async function frames(error:Error){return(await (Promise["resolve"] as (value:Error,...tail:unknown[])=>Promise<Error>)(error,Object.assign(error,{stack:"fixed"})).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-native-alias-assignment',
    source:
      'const Native=Promise;async function frames(error:Error){return(await (Native.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,Object.assign(error,{stack:"fixed"})).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-global-assignment',
    source:
      'async function frames(error:Error){return(await (globalThis.Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,Object.assign(error,{stack:"fixed"})).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-finally-assignment',
    source:
      'async function frames(error:Error){return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,Object.assign(error,{stack:"fixed"})).finally(()=>{})).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-catch-assignment',
    source:
      'async function frames(error:Error){return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,Object.assign(error,{stack:"fixed"})).catch()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-long-chain-assignment',
    source:
      'async function frames(error:Error){return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,Object.assign(error,{stack:"fixed"})).then().finally(()=>{}).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-third-tail-assignment',
    source:
      'async function frames(error:Error){return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,undefined,Object.assign(error,{stack:"fixed"})).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-void-assignment',
    source:
      'async function frames(error:Error){return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,void Object.assign(error,{stack:"fixed"})).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-immediate-helper',
    source:
      'async function frames(error:Error){return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,(()=>{Object.assign(error,{stack:"fixed"});return 0;})()).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-tail-getter',
    source:
      'async function frames(error:Error){return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,({get value(){Object.assign(error,{stack:"fixed"});return 0;}}).value).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-effectful-literal-spread',
    source:
      'async function frames(error:Error){return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,...([Object.assign(error,{stack:"fixed"})]as const)).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-effectful-alias-spread',
    source:
      'async function frames(error:Error){const tail=[Object.assign(error,{stack:"fixed"})]as const;return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,...tail).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-quiet-primitives-pin',
    source:
      'async function frames(error:Error){return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,undefined,null,0,true,false,"x").then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'root-function-creation-pin',
    source:
      'async function frames(error:Error){return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,()=>{Object.assign(error,{stack:"fixed"});}).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'root-function-expression-pin',
    source:
      'async function frames(error:Error){return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,function(){Object.assign(error,{stack:"fixed"});}).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'root-quiet-literal-spread-pin',
    source:
      'async function frames(error:Error){return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,...([undefined,0]as const)).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'root-quiet-alias-spread-pin',
    source:
      'async function frames(error:Error){const tail=[undefined,0]as const;return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,...tail).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'root-no-tail-pin',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'root-quiet-native-alias-pin',
    source:
      'const Native=Promise;async function frames(error:Error){return(await (Native.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(error,0).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'root-first-argument-replacement-pin',
    source:
      'async function frames(error:Error){return(await Promise.resolve(Object.assign(error,{stack:"fixed"})).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-local-promise-pin',
    source:
      'const Promise={resolve(value:Error,..._tail:unknown[]){return{then(){return{stack:"fixed"};}};}};async function frames(error:Error){return(await Promise.resolve(error,0).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-saved-promise-own-then-pin',
    source:
      'async function frames(error:Error){const saved=Promise.resolve(error);saved.then=(()=>Promise.resolve({stack:"fixed"}))as never;return(await saved.then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-fixed-data-pin',
    source:
      'async function frames(error:Error){return(await(Promise.resolve as(value:{stack:string},...tail:unknown[])=>Promise<{stack:string}>)({stack:"fixed"},0).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'root-binding-alias-pin',
    source:
      'async function frames(error:Error){const alias=error;return(await (Promise.resolve as (value:Error,...tail:unknown[])=>Promise<Error>)(alias,undefined).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'root-owner-capture-pin',
    source:
      'function make(error:Error){return async()=>{return(await(Promise.resolve as(value:Error,...tail:unknown[])=>Promise<Error>)(error,undefined).then()).stack;};}async function frames(error:Error){return make(error)();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
] as const;

describe('native Promise resolve root trailing readers', () => {
  it.each(CASES)('$id', ({ source, refused: reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-error-observations.ts', source);
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

describe('native Promise resolve root trailing admissions', () => {
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
