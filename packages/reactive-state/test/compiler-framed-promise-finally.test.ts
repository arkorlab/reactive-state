import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

const CASES = [
  {
    id: 'supplied-empty',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally(()=>{})).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'caught-empty',
    source:
      'async function frames(){try{JSON.parse("{");}catch(error){return (await Promise.resolve(error).finally(()=>{} ) as Error).stack;}}',
    invocation: 'frames()',
    reader: true,
    refused: true,
  },
  {
    id: 'new-error-empty',
    source:
      'async function frames(error:Error){return (await Promise.resolve(new Error("fixed")).finally(()=>{})).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'supplied-return-data',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally(()=>"fixed")).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'local-message',
    source:
      'async function frames(error:Error){return (await Promise.resolve(new Error("fixed")).finally(()=>{})).message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'fixed-data',
    source:
      'async function frames(error:Error){return (await Promise.resolve({stack:"fixed"}).finally(()=>{})).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'promise-shadow',
    source:
      'const Promise={resolve(_v:unknown){return {finally(_f:()=>void){return {stack:"fixed"};}}}};async function frames(error:Error){return (await Promise.resolve(error).finally(()=>{})).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'finally-throw',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally(()=>{throw new Error("fixed");})).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'finally-reject',
    source:
      'async function frames(error:Error){return (await Promise.resolve(error).finally(()=>Promise.reject("fixed"))).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'own-finally',
    source:
      'async function frames(error:Error){const value=Promise.resolve(error);value.finally=async()=>({stack:"fixed"}) as never;return (await value.finally(()=>{})).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'own-then',
    source:
      'async function frames(error:Error){const value=Promise.resolve(error);value.then=async()=>({stack:"fixed"}) as never;return (await value.finally(()=>{})).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'finally-thenable-error-fulfills-data',
    source:
      'async function frames(error:Error&PromiseLike<{stack:string}>){return(await Promise.resolve(error).finally(()=>{})).stack;}',
    invocation:
      '(()=>{const data=Promise.resolve({stack:"fixed"});return frames(Object.assign(new Error("fixed"),{then:data.then.bind(data)}));})()',
    reader: false,
    refused: false,
  },
];

describe('native finally fulfillment readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
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

describe('native finally fulfillment admissions', () => {
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
