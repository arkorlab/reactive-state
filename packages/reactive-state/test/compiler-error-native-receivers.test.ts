import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Explicit native construction, transparent proxies and this annotations retain errors. */
const CASES = [
  {
    id: 'reflect-native-error-stack',
    source: 'function frames(){return Reflect.construct(Error,[]).stack;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'reflect-global-native-stack',
    source: 'function frames(){return globalThis.Reflect.construct(TypeError,[]).stack;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'reflect-written-error-words',
    source: 'function frames(){return Reflect.construct(Error,["ours"]).message;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: true,
  },
  {
    id: 'reflect-ordinary-data-constructor',
    source: 'function frames(){class Data{stack="fixed";}return Reflect.construct(Data,[]).stack;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'reflect-shadowed-native',
    source:
      'function frames(){const Reflect={construct(_kind:unknown,_args:unknown[]){return {stack:"fixed"};}};return Reflect.construct(Error,[]).stack;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: true,
  },
  {
    id: 'proxy-supplied-error-stack',
    source: 'function frames(error:Error){return new Proxy(error,{}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'proxy-global-supplied-words',
    source: 'function frames(error:Error){return new globalThis.Proxy(error,{}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'proxy-written-error-stack',
    source: 'function frames(){return new Proxy(new Error("ours"),{}).stack;}',
    invocation: 'frames()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'proxy-written-error-words',
    source: 'function frames(){return new Proxy(new Error("ours"),{}).message;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'proxy-ordinary-data',
    source: 'function frames(){return new Proxy({stack:"fixed"},{}).stack;}',
    invocation: 'frames()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'proxy-custom-get-data',
    source: 'function frames(error:Error){return new Proxy(error,{get(){return "fixed";}}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'proxy-shadowed-native',
    source:
      'function frames(error:Error){class Proxy{stack="fixed";constructor(_value:unknown,_handler:unknown){}}return new Proxy(error,{}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'explicit-this-error-stack',
    source: 'function frames(this:Error){return this.stack;}',
    invocation: 'frames.call(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'explicit-this-aliased-error',
    source: 'type Failure=Error;function frames(this:Failure){return this.stack;}',
    invocation: 'frames.call(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'arrow-keeps-explicit-this',
    source: 'function frames(this:Error){const read=()=>this.stack;return read();}',
    invocation: 'frames.call(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'explicit-this-ordinary-data',
    source: 'function frames(this:{stack:string}){return this.stack;}',
    invocation: 'frames.call({stack:"fixed"})',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'nested-function-this-boundary',
    source:
      'function frames(this:Error){function read(){return (this as {stack:string}).stack;}return read.call({stack:"fixed"});}',
    invocation: 'frames.call(new Error("ours"))',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'explicit-this-shadowed-error',
    source: 'type Error={stack:string};function frames(this:Error){return this.stack;}',
    invocation: 'frames.call({stack:"fixed"})',
    refused: false,
    sharedRefused: false,
  },
];

describe('written error receiver readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'written-error-receivers.ts', source);
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

describe('shared written error receivers', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, sharedRefused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const sharedReason = expect.stringContaining('a shared module that answers otherwise');
    const expected = sharedRefused ? [sharedReason] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
