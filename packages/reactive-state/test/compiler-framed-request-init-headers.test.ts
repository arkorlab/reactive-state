import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'reported-request-header-record',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{headers:{x:error as never}}).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'request-constructor-alias',
    source:
      'function frames(error:Error){const Make=Request;return new Make("https://example.test/",{headers:{x:error as never}}).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'whole-init-alias',
    source:
      'function frames(error:Error){const init={headers:{x:error as never}};return new Request("https://example.test/",init).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'whole-header-alias',
    source:
      'function frames(error:Error){const headers={x:error as never};return new Request("https://example.test/",{headers}).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'header-record-spread',
    source:
      'function frames(error:Error){const source={x:error as never};return new Request("https://example.test/",{headers:{...source,y:"safe"}}).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'init-record-spread',
    source:
      'function frames(error:Error){const base={headers:{x:error as never}};return new Request("https://example.test/",{...base,cache:"no-store"}).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'direct-header-option-getter',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{get headers(){return{x:error as never};}}).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'header-record-value-getter',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{headers:{get x(){return error as never;}}}).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'header-entry-list',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{headers:[["x",error as never]]}).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'header-entry-list-alias',
    source:
      'function frames(error:Error){const entries:[string,string][]=[["x",error as never]];return new Request("https://example.test/",{headers:entries}).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'computed-header-option',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{["headers"]:{x:error as never}}).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'quiet-ignored-constructor-tail',
    source:
      'function frames(error:Error){return new(Request as new(...args:unknown[])=>Request)("https://example.test/",{headers:{x:error as never}},0).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'quiet-preceding-header-text',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{headers:{first:"safe",x:error as never}}).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'array-header-value',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{headers:{x:[error] as never}}).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'headers-beside-fixed-body',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{method:"POST",body:"plain",headers:{x:error as never}}).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'headers-beside-fixed-referrer',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{referrer:"https://referrer.test/",headers:{x:error as never}}).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'literal-argument-spread',
    source:
      'function frames(error:Error){return new Request(...(["https://example.test/",{headers:{x:error as never}}]as const)).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'existing-response-header-pin',
    source:
      'function frames(error:Error){return new Response(null,{headers:{x:error as never}}).headers.get("x");}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fixed-header-text',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{headers:{x:"fixed"}}).headers.get("x");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-error-words',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{headers:{x:new Error("local") as never}}).headers.get("x");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ordinary-local-request',
    source:
      'class Request{headers={get(_name:string){return"fixed";}};constructor(_input:unknown,_init:unknown){}}function frames(error:Error){return new Request("https://example.test/",{headers:{x:error as never}}).headers.get("x");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-error-type-shadow',
    source:
      'type Error={toString():string};function frames(error:Error){return new Request("https://example.test/",{headers:{x:error as never}}).headers.get("x");}',
    reader: false,
    refused: false,
    invocation: 'frames({toString(){return"fixed";}})',
  },
  {
    id: 'prior-fixed-error-words',
    source:
      'function frames(error:Error){Object.assign(error,{name:"Fixed",message:"fixed"});return new Request("https://example.test/",{headers:{x:error as never}}).headers.get("x");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'effectful-init-getter',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{get headers(){Object.assign(error,{name:"Fixed",message:"fixed"});return{x:error as never};}}).headers.get("x");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'preceding-header-conversion',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{headers:{first:{toString(){Object.assign(error,{name:"Fixed",message:"fixed"});return"safe";}}as never,x:error as never}}).headers.get("x");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ignored-constructor-tail-effects',
    source:
      'function frames(error:Error){return new(Request as new(...args:unknown[])=>Request)("https://example.test/",{headers:{x:error as never}},Object.assign(error,{name:"Fixed",message:"fixed"})).headers.get("x");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'effectful-header-value-getter',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{headers:{get x(){Object.assign(error,{name:"Fixed",message:"fixed"});return error as never;}}}).headers.get("x");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'input-url-conversion-effects',
    source:
      'function frames(error:Error){const input={toString(){Object.assign(error,{name:"Fixed",message:"fixed"});return"https://example.test/";}};return new Request(input as never,{headers:{x:error as never}}).headers.get("x");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
    retainedURL: true,
  },
  {
    id: 'changed-init-headers',
    source:
      'function frames(error:Error){const init:RequestInit={headers:{x:error as never}};init.headers={x:"fixed"};return new Request("https://example.test/",init).headers.get("x");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ignored-tail-replaces-headers',
    source:
      'function frames(error:Error){const init:RequestInit={headers:{x:error as never}};return new(Request as new(...args:unknown[])=>Request)("https://example.test/",init,Object.assign(init,{headers:{x:"fixed"}})).headers.get("x");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'later-header-data-replacement',
    source:
      'function frames(error:Error){const initial={x:error as never};return new Request("https://example.test/",{headers:{...initial,x:"fixed"}}).headers.get("x");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'preceding-init-option-conversion',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{cache:{toString(){Object.assign(error,{name:"Fixed",message:"fixed"});return"no-store";}}as never,headers:{x:error as never}}).headers.get("x");}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('native Request init header readers', () => {
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

describe('native Request init header shared', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused, retainedURL }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining(
      retainedURL === true
        ? 'a URL the code shows no absolute one'
        : 'a shared module that answers otherwise',
    );
    const expected = refused || retainedURL === true ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
