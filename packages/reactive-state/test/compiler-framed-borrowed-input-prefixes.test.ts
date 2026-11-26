import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A known own encoder method does not convert arguments by native Web IDL rules. */
const CASES = [
  {
    id: 'symbol-known-receiver-spread',
    source:
      'function frames(error:Error){return Symbol.for.call(...[null]as[null],error as never).description;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'entries-known-receiver-spread',
    source:
      'function frames(error:Error){return Object.keys(Object.fromEntries.call(...[null]as[null],[[error,1]]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'symbol-known-receiver-spread-data',
    source: 'function frames(){return Symbol.for.call(...[null]as[null],"fixed").description;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'entries-known-receiver-spread-data',
    source:
      'function frames(error:Error){return Object.keys(Object.fromEntries.call(...[null]as[null],[["fixed",error]]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'symbol-unknown-prefix',
    source:
      'function frames(error:Error,values:unknown[]){return Symbol.for.call(...values,error as never).description;}',
    invocation: 'frames(new Error("ours"),[null])',
    refused: true,
  },
  {
    id: 'entries-unknown-prefix',
    source:
      'function frames(error:Error,values:unknown[]){return Object.keys(Object.fromEntries.call(...values,[[error,1]]))[0];}',
    invocation: 'frames(new Error("ours"),[null])',
    refused: true,
  },
  {
    id: 'symbol-ignored-receiver-tail',
    source:
      'function frames(error:Error){return(Symbol.for.call as(...args:unknown[])=>symbol)(...[error]as[Error],"fixed",error).description;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'entries-ignored-receiver-tail',
    source:
      'function frames(error:Error){return Object.keys((Object.fromEntries.call as(...args:unknown[])=>Record<string,unknown>)(...[error]as[Error],[["fixed",error]],error))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'symbol-apply-receiver-spread',
    source:
      'function frames(error:Error){return Symbol.for.apply(...[null]as[null],[error as never]).description;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'entries-apply-receiver-spread',
    source:
      'function frames(error:Error){return Object.keys(Object.fromEntries.apply(...[null]as[null],[[[error,1]]]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'symbol-reflect-receiver-spread',
    source:
      'function frames(error:Error){return Reflect.apply(Symbol.for,...[null]as[null],[error]).description;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'entries-reflect-target-spread',
    source:
      'function frames(error:Error){return Object.keys(Reflect.apply(...[Object.fromEntries,null]as[typeof Object.fromEntries,null],[[[error,1]]]))[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('receiver-spread independent readers', () => {
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

describe('receiver-spread independent shared', () => {
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
