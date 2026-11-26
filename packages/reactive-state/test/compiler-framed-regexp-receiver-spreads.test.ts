import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'call-receiver-spread',
    source:
      'function frames(error:Error){return (RegExp.call as (...args:unknown[])=>RegExp)(...[null],error).source;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'apply-receiver-spread',
    source:
      'function frames(error:Error){return (RegExp.apply as (...args:unknown[])=>RegExp)(...[null,[error]]).source;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reflect-receiver-spread',
    source:
      'function frames(error:Error){return (Reflect.apply as (...args:unknown[])=>RegExp)(...[RegExp,null,[error]]).source;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'call-spread-data',
    source:
      "function frames(){return (RegExp.call as (...args:unknown[])=>RegExp)(...[null],'fixed').source;}",
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'apply-spread-data',
    source:
      "function frames(){return (RegExp.apply as (...args:unknown[])=>RegExp)(...[null,['fixed']]).source;}",
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'reflect-spread-data',
    source:
      "function frames(){return (Reflect.apply as (...args:unknown[])=>RegExp)(...[RegExp,null,['fixed']]).source;}",
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'call-spread-ignored-tail',
    source:
      "function frames(error:Error){return (RegExp.call as (...args:unknown[])=>RegExp)(...[null],'fixed','',error).source;}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'apply-spread-ignored-tail',
    source:
      "function frames(error:Error){return (RegExp.apply as (...args:unknown[])=>RegExp)(...[null,['fixed','',error]]).source;}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reflect-spread-ignored-tail',
    source:
      "function frames(error:Error){return (Reflect.apply as (...args:unknown[])=>RegExp)(...[RegExp,null,['fixed','',error]]).source;}",
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('regexp error conversion readers', () => {
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

describe('shared regexp error conversions', () => {
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
