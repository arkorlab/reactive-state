import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'response-prior-fix',
    source: 'async function frames(error:Error){return await new Response(error as never).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'request-body-error',
    source:
      'async function frames(error:Error){return await new Request("https://example.test/",{method:"POST",body:error as never}).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'request-caught-body',
    source:
      'async function frames(){try{JSON.parse("{");}catch(error){return await new Request("https://example.test/",{method:"POST",body:error as never}).text();}}',
    invocation: 'frames()',
    reader: true,
    refused: true,
  },
  {
    id: 'request-body-getter-error',
    source:
      'async function frames(error:Error){return await new Request("https://example.test/",{method:"POST",get body(){return error as never;}}).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'request-body-spread-error',
    source:
      'async function frames(error:Error){return await new Request("https://example.test/",{...{body:error as never},method:"POST"}).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'request-constructor-alias',
    source:
      'const Native=Request;async function frames(error:Error){return await new Native("https://example.test/",{method:"POST",body:error as never}).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'request-reflect-construct',
    source:
      'async function frames(error:Error){return await Reflect.construct(Request,["https://example.test/",{method:"POST",body:error}]).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'request-array-body',
    source:
      'async function frames(error:Error){return await new Request("https://example.test/",{method:"POST",body:[error] as never}).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'request-body-blob-data',
    source:
      'async function frames(error:Error){return await new Request("https://example.test/",{method:"POST",body:new Blob(["fixed"])}).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'request-body-local-words',
    source:
      'async function frames(error:Error){return await new Request("https://example.test/",{method:"POST",body:new Error("fixed") as never}).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'request-getter-fixed',
    source:
      'async function frames(error:Error){return await new Request("https://example.test/",{method:"POST",get body(){return "fixed";}}).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'request-local-shadow',
    source:
      'class Request{constructor(_url:string,_init:unknown){}async text(){return "fixed";}}async function frames(error:Error){return await new Request("https://example.test/",{method:"POST",body:error}).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'request-ignored-tail',
    source:
      'async function frames(error:Error){return await new(Request as new(...args:unknown[])=>Request)("https://example.test/",{method:"POST",body:"fixed"},error).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'request-overwritten-body-data',
    source:
      'async function frames(error:Error){return await new Request("https://example.test/",{...{body:error as never},body:"fixed",method:"POST"}).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'request-error-options-not-body',
    source:
      'async function frames(error:Error){return await new Request("https://example.test/",error as RequestInit).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'url-parse-error-input',
    source:
      'function frames(error:Error){return URL.parse(error as never,"https://example.test/")?.href;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'url-parse-error-base',
    source: 'function frames(error:Error){return URL.parse("x",error as never)?.href;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'url-parse-global-qualified',
    source:
      'function frames(error:Error){return globalThis.URL.parse(error as never,"https://example.test/")?.href;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'url-parse-function-alias',
    source:
      'const parse=URL.parse;function frames(error:Error){return parse(error as never,"https://example.test/")?.href;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'url-parse-constructor-alias',
    source:
      'const Native=URL;function frames(error:Error){return Native.parse(error as never,"https://example.test/")?.href;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'url-parse-call',
    source:
      'function frames(error:Error){return URL.parse.call(null,error as never,"https://example.test/")?.href;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'url-parse-apply',
    source:
      'function frames(error:Error){return URL.parse.apply(null,[error as never,"https://example.test/"])?.href;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'url-parse-reflect-apply',
    source:
      'function frames(error:Error){return Reflect.apply(URL.parse,null,[error,"https://example.test/"])?.href;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'url-parse-known-spread',
    source:
      'function frames(error:Error){return URL.parse(...[error as never,"https://example.test/"] as const)?.href;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'url-parse-fixed-data',
    source:
      'function frames(error:Error){return URL.parse("fixed","https://example.test/")?.href;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'url-parse-local-words',
    source:
      'function frames(error:Error){return URL.parse(new Error("fixed") as never,"https://example.test/")?.href;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'url-parse-local-shadow',
    source:
      'const URL={parse(_input:unknown,_base?:unknown){return{href:"fixed"};}};function frames(error:Error){return URL.parse(error,"https://example.test/")?.href;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'url-parse-ignored-third',
    source:
      'function frames(error:Error){return (URL.parse as (...args:unknown[])=>URL|null)("fixed","https://example.test/",error)?.href;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'url-parse-ignored-receiver',
    source:
      'function frames(error:Error){return URL.parse.call(error,"fixed","https://example.test/")?.href;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
];

describe('request bodies and static URL parsing readers', () => {
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

describe('request bodies and static URL parsing admissions', () => {
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
