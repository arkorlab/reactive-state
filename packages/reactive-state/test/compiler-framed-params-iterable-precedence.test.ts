import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'urlsearchparams-reported-method',
    source:
      'function frames(error:Error){return new URLSearchParams({failure:error,*[Symbol.iterator](){yield["safe","fixed"];}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'headers-reported-method',
    source:
      'function frames(error:Error){return new Headers({failure:error,*[Symbol.iterator](){yield["safe","fixed"];}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'urlsearchparams-whole-record-alias',
    source:
      'function frames(error:Error){const input={failure:error,*[Symbol.iterator](){yield["safe","fixed"];}};return new URLSearchParams(input as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'headers-whole-record-alias',
    source:
      'function frames(error:Error){const input={failure:error,*[Symbol.iterator](){yield["safe","fixed"];}};return new Headers(input as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'urlsearchparams-whole-record-alias-chain',
    source:
      'function frames(error:Error){const input={failure:error,*[Symbol.iterator](){yield["safe","fixed"];}};const alias=input;return new URLSearchParams(alias as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'headers-whole-record-alias-chain',
    source:
      'function frames(error:Error){const input={failure:error,*[Symbol.iterator](){yield["safe","fixed"];}};const alias=input;return new Headers(alias as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'urlsearchparams-two-entries',
    source:
      'function frames(error:Error){return new URLSearchParams({failure:error,*[Symbol.iterator](){yield["first","one"];yield["safe","fixed"];}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'headers-two-entries',
    source:
      'function frames(error:Error){return new Headers({failure:error,*[Symbol.iterator](){yield["first","one"];yield["safe","fixed"];}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'urlsearchparams-empty-generator',
    source:
      'function frames(error:Error){return new URLSearchParams({failure:error,*[Symbol.iterator](){}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'headers-empty-generator',
    source:
      'function frames(error:Error){return new Headers({failure:error,*[Symbol.iterator](){}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'urlsearchparams-generator-function-field',
    source:
      'function frames(error:Error){return new URLSearchParams({failure:error,[Symbol.iterator]:function*(){yield["safe","fixed"];}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'headers-generator-function-field',
    source:
      'function frames(error:Error){return new Headers({failure:error,[Symbol.iterator]:function*(){yield["safe","fixed"];}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'urlsearchparams-iterator-getter',
    source:
      'function frames(error:Error){return new URLSearchParams({failure:error,get[Symbol.iterator](){return function*(){yield["safe","fixed"];};}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'headers-iterator-getter',
    source:
      'function frames(error:Error){return new Headers({failure:error,get[Symbol.iterator](){return function*(){yield["safe","fixed"];};}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'urlsearchparams-native-symbol-alias',
    source:
      'function frames(error:Error){const iterator=Symbol.iterator;return new URLSearchParams({failure:error,*[iterator](){yield["safe","fixed"];}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'headers-native-symbol-alias',
    source:
      'function frames(error:Error){const iterator=Symbol.iterator;return new Headers({failure:error,*[iterator](){yield["safe","fixed"];}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'urlsearchparams-native-constructor-alias',
    source:
      'function frames(error:Error){const Native=URLSearchParams;return new Native({failure:error,*[Symbol.iterator](){yield["safe","fixed"];}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'headers-native-constructor-alias',
    source:
      'function frames(error:Error){const Native=Headers;return new Native({failure:error,*[Symbol.iterator](){yield["safe","fixed"];}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'urlsearchparams-unused-record-getter',
    source:
      'function frames(error:Error){return new URLSearchParams({get failure(){return error;},*[Symbol.iterator](){yield["safe","fixed"];}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'headers-unused-record-getter',
    source:
      'function frames(error:Error){return new Headers({get failure(){return error;},*[Symbol.iterator](){yield["safe","fixed"];}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'urlsearchparams-unused-ordinary-method',
    source:
      'function frames(error:Error){return new URLSearchParams({failure:error,unused(){return error;},*[Symbol.iterator](){yield["safe","fixed"];}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'headers-unused-ordinary-method',
    source:
      'function frames(error:Error){return new Headers({failure:error,unused(){return error;},*[Symbol.iterator](){yield["safe","fixed"];}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'urlsearchparams-primitive-tuple-alias',
    source:
      'function frames(error:Error){const word="fixed";return new URLSearchParams({failure:error,*[Symbol.iterator](){yield["safe",word];}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'headers-primitive-tuple-alias',
    source:
      'function frames(error:Error){const word="fixed";return new Headers({failure:error,*[Symbol.iterator](){yield["safe",word];}}as never).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'urlsearchparams-record-fallback-error',
    source:
      'function frames(error:Error){return new URLSearchParams({failure:error}as never).get("failure");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'headers-record-fallback-error',
    source:
      'function frames(error:Error){return new Headers({failure:error}as never).get("failure");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'urlsearchparams-string-iterator-name',
    source:
      'function frames(error:Error){return new URLSearchParams({failure:error,"Symbol.iterator":"unused"}as never).get("failure");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'headers-string-iterator-name',
    source:
      'function frames(error:Error){return new Headers({failure:error,"Symbol.iterator":"unused"}as never).get("failure");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'urlsearchparams-yielded-error-retains-private',
    source:
      'function frames(error:Error){return new URLSearchParams({failure:error,*[Symbol.iterator](){yield["failure",error as never];}}as never).get("failure");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'headers-yielded-error-retains-private',
    source:
      'function frames(error:Error){return new Headers({failure:error,*[Symbol.iterator](){yield["failure",error as never];}}as never).get("failure");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'urlsearchparams-changed-iterator',
    source:
      'function frames(error:Error){const input={failure:error,*[Symbol.iterator](){yield["failure","fixed"];}};input[Symbol.iterator]=function*(){yield["failure",error as never];};return new URLSearchParams(input as never).get("failure");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'headers-changed-iterator',
    source:
      'function frames(error:Error){const input={failure:error,*[Symbol.iterator](){yield["failure","fixed"];}};input[Symbol.iterator]=function*(){yield["failure",error as never];};return new Headers(input as never).get("failure");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'urlsearchparams-ignored-constructor-tail',
    source:
      'function frames(error:Error){const input={failure:error,*[Symbol.iterator](){yield["failure","fixed"];}};return new(URLSearchParams as new(...args:unknown[])=>URLSearchParams)(input,Object.assign(input,{[Symbol.iterator]:function*(){yield["failure",error as never];}})).get("failure");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'headers-ignored-constructor-tail',
    source:
      'function frames(error:Error){const input={failure:error,*[Symbol.iterator](){yield["failure","fixed"];}};return new(Headers as new(...args:unknown[])=>Headers)(input,Object.assign(input,{[Symbol.iterator]:function*(){yield["failure",error as never];}})).get("failure");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'urlsearchparams-observed-key-conversion',
    source:
      'function frames(error:Error){return new URLSearchParams({failure:error,*[Symbol.iterator](){yield["safe","fixed"];}}as never).get(error as never);}',
    invocation: 'frames(Object.assign(new Error("safe"),{name:""}))',
    refused: true,
  },
  {
    id: 'headers-observed-key-conversion',
    source:
      'function frames(error:Error){return new Headers({failure:error,*[Symbol.iterator](){yield["safe","fixed"];}}as never).get(error as never);}',
    invocation: 'frames(Object.assign(new Error("safe"),{name:""}))',
    refused: true,
  },
  {
    id: 'urlsearchparams-local-constructor-shadow',
    source:
      'function frames(error:Error){class URLSearchParams{constructor(_input:unknown){}get(_key:string){return"fixed";}}return new URLSearchParams({failure:error,*[Symbol.iterator](){yield["safe","fixed"];}}).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'headers-local-constructor-shadow',
    source:
      'function frames(error:Error){class Headers{constructor(_input:unknown){}get(_key:string){return"fixed";}}return new Headers({failure:error,*[Symbol.iterator](){yield["safe","fixed"];}}).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'urlsearchparams-ordinary-data-entries',
    source:
      'function frames(error:Error){return new URLSearchParams([["safe","fixed"]]).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'headers-ordinary-data-entries',
    source: 'function frames(error:Error){return new Headers([["safe","fixed"]]).get("safe");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native parameter iterable readers', () => {
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

describe('native parameter iterable shared', () => {
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
