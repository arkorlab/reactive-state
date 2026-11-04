import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A field a destructured constructor parameter selects is resolved through the written values the
 * construction gives, then converted as a whole message argument is, arrays included.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-destructured-array',
    source:
      'class Failure extends Error {constructor({message}:{message:never}){super(message);}} function frames(error:Error){return new Failure({message:[error] as never}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'destructured-nested-array',
    source:
      'class Failure extends Error {constructor({message}:{message:never}){super(message);}} function frames(error:Error){return new Failure({message:[[error]] as never}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'destructured-held-array',
    source:
      'class Failure extends Error {constructor({message}:{message:never}){super(message);}} function frames(error:Error){const options={message:[error]};return new Failure(options as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'destructured-held-field',
    source:
      'class Failure extends Error {constructor({message}:{message:never}){super(message);}} function frames(error:Error){const list=[error];return new Failure({message:list as never}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'destructured-getter-array',
    source:
      'class Failure extends Error {constructor({message}:{message:never}){super(message);}} function frames(error:Error){return new Failure({get message(){return [error] as never;}}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'destructured-element-array',
    source:
      'class Failure extends Error {constructor([first]:[never]){super(first);}} function frames(error:Error){return new Failure([[error]] as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'destructured-data-array',
    source:
      "class Failure extends Error {constructor({message}:{message:never}){super(message);}} function frames(error:Error){return new Failure({message:['fixed'] as never}).message+String(error===undefined);}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'destructured-other-field',
    source:
      "class Failure extends Error {constructor({code}:{code:string;cause?:unknown}){super(code);}} function frames(error:Error){return new Failure({code:'E1',cause:[error]}).message;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('selected subclass message field readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'subclass-selected-fields.ts', source);
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

describe('shared selected subclass message field admissions', () => {
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
