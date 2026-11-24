import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'request-reported-yielded-error',
    source:
      'function frames(error:Error){return new(Request)("https://example.test/",{headers:{unused:"data",*[Symbol.iterator](){yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-reported-yielded-error',
    source:
      'function frames(error:Error){return new(Response)(null,{headers:{unused:"data",*[Symbol.iterator](){yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'request-whole-header-alias',
    source:
      'function frames(error:Error){const headers={unused:"data",*[Symbol.iterator](){yield["safe",error as never];}};return new(Request)("https://example.test/",{headers:headers as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-whole-header-alias',
    source:
      'function frames(error:Error){const headers={unused:"data",*[Symbol.iterator](){yield["safe",error as never];}};return new(Response)(null,{headers:headers as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'request-whole-header-alias-chain',
    source:
      'function frames(error:Error){const headers={unused:"data",*[Symbol.iterator](){yield["safe",error as never];}};const alias=headers;return new(Request)("https://example.test/",{headers:alias as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-whole-header-alias-chain',
    source:
      'function frames(error:Error){const headers={unused:"data",*[Symbol.iterator](){yield["safe",error as never];}};const alias=headers;return new(Response)(null,{headers:alias as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'request-unused-error-field-direct',
    source:
      'function frames(error:Error){return new(Request)("https://example.test/",{headers:{unused:error,*[Symbol.iterator](){yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-unused-error-field-direct',
    source:
      'function frames(error:Error){return new(Response)(null,{headers:{unused:error,*[Symbol.iterator](){yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'request-unused-error-field-alias',
    source:
      'function frames(error:Error){const headers={unused:error,*[Symbol.iterator](){yield["safe",error as never];}};return new(Request)("https://example.test/",{headers:headers as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-unused-error-field-alias',
    source:
      'function frames(error:Error){const headers={unused:error,*[Symbol.iterator](){yield["safe",error as never];}};return new(Response)(null,{headers:headers as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'request-native-constructor-alias',
    source:
      'function frames(error:Error){const Native=Request;return new(Native)("https://example.test/",{headers:{unused:"data",*[Symbol.iterator](){yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-native-constructor-alias',
    source:
      'function frames(error:Error){const Native=Response;return new(Native)(null,{headers:{unused:"data",*[Symbol.iterator](){yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'request-native-symbol-alias',
    source:
      'function frames(error:Error){const iterator=Symbol.iterator;return new(Request)("https://example.test/",{headers:{*[iterator](){yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-native-symbol-alias',
    source:
      'function frames(error:Error){const iterator=Symbol.iterator;return new(Response)(null,{headers:{*[iterator](){yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'request-generator-function-field',
    source:
      'function frames(error:Error){return new(Request)("https://example.test/",{headers:{[Symbol.iterator]:function*(){yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-generator-function-field',
    source:
      'function frames(error:Error){return new(Response)(null,{headers:{[Symbol.iterator]:function*(){yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'request-iterator-getter',
    source:
      'function frames(error:Error){return new(Request)("https://example.test/",{headers:{get[Symbol.iterator](){return function*(){yield["safe",error as never];};}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-iterator-getter',
    source:
      'function frames(error:Error){return new(Response)(null,{headers:{get[Symbol.iterator](){return function*(){yield["safe",error as never];};}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'request-quiet-other-option',
    source:
      'function frames(error:Error){return new(Request)("https://example.test/",{headers:{unused:"data",*[Symbol.iterator](){yield["safe",error as never];}} as never,redirect:"manual"}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-quiet-other-option',
    source:
      'function frames(error:Error){return new(Response)(null,{headers:{unused:"data",*[Symbol.iterator](){yield["safe",error as never];}} as never,statusText:"fixed"}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'request-whole-error-alias',
    source:
      'function frames(error:Error){const held=error;return new(Request)("https://example.test/",{headers:{*[Symbol.iterator](){yield["safe",held as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-whole-error-alias',
    source:
      'function frames(error:Error){const held=error;return new(Response)(null,{headers:{*[Symbol.iterator](){yield["safe",held as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'request-two-yielded-errors',
    source:
      'function frames(error:Error){return new(Request)("https://example.test/",{headers:{*[Symbol.iterator](){yield["first",error as never];yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'response-two-yielded-errors',
    source:
      'function frames(error:Error){return new(Response)(null,{headers:{*[Symbol.iterator](){yield["first",error as never];yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'request-unused-error-data-iterator',
    source:
      'function frames(error:Error){return new(Request)("https://example.test/",{headers:{unused:error,*[Symbol.iterator](){yield["safe","fixed"];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-unused-error-data-iterator',
    source:
      'function frames(error:Error){return new(Response)(null,{headers:{unused:error,*[Symbol.iterator](){yield["safe","fixed"];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'request-local-error-words',
    source:
      'function frames(error:Error){return new(Request)("https://example.test/",{headers:{*[Symbol.iterator](){yield["safe",new Error("fixed")as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-local-error-words',
    source:
      'function frames(error:Error){return new(Response)(null,{headers:{*[Symbol.iterator](){yield["safe",new Error("fixed")as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'request-prior-fixed-words',
    source:
      'function frames(error:Error){Object.assign(error,{name:"Fixed",message:"fixed"});return new(Request)("https://example.test/",{headers:{unused:"data",*[Symbol.iterator](){yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-prior-fixed-words',
    source:
      'function frames(error:Error){Object.assign(error,{name:"Fixed",message:"fixed"});return new(Response)(null,{headers:{unused:"data",*[Symbol.iterator](){yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'request-ignored-tail-fixed-words',
    source:
      'function frames(error:Error){return new(Request as new(...args:unknown[])=>Request)("https://example.test/",{headers:{unused:"data",*[Symbol.iterator](){yield["safe",error as never];}} as never},Object.assign(error,{name:"Fixed",message:"fixed"})).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-ignored-tail-fixed-words',
    source:
      'function frames(error:Error){return new(Response as new(...args:unknown[])=>Response)(null,{headers:{unused:"data",*[Symbol.iterator](){yield["safe",error as never];}} as never},Object.assign(error,{name:"Fixed",message:"fixed"})).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'request-generator-prefix-fixed-words',
    source:
      'function frames(error:Error){return new(Request)("https://example.test/",{headers:{*[Symbol.iterator](){Object.assign(error,{name:"Fixed",message:"fixed"});yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-generator-prefix-fixed-words',
    source:
      'function frames(error:Error){return new(Response)(null,{headers:{*[Symbol.iterator](){Object.assign(error,{name:"Fixed",message:"fixed"});yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'request-iterator-getter-fixed-words',
    source:
      'function frames(error:Error){return new(Request)("https://example.test/",{headers:{get[Symbol.iterator](){Object.assign(error,{name:"Fixed",message:"fixed"});return function*(){yield["safe",error as never];};}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-iterator-getter-fixed-words',
    source:
      'function frames(error:Error){return new(Response)(null,{headers:{get[Symbol.iterator](){Object.assign(error,{name:"Fixed",message:"fixed"});return function*(){yield["safe",error as never];};}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'request-prior-own-toString',
    source:
      'function frames(error:Error){Object.defineProperty(error,"toString",{value:()=>"fixed"});return new(Request)("https://example.test/",{headers:{unused:"data",*[Symbol.iterator](){yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-prior-own-toString',
    source:
      'function frames(error:Error){Object.defineProperty(error,"toString",{value:()=>"fixed"});return new(Response)(null,{headers:{unused:"data",*[Symbol.iterator](){yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'request-earlier-entry-conversion-fixed-words',
    source:
      'function frames(error:Error){return new(Request)("https://example.test/",{headers:{*[Symbol.iterator](){yield["first",{toString(){Object.assign(error,{name:"Fixed",message:"fixed"});return"data";}}as never];yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'response-earlier-entry-conversion-fixed-words',
    source:
      'function frames(error:Error){return new(Response)(null,{headers:{*[Symbol.iterator](){yield["first",{toString(){Object.assign(error,{name:"Fixed",message:"fixed"});return"data";}}as never];yield["safe",error as never];}} as never}).headers.get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native init header iterator readers', () => {
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

describe('native init header iterator shared', () => {
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
