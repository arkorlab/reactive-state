import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';
const CASES = [
  {
    id: 'supplied-omitted',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally()).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'supplied-undefined',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally(undefined)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'supplied-void-zero',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally(void 0)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'supplied-null',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally(null)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'supplied-false',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally(false as never)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'supplied-number',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally(0 as never)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'supplied-text',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally("ignored" as never)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'supplied-template',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally(`ignored` as never)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'supplied-bigint',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally(0n as never)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'constructed-omitted',
    source:
      'async function frames(){return (await Promise.resolve(new Error("ours")).finally()).stack;}',
    invocation: 'frames()',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'constructed-undefined',
    source:
      'async function frames(){return (await Promise.resolve(new Error("ours")).finally(undefined)).stack;}',
    invocation: 'frames()',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'bracket-omitted',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error)["finally"]()).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'native-constructor-alias',
    source:
      'async function frames(error:Error){const NativePromise=Promise;return (await NativePromise.resolve(error).finally()).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'quiet-void-binding',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally(void error)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'undefined-constant-alias',
    source:
      'async function frames(error:Error){const absent=undefined;return (await Promise.resolve(error).finally(absent)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'chained-absent',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally().finally(undefined).finally(null)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'existing-quiet-callback',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally(()=>{})).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'existing-primitive-return',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally(()=>2)).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
  {
    id: 'ordinary-data',
    source:
      'async function frames(){return (await Promise.resolve({stack:"fixed"}).finally()).stack;}',
    invocation: 'frames()',
    reader: false,
    refused: false,
    native: 'fixed',
  },
  {
    id: 'locally-written-message',
    source:
      'async function frames(){return (await Promise.resolve(new Error("fixed")).finally()).message;}',
    invocation: 'frames()',
    reader: false,
    refused: false,
    native: 'fixed',
  },
  {
    id: 'callback-replaces-stack',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally(()=>{error.stack="fixed";})).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'fixed',
    opaquePin: true,
    qualification:
      'Existing conservative native-stack read/write observation is preserved; ordinary Error input returns fixed but possible Proxy inputs are not an installation proof.',
  },
  {
    id: 'shadowed-undefined-callback',
    source:
      'async function frames(error:Error,undefined:()=>void){return (await Promise.resolve(error).finally(undefined)).stack;}',
    invocation:
      '(()=>{const error=new Error("ours");return frames(error,()=>{error.stack="fixed";});})()',
    reader: false,
    refused: true,
    native: 'fixed',
    opaquePin: true,
    qualification:
      'The standalone unknown callback remains opaque; the actual fixture invocation contains a separate stack observation/write that already causes conservative refusal.',
  },
  {
    id: 'effectful-void-handler',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally(void(error.stack="fixed"))).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'fixed',
    opaquePin: true,
    qualification:
      'Existing conservative native-stack read/write observation is preserved; ordinary Error input returns fixed but possible Proxy inputs are not an installation proof.',
  },
  {
    id: 'local-promise-shadow',
    source:
      'const Promise={resolve(_value:unknown){return {finally(){return {stack:"fixed"};}}}};async function frames(error:Error){return (await Promise.resolve(error).finally()).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
    native: 'fixed',
  },
  {
    id: 'saved-own-finally',
    source:
      'async function frames(error:Error){const value=Promise.resolve(error);value.finally=async()=>({stack:"fixed"}) as never;return (await value.finally()).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
    native: 'fixed',
    opaquePin: true,
  },
  {
    id: 'declared-thenable',
    source:
      'async function frames(error:Error&PromiseLike<{stack:string}>){return(await Promise.resolve(error).finally()).stack;}',
    invocation:
      '(()=>{const data=Promise.resolve({stack:"fixed"});return frames(Object.assign(new Error("ours"),{then:data.then.bind(data)}));})()',
    reader: false,
    refused: false,
    native: 'fixed',
    opaquePin: true,
  },
  {
    id: 'effectful-ignored-tail',
    source:
      'async function frames(error:Error){return (await (Promise.resolve(error).finally as (handler:undefined,...tail:unknown[])=>Promise<Error>)(undefined,Object.assign(error,{stack:"fixed"}))).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
    native: 'fixed',
    opaquePin: true,
  },
  {
    id: 'quiet-ignored-tail',
    source:
      'async function frames(error:Error){return (await (Promise.resolve(error).finally as (handler:undefined,...tail:unknown[])=>Promise<Error>)(undefined,0,"quiet")).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
    native: 'frames',
  },
];

describe('absent native finally readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'finally-absent.ts', source);
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

describe('absent native finally admissions', () => {
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
