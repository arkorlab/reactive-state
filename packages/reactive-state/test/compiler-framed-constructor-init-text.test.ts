import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A directly invoked literal method keeps its original quiet receiver. */
const CASES = [
  {
    id: 'referrer-direct',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{referrer:error as never}).referrer;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'referrer-caught',
    source:
      'function frames(){try{JSON.parse("{");return "fixed";}catch(caught){return new Request("https://example.test/",{referrer:caught as never}).referrer;}}',
    invocation: 'frames()',
    reader: true,
    refused: true,
  },
  {
    id: 'referrer-options-alias',
    source:
      'function frames(error:Error){const options={referrer:error as never};return new Request("https://example.test/",options).referrer;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'referrer-literal-spread',
    source:
      'function frames(error:Error){const options={referrer:error as never};return new Request("https://example.test/",{...options}).referrer;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'referrer-direct-getter',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{get referrer(){return error as never;}}).referrer;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'referrer-constructor-alias',
    source:
      'function frames(error:Error){const Native=Request;return new Native("https://example.test/",{referrer:error as never}).referrer;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'referrer-finite-argument-spread',
    source:
      'function frames(error:Error){const options={referrer:error as never};return new Request("https://example.test/",...[options] as const).referrer;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'referrer-array-words',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{referrer:[error] as never}).referrer;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'referrer-fixed-data',
    source:
      'function frames(){return new Request("https://example.test/",{referrer:"https://fixed.test/"}).referrer;}',
    invocation: 'frames()',
    reader: false,
    refused: false,
  },
  {
    id: 'referrer-local-error-words',
    source:
      'function frames(){return new Request("https://example.test/",{referrer:new Error("fixed") as never}).referrer;}',
    invocation: 'frames()',
    reader: false,
    refused: false,
  },
  {
    id: 'referrer-last-field-data',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{...{referrer:error as never},referrer:"https://fixed.test/"}).referrer;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'referrer-own-conversion-data',
    source:
      'function frames(error:Error){Object.defineProperty(error,"toString",{value:()=>"https://fixed.test/"});return new Request("https://example.test/",{referrer:error as never}).referrer;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'referrer-ignored-tail-data',
    source:
      'function frames(error:Error){return new (Request as unknown as new(...args:unknown[])=>Request)("https://example.test/",{referrer:error as never},Object.defineProperty(error,"toString",{value:()=>"https://fixed.test/"})).referrer;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'referrer-earlier-getter-data',
    source:
      'function frames(error:Error){return new Request("https://example.test/",{get method(){Object.defineProperty(error,"toString",{value:()=>"https://fixed.test/"});return "GET";},referrer:error as never}).referrer;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'referrer-options-exposure-data',
    source:
      'function frames(error:Error){const options={referrer:error};Object.defineProperty(options.referrer,"toString",{value:()=>"https://fixed.test/"});return new Request("https://example.test/",options as never).referrer;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'referrer-local-constructor-data',
    source:
      'function frames(error:Error){class Request{referrer="fixed";constructor(..._args:unknown[]){}}return new Request("https://example.test/",{referrer:error}).referrer;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-header-record',
    source:
      'function frames(error:Error){return new Response(null,{headers:{x:error as never}}).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'response-header-caught',
    source:
      'function frames(){try{JSON.parse("{");return "fixed";}catch(caught){return new Response(null,{headers:{x:caught as never}}).headers.get("x");}}',
    invocation: 'frames()',
    reader: true,
    refused: true,
  },
  {
    id: 'response-header-entry-list',
    source:
      'function frames(error:Error){return new Response(null,{headers:[["x",error as never]]}).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'response-header-record-alias',
    source:
      'function frames(error:Error){const headers={x:error as never};return new Response(null,{headers}).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'response-header-options-alias',
    source:
      'function frames(error:Error){const options={headers:{x:error as never}};return new Response(null,options).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'response-header-spread',
    source:
      'function frames(error:Error){const headers={x:error as never};return new Response(null,{headers:{...headers}}).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'response-header-option-getter',
    source:
      'function frames(error:Error){return new Response(null,{get headers(){return {x:error as never};}}).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'response-header-value-getter',
    source:
      'function frames(error:Error){return new Response(null,{headers:{get x(){return error as never;}}}).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'response-header-constructor-alias',
    source:
      'function frames(error:Error){const Native=Response;return new Native(null,{headers:{x:error as never}}).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'response-header-array-words',
    source:
      'function frames(error:Error){return new Response(null,{headers:{x:[error] as never}}).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'response-header-fixed-data',
    source: 'function frames(){return new Response(null,{headers:{x:"fixed"}}).headers.get("x");}',
    invocation: 'frames()',
    reader: false,
    refused: false,
  },
  {
    id: 'response-header-local-words',
    source:
      'function frames(){return new Response(null,{headers:{x:new Error("fixed") as never}}).headers.get("x");}',
    invocation: 'frames()',
    reader: false,
    refused: false,
  },
  {
    id: 'response-header-own-conversion-data',
    source:
      'function frames(error:Error){Object.defineProperty(error,"toString",{value:()=>"fixed"});return new Response(null,{headers:{x:error as never}}).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-header-ignored-tail-data',
    source:
      'function frames(error:Error){return new Response(...([null,{headers:{x:error as never}},Object.defineProperty(error,"toString",{value:()=>"fixed"})] as unknown as ConstructorParameters<typeof Response>)).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-header-prior-value-conversion-data',
    source:
      'function frames(error:Error){function collect(value:Error,head:unknown){return new Response(null,{headers:{a:head as never,z:value as never}}).headers.get("z");}return collect(error,{toString(){Object.defineProperty(error,"toString",{value:()=>"fixed"});return "head";}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-header-earlier-option-getter-data',
    source:
      'function frames(error:Error){return new Response(null,{headers:{x:error as never},get statusText(){Object.defineProperty(error,"toString",{value:()=>"fixed"});return "OK";}}).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-header-options-exposure-data',
    source:
      'function frames(error:Error){const options={headers:{x:error}};Object.defineProperty(options.headers.x,"toString",{value:()=>"fixed"});return new Response(null,options as never).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-header-last-field-data',
    source:
      'function frames(error:Error){return new Response(null,{headers:{...{x:error as never},x:"fixed"}}).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-local-constructor-data',
    source:
      'function frames(error:Error){class Response{headers={get(_name:string){return "fixed";}};constructor(..._args:unknown[]){}}return new Response(null,{headers:{x:error}}).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-prior-callback-conversion',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return new Response(null,{headers:{x:value as never}}).headers.get("x");}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'request-prior-callback-conversion',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return new Request("https://example.test/",{referrer:value as never}).referrer;}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"https://fixed.test/"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-owner-prior-member-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:{ready:unknown}){prepare.ready;return new Response(null,{headers:{x:value as never}}).headers.get("x");}return collect(error,{get ready(){Object.defineProperty(error,"toString",{value:()=>"fixed"});return 0;}});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-owner-prior-keys-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:Record<string,unknown>){Reflect.ownKeys(prepare);return new Response(null,{headers:{x:value as never}}).headers.get("x");}return collect(error,new Proxy({},{ownKeys(){Object.defineProperty(error,"toString",{value:()=>"fixed"});return [];}}));}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-owner-default-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void,ignored=(prepare(),0)){return new Response(null,{headers:{x:value as never}}).headers.get("x");}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-captured-owner-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();function read(){return new Response(null,{headers:{x:value as never}}).headers.get("x");}return read();}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-quiet-owner-constant',
    source:
      'function frames(error:Error){const label="fixed";return new Response(null,{headers:{label,x:error as never}}).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'referrer-quiet-native-birth',
    source:
      'function frames(error:Error){const ignored=new Request("https://fixed.test/");return new Request("https://example.test/",{referrer:error as never}).referrer;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'response-deferred-body',
    source:
      'function frames(error:Error){function untouched(){Object.defineProperty(error,"toString",{value:()=>"fixed"});}return new Response(null,{headers:{x:error as never}}).headers.get("x");}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'constructor-init-constructor-field-prefix-data',
    source:
      'function frames(error:Error){function collect(value:Error,prepare:()=>void){class Read{prepared=prepare();result:string|null;constructor(error:Error){this.result=new Response(null,{headers:{x:error as never}}).headers.get("x");}}return new Read(value).result;}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
] as const;

describe('literal method this readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'constructor-init.ts', source);
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

describe('literal method this admissions', () => {
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
