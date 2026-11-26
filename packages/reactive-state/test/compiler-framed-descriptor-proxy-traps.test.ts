import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'native-proxy-descriptor-trap',
    source:
      'function frames(error:Error){const proxy=new Proxy({}, {getOwnPropertyDescriptor(){return {configurable:true,value:error};}});return Object.getOwnPropertyDescriptor(proxy,"x")!.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reflect-proxy-descriptor-trap',
    source:
      'function frames(error:Error){return Reflect.getOwnPropertyDescriptor(new Proxy({}, {getOwnPropertyDescriptor(){return {configurable:true,value:error};}}),"x")!.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plural-proxy-descriptor-trap',
    source:
      'function frames(error:Error){const proxy=new Proxy({}, {ownKeys(){return ["x"];},getOwnPropertyDescriptor(){return {configurable:true,value:error};}});return Object.getOwnPropertyDescriptors(proxy).x.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'empty-proxy-forwards-own-value',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({x:error},{}),"x")!.value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'proxy-trap-data-value',
    source:
      'function frames(){return Object.getOwnPropertyDescriptor(new Proxy({}, {getOwnPropertyDescriptor(){return {configurable:true,value:{stack:"fixed"}};}}),"x")!.value.stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'proxy-accessor-has-no-value',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor(new Proxy({}, {getOwnPropertyDescriptor(){return {configurable:true,get(){return error;}};}}),"x")!.value?.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'proxy-local-made-message',
    source:
      'function frames(){return Object.getOwnPropertyDescriptor(new Proxy({}, {getOwnPropertyDescriptor(){return {configurable:true,value:new Error("ours")};}}),"x")!.value.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'empty-proxy-forwards-native-stack-descriptor',
    source:
      'function frames(){return Object.getOwnPropertyDescriptor(new Proxy(new Error("ours"),{}),"stack")!.value;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'unrelated-trap-forwards-native-stack-descriptor',
    source:
      'function frames(){return Object.getOwnPropertyDescriptor(new Proxy(new Error("ours"),{has(){return true;}}),"stack")!.value;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'mutable-tuple-retains-native-target-alternative',
    source:
      'function frames(){const proxy=new Proxy(new Error("ours"),{getOwnPropertyDescriptor(){return {configurable:true,value:{stack:"fixed"}};}});const args=[proxy,"stack"];args[0]=new Error("later");return Object.getOwnPropertyDescriptor(...args)!.value;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'proxy-trap-overrides-native-target',
    source:
      'function frames(){return Object.getOwnPropertyDescriptor(new Proxy(new Error("ours"),{getOwnPropertyDescriptor(){return {configurable:true,value:{stack:"fixed"}};}}),"stack")!.value.stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'proxy-descriptor-trap-keeps-ordinary-stack-private',
    source:
      'function frames(){return new Proxy(new Error("ours"),{getOwnPropertyDescriptor(){return {configurable:true,value:{stack:"fixed"}};}}).stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'reflect-proxy-trap-overrides-native-target',
    source:
      'function frames(){return Reflect.getOwnPropertyDescriptor(new Proxy(new Error("ours"),{getOwnPropertyDescriptor(){return {configurable:true,value:{stack:"fixed"}};}}),"stack")!.value.stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'proxy-trap-primitive-value-overrides-native-stack',
    source:
      'function frames(){return String(Object.getOwnPropertyDescriptor(new Proxy(new Error("ours"),{getOwnPropertyDescriptor(){return {configurable:true,value:"fixed"};}}),"stack")!.value);}',
    invocation: 'frames()',
    refused: false,
  },
];

describe('descriptor-proxy-traps readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'recursive-error-members.ts', source);
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

describe('shared descriptor-proxy-traps', () => {
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
