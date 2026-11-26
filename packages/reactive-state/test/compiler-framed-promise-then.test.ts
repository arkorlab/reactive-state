import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'then-omitted-local-stack',
    source:
      'async function frames(){return(await Promise.resolve(new Error("fixed")).then()).stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'then-omitted-supplied-stack',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'then-omitted-supplied-words',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).then()).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'then-explicit-undefined',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).then(undefined)).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'then-void-zero',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).then(void 0)).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'then-constant-undefined-alias',
    source:
      'async function frames(error:Error){const absent=undefined;return(await Promise.resolve(error).then(absent)).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'then-rejection-handler-is-not-fulfillment',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).then(undefined,()=>({stack:"fixed"}))).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'then-finally-chain',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).then().finally(()=>{}).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'then-native-promise-alias',
    source:
      'const Native=Promise;async function frames(error:Error){return(await Native.resolve(error).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'then-local-words-pin',
    source:
      'async function frames(){return(await Promise.resolve(new Error("fixed")).then()).message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'then-data-result-pin',
    source: 'async function frames(){return(await Promise.resolve({stack:"fixed"}).then()).stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'then-replacing-callback-pin',
    source:
      'async function frames(error:Error){return(await Promise.resolve(error).then(()=>({stack:"fixed"}))).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'then-local-promise-shadow-pin',
    source:
      'const Promise={resolve(_input:unknown){return{then(){return{stack:"fixed"};}};}};async function frames(error:Error){return(await Promise.resolve(error).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'then-own-method-alias-pin',
    source:
      'async function frames(error:Error){const promise=Promise.resolve(error);promise.then=(()=>Promise.resolve({stack:"fixed"})) as never;return(await promise.then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'then-own-method-literal-pin',
    source:
      'async function frames(error:Error){return(await Object.assign(Promise.resolve(error),{then(){return{stack:"fixed"};}}).then()).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'then-defined-handler-shadow-pin',
    source:
      'async function frames(error:Error){const undefined=()=>({stack:"fixed"});return(await Promise.resolve(error).then(undefined)).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'then-void-own-set-time-message-pin',
    source:
      'async function frames(error:Error){const receiver={setTime(_value:number){Object.defineProperty(error,"message",{value:"fixed"});return 0;}};return(await Promise.resolve(error).then(void receiver.setTime(NaN))).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'then-void-own-set-time-stack-pin',
    source:
      'async function frames(error:Error){const receiver={setTime(_value:number){Object.defineProperty(error,"stack",{value:"fixed"});return 0;}};return(await Promise.resolve(error).then(void receiver.setTime(NaN))).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native Promise forwarding readers', () => {
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

describe('native Promise forwarding admissions', () => {
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
