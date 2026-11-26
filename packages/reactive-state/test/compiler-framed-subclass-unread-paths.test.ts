import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A forwarded constructor parameter read past a key the compile cannot read, or through a rest
 * pattern, keeps every member it may then select possible.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'symbol-member-key',
    source:
      "const sym=Symbol('m');class Failure extends Error {constructor(options:{[sym]:unknown}){super(options[sym] as never);}} function frames(error:Error){return new Failure({[sym]:error}).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unread-string-key',
    source:
      "class Failure extends Error {constructor(options:Record<string,unknown>,key:string){super(options[key] as never);}} function frames(error:Error){return new Failure({message:error},'message').message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'object-rest-member',
    source:
      'class Failure extends Error {constructor({...rest}:Record<string,unknown>){super(rest.message as never);}} function frames(error:Error){return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'array-rest-index',
    source:
      "class Failure extends Error {constructor([first,...items]:unknown[]){super(items[0] as never);}} function frames(error:Error){return new Failure(['x',error]).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'array-rest-whole',
    source:
      'class Failure extends Error {constructor([...items]:unknown[]){super(String(items));}} function frames(error:Error){return new Failure([error]).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'held-unread-key',
    source:
      "const sym=Symbol('m');class Failure extends Error {constructor(options:{[sym]:unknown}){super(options[sym] as never);}} function frames(error:Error){const options={[sym]:error};return new Failure(options).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spread-unread-key',
    source:
      "const sym=Symbol('m');class Failure extends Error {constructor(options:{[sym]:unknown}){super(options[sym] as never);}} function frames(error:Error){return new Failure({...{[sym]:error}}).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unread-key-data',
    source:
      "const sym=Symbol('m');class Failure extends Error {constructor(options:{[sym]:unknown}){super(options[sym] as never);}} function frames(error:Error){return new Failure({[sym]:'fixed'}).message+String(error===undefined);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'object-rest-other-member',
    source:
      "class Failure extends Error {constructor({...rest}:Record<string,unknown>){super(rest.code as never);}} function frames(error:Error){return new Failure({code:'E1',cause:error}).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'array-rest-other-index',
    source:
      "class Failure extends Error {constructor([first,...items]:unknown[]){super(items[0] as never);}} function frames(error:Error){return new Failure([error,'fixed']).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('subclass unread parameter path readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'subclass-unread-paths.ts', source);
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

describe('shared subclass unread parameter path admissions', () => {
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
