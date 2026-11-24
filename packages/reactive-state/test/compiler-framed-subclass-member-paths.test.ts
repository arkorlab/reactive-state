import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A constructor parameter a `super` argument reads along a written member or element path passes
 * on only what the construction gives at that path.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-member-path',
    source:
      'class Failure extends Error {constructor(options:{message:unknown}){super(options.message as never);}} function frames(error:Error){return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'element-path',
    source:
      'class Failure extends Error {constructor(list:unknown[]){super(list[0] as never);}} function frames(error:Error){return new Failure([error]).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-member-path',
    source:
      'class Failure extends Error {constructor(options:{inner:{message:unknown}}){super(options.inner.message as never);}} function frames(error:Error){return new Failure({inner:{message:error}}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'rest-index-path',
    source:
      "class Failure extends Error {constructor(...args:unknown[]){super(args[1] as never);}} function frames(error:Error){return new Failure('x',error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'wrapped-member-path',
    source:
      'class Failure extends Error {constructor(options:unknown){super((options as {message:unknown}).message as never);}} function frames(error:Error){return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'method-on-parameter',
    source:
      'class Failure extends Error {constructor(options:{toString():string}){super(options.toString());}} function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'held-argument-member',
    source:
      'class Failure extends Error {constructor(options:{message:unknown}){super(options.message as never);}} function frames(error:Error){const options={message:error};return new Failure(options).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'template-member-path',
    source: `class Failure extends Error {constructor(options:{message:unknown}){super(\`wrapped: \${options.message}\`);}} function frames(error:Error){return new Failure({message:error}).message;}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'chained-member-path',
    source:
      'class Base extends Error {constructor(text:never){super(text);}} class Failure extends Base {constructor(options:{message:unknown}){super(options.message as never);}} function frames(error:Error){return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'other-member-path',
    source:
      "class Failure extends Error {constructor(options:{code:string;cause:unknown}){super(options.code);}} function frames(error:Error){return new Failure({code:'E1',cause:error}).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'element-other-index',
    source:
      "class Failure extends Error {constructor(list:unknown[]){super(list[0] as never);}} function frames(error:Error){return new Failure(['fixed',error]).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'rest-other-index',
    source:
      "class Failure extends Error {constructor(...args:unknown[]){super(args[0] as never);}} function frames(error:Error){return new Failure('fixed',error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('subclass parameter member path readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'subclass-member-paths.ts', source);
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

describe('shared subclass parameter member path admissions', () => {
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
