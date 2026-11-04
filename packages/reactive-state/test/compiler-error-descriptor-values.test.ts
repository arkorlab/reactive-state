import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native descriptor values retain the selected error member without evaluating getters. */
const CASES = [
  {
    id: 'object-native-stack',
    source:
      'function read(){return Object.getOwnPropertyDescriptor(new Error("ours"),"stack")?.value;}',
    invocation: 'read()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'reflect-native-stack',
    source:
      'function read(){return Reflect.getOwnPropertyDescriptor(new Error("ours"),"stack")?.value;}',
    invocation: 'read()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'object-supplied-message',
    source:
      'function read(error:Error){return Object.getOwnPropertyDescriptor(error,"message")?.value;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'constant-descriptor-alias',
    source:
      'function read(){const descriptor=Object.getOwnPropertyDescriptor(new Error("ours"),"stack");return descriptor?.value;}',
    invocation: 'read()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'computed-value-key',
    source:
      'function read(){return Object.getOwnPropertyDescriptor(new Error("ours"),"stack")?.["value"];}',
    invocation: 'read()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'reflect-read-descriptor',
    source:
      'function read(){return Reflect.get(Object.getOwnPropertyDescriptor(new Error("ours"),"stack")!,"value");}',
    invocation: 'read()',
    refused: true,
    sharedRefused: true,
  },
  {
    id: 'object-local-error-words',
    source:
      'function read(){return Object.getOwnPropertyDescriptor(new Error("ours"),"message")?.value;}',
    invocation: 'read()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'object-ordinary-data',
    source:
      'function read(){return Object.getOwnPropertyDescriptor({stack:"fixed"},"stack")?.value;}',
    invocation: 'read()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'object-getter-descriptor',
    source:
      'function read(){return Object.getOwnPropertyDescriptor({get stack(){return "fixed";}},"stack")?.value;}',
    invocation: 'read()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'object-shadow-data',
    source:
      'const Object={getOwnPropertyDescriptor:()=>({value:"fixed"})};function read(){return Object.getOwnPropertyDescriptor(new Error("ours"),"stack")?.value;}',
    invocation: 'read()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'reflect-shadow-data',
    source:
      'const Reflect={getOwnPropertyDescriptor:()=>({value:"fixed"})};function read(){return Reflect.getOwnPropertyDescriptor(new Error("ours"),"stack")?.value;}',
    invocation: 'read()',
    refused: false,
    sharedRefused: false,
  },
  {
    id: 'own-literal-error-stack',
    source:
      'function read(){class Failure extends Error {stack="fixed";}return Object.getOwnPropertyDescriptor(new Failure(),"stack")?.value;}',
    invocation: 'read()',
    refused: false,
    sharedRefused: true,
  },
  {
    id: 'outer-reflect-replaced-tuple',
    source:
      'function read(error:Error){const desc=Object.getOwnPropertyDescriptor(new Error("ours"),"message")!;const args:[unknown,string]=[desc,"value"];args[0]=error;args[1]="stack";return Reflect.get(...args);}',
    invocation: 'read(new Error("ours"))',
    refused: true,
    sharedRefused: true,
  },
] as const;

describe('descriptor value error readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'descriptor-values.ts', source);
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

describe('shared descriptor value error receivers', () => {
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
