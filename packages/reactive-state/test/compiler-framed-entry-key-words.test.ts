import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A known own encoder method does not convert arguments by native Web IDL rules. */
const CASES = [
  {
    id: 'entries-native-key',
    source: 'function frames(error:Error){return Object.keys(Object.fromEntries([[error,1]]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'entries-const-alias',
    source:
      'function frames(error:Error){const entries=[[error,1]];return Object.keys(Object.fromEntries(entries))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'entries-native-call',
    source:
      'function frames(error:Error){return Object.keys(Object.fromEntries.call(null,[[error,1]]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'entries-native-apply',
    source:
      'function frames(error:Error){return Object.keys(Object.fromEntries.apply(null,[[[error,1]]]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'entries-reflect-apply',
    source:
      'function frames(error:Error){return Object.keys(Reflect.apply(Object.fromEntries,null,[[[error,1]]]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'entries-iterable-spread',
    source:
      'function frames(error:Error){return Object.keys(Object.fromEntries([...[[error,1]]]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'entries-key-spread',
    source:
      'function frames(error:Error){return Object.keys(Object.fromEntries([[...[error]as[Error],1]]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'entries-array-key',
    source:
      'function frames(error:Error){return Object.keys(Object.fromEntries([[[error],1]]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'entries-value-error-data',
    source:
      'function frames(error:Error){return Object.keys(Object.fromEntries([["fixed",error]]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'entries-ignored-entry-tail',
    source:
      'function frames(error:Error){return Object.keys(Object.fromEntries([["fixed",1,error]]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'entries-local-words',
    source:
      'function frames(){return Object.keys(Object.fromEntries([[new Error("ours"),1]]))[0];}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'entries-local-shadow',
    source:
      'function frames(error:Error){const Object={fromEntries(_value:unknown){return{fixed:1}}};return Object.fromEntries([[error,1]]).fixed;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'entries-key-spread-data',
    source:
      'function frames(error:Error){return Object.keys(Object.fromEntries([[...["fixed"]as[string],error]]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'entries-ignored-call-tail',
    source:
      'function frames(error:Error){return Object.keys((Object.fromEntries.call as(...args:unknown[])=>Record<string,unknown>)(error,[["fixed",1]],error))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'entries-error-is-not-key',
    source:
      'function frames(error:Error){return Object.keys(Object.fromEntries([error as unknown as[PropertyKey,unknown]]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'entries-function-alias',
    source:
      'function frames(error:Error){const build=Object.fromEntries;return Object.keys(build([[error,1]]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'entries-written-key-error',
    source:
      'function frames(error:Error){const entry:[unknown,unknown]=["fixed",1];entry[0]=error;return Object.keys(Object.fromEntries([entry]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'entries-written-value-data',
    source:
      'function frames(error:Error){const entry:[unknown,unknown]=["fixed",1];entry[1]=error;return Object.keys(Object.fromEntries([entry]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('entry-key-words readers', () => {
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

describe('shared entry-key-wordss', () => {
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
