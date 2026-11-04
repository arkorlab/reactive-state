import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'request-unreachable-error-yield',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{headers:{unused:error,*[Symbol.iterator](){return;yield["safe",error as never];}}as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'request-future-error-alias',
    source:
      'function frames(error:Error){const output=new Request("https://example.test/",{headers:{*[Symbol.iterator](){yield["safe",held as never];}}as never}).headers.get("safe");const held=error;return output;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'request-captured-prepare-bridge',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return new Request("https://example.test/",{headers:{*[Symbol.iterator](){yield["safe",value as never];}}as never}).headers.get("safe");}return collect(error,()=>{Object.assign(error,{name:"Fixed",message:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'request-constructor-field-before-body',
    source:
      'function frames(error:Error){class Holder{stamp=Object.assign(error,{name:"Fixed",message:"fixed"});value:string|null;constructor(value:Error){this.value=new Request("https://example.test/",{headers:{*[Symbol.iterator](){yield["safe",value as never];}}as never}).headers.get("safe");}}return new Holder(error).value;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-unreachable-error-yield',
    source:
      'function frames(error:Error){return new Response(null,{headers:{unused:error,*[Symbol.iterator](){return;yield["safe",error as never];}}as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-future-error-alias',
    source:
      'function frames(error:Error){const output=new Response(null,{headers:{*[Symbol.iterator](){yield["safe",held as never];}}as never}).headers.get("safe");const held=error;return output;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-captured-prepare-bridge',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return new Response(null,{headers:{*[Symbol.iterator](){yield["safe",value as never];}}as never}).headers.get("safe");}return collect(error,()=>{Object.assign(error,{name:"Fixed",message:"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-constructor-field-before-body',
    source:
      'function frames(error:Error){class Holder{stamp=Object.assign(error,{name:"Fixed",message:"fixed"});value:string|null;constructor(value:Error){this.value=new Response(null,{headers:{*[Symbol.iterator](){yield["safe",value as never];}}as never}).headers.get("safe");}}return new Holder(error).value;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native init header iterator boundary readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-reduce.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(refused);
  });
});

describe('native init header iterator boundary shared', () => {
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
