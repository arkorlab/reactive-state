import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A constructor parameter's default, and a binding element's on the way to a destructured name,
 * stand for what the construction leaves `undefined`, with the parameters they read.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'default-reads-parameter',
    source:
      'class Failure extends Error {constructor(error:unknown,message=String(error)){super(message);}} function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'binding-default-reads-parameter',
    source:
      'class Failure extends Error {constructor(error:unknown,{message=error}:{message?:unknown}={}){super(message as never);}} function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'pattern-default-reads-parameter',
    source:
      'class Failure extends Error {constructor(error:unknown,{message}:{message?:unknown}={message:error}){super(message as never);}} function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'member-default-reads-parameter',
    source:
      'class Failure extends Error {constructor(options:{e:unknown},message=String(options.e)){super(message);}} function frames(error:Error){return new Failure({e:error}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-binding-default',
    source:
      'class Failure extends Error {constructor(error:unknown,{inner:{message}={message:error}}:{inner?:{message?:unknown}}={}){super(message as never);}} function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'chained-parameter-defaults',
    source:
      'class Failure extends Error {constructor(error:unknown,first=error,message=first){super(message as never);}} function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'literal-default',
    source:
      "class Failure extends Error {constructor(error:unknown,message='fixed'){super(message);}} function frames(error:Error){return new Failure(error).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'given-argument-over-default',
    source:
      "class Failure extends Error {constructor(error:unknown,message:unknown='fixed'){super(message as never);}} function frames(error:Error){return new Failure(error,'given').message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'binding-literal-default',
    source:
      "class Failure extends Error {constructor({message='fixed'}:{message?:string}={}){super(message);}} function frames(error:Error){return new Failure({}).message+String(error===undefined);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('subclass parameter default readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'subclass-parameter-defaults.ts', source);
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

describe('shared subclass parameter default admissions', () => {
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
