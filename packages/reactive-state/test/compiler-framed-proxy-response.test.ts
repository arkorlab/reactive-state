import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'proxy-supplied-message',
    source: 'function frames(error:Error){return Proxy.revocable(error,{}).proxy.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'proxy-supplied-stack',
    source: 'function frames(error:Error){return Proxy.revocable(error,{}).proxy.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'proxy-created-stack',
    source:
      'function frames(error:Error){return Proxy.revocable(new Error("fixed"),{}).proxy.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'proxy-native-constructor-alias',
    source:
      'const Native=Proxy;function frames(error:Error){return Native.revocable(error,{}).proxy.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'proxy-literal-spread',
    source:
      'function frames(error:Error){return Proxy.revocable(...[error,{}] as const).proxy.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'proxy-non-get-handler',
    source:
      'function frames(error:Error){return Proxy.revocable(error,{has(){return false;}}).proxy.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'proxy-local-words',
    source:
      'function frames(error:Error){return Proxy.revocable(new Error("fixed"),{}).proxy.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'proxy-data-target',
    source: 'function frames(error:Error){return Proxy.revocable({stack:"fixed"},{}).proxy.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'proxy-get-intercepts',
    source:
      'function frames(error:Error){return Proxy.revocable(error,{get(){return "fixed";}}).proxy.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'proxy-local-shadow',
    source:
      'const Proxy={revocable(_value:unknown,_handler:unknown){return{proxy:{stack:"fixed"}}}};function frames(error:Error){return Proxy.revocable(error,{}).proxy.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'proxy-revoked-pair-opaque',
    source:
      'function frames(error:Error){const pair=Proxy.revocable(error,{});pair.revoke();return pair.proxy.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-supplied-body',
    source: 'async function frames(error:Error){return await new Response(error as never).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'response-caught-body',
    source:
      'async function frames(){try{JSON.parse("{");}catch(error){return await new Response(error as never).text();}}',
    invocation: 'frames()',
    reader: true,
    refused: true,
  },
  {
    id: 'response-native-alias',
    source:
      'const Native=Response;async function frames(error:Error){return await new Native(error as never).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'response-reflect-construct',
    source:
      'async function frames(error:Error){return await Reflect.construct(Response,[error]).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'response-array-body',
    source:
      'async function frames(error:Error){return await new Response([error] as never).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'response-literal-spread',
    source:
      'async function frames(error:Error){return await new Response(...[error as never] as const).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'response-local-words',
    source:
      'async function frames(error:Error){return await new Response(new Error("fixed") as never).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-plain-text',
    source: 'async function frames(error:Error){return await new Response("fixed").text();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-no-body',
    source: 'async function frames(error:Error){return await new Response().text();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-ignored-tail',
    source:
      'async function frames(error:Error){return await new(Response as new(...args:unknown[])=>Response)("fixed",{},error).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'response-local-shadow',
    source:
      'class Response{constructor(_value:unknown){}async text(){return "fixed";}}async function frames(error:Error){return await new Response(error).text();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
];

describe('revocable proxies and response bodies readers', () => {
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

describe('revocable proxies and response bodies admissions', () => {
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
