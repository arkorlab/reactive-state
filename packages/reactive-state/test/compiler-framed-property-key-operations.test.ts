import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'Error-in-key',
    source: 'function frames(error:Error){return (error as never) in {};}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'Object-hasOwn-key',
    source: 'function frames(error:Error){return Object.hasOwn({},error as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'Reflect-has-key',
    source: 'function frames(error:Error){return Reflect.has({},error as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'Object-descriptor-key',
    source:
      'function frames(error:Error){return Object.getOwnPropertyDescriptor({},error as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'Reflect-define-key',
    source:
      'function frames(error:Error){return Reflect.defineProperty({},error as never,{value:"fixed"});}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'Object-hasOwn-call-key',
    source: 'function frames(error:Error){return Object.hasOwn.call(null,{},error as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'Object-hasOwn-apply-key',
    source: 'function frames(error:Error){return Object.hasOwn.apply(null,[{},error as never]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'Object-hasOwn-Reflect-apply-key',
    source:
      'function frames(error:Error){return Reflect.apply(Object.hasOwn,null,[{},error as never]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'prototype-hasOwn-call-key',
    source:
      'function frames(error:Error){return Object.prototype.hasOwnProperty.call({},error as never);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'ordinary-string-key',
    source: 'function frames(){return Object.hasOwn({fixed:1},"fixed");}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'native-symbol-key',
    source: 'function frames(){return Reflect.has({},Symbol.toStringTag);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'local-error-key',
    source: 'function frames(){return Object.hasOwn({},new Error("ours") as never);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'shadowed-Object-key',
    source:
      'const Object={hasOwn(_target:unknown,_key:unknown){return true;}};function frames(error:Error){return Object.hasOwn({},error);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'ignored-extra-key-argument',
    source:
      'function frames(error:Error){return (Object.hasOwn as (...args:unknown[])=>boolean)({},"fixed",error);}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('property-key-operations readers', () => {
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

describe('shared property-key-operations', () => {
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
