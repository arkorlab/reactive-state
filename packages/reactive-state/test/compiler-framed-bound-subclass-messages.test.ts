import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A construction of a bound local Error subclass passes its bound arguments, ahead of its own, on
 * to the native message as the native bound function does.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'bound-subclass-alias',
    source:
      'class Failure extends Error {} function frames(error:Error){const Bound=Failure.bind(null,error as never);return new Bound().message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'bound-subclass-direct',
    source:
      'class Failure extends Error {} function frames(error:Error){return new (Failure.bind(null,error as never))().message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'bound-prefix-then-argument',
    source:
      "class Failure extends Error {constructor(code:string,error:never){super(error);}} function frames(error:Error){const Bound=Failure.bind(null,'code');return new Bound(error as never).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reflect-bound-subclass',
    source:
      'class Failure extends Error {} function frames(error:Error){return Reflect.construct(Failure.bind(null,error as never),[]).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'bound-subclass-literal',
    source:
      "class Failure extends Error {} function frames(error:Error){const Bound=Failure.bind(null,'fixed');return new Bound().message+String(error===undefined);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'bound-prefix-literal',
    source:
      "class Failure extends Error {constructor(code:string,text:string){super(text);}} function frames(error:Error){const Bound=Failure.bind(null,'code');return new Bound('fixed').message+String(error===undefined);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('bound subclass message readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'bound-subclass-messages.ts', source);
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

describe('shared bound subclass message admissions', () => {
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
