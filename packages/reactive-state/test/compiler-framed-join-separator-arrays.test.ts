import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native join converts an array separator to text as String does, own text methods first. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const OURS = 'frames(new Error("ours"))';

const CASES: readonly Case[] = [
  {
    id: 'join-array-separator-review',
    source: 'function frames(error:Error){return["a","b"].join([error]as never);}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'join-nested-array-separator',
    source: 'function frames(error:Error){return["a","b"].join([[error]]as never);}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'join-separator-alias',
    source:
      'function frames(error:Error){const separator=[error];return["a","b"].join(separator as never);}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'join-typed-separator',
    source:
      'function frames(error:Error,separator:Error[]){return["a","b"].join(separator as never);}',
    invocation: 'frames(new Error("ours"),[new Error("ours")])',
    refused: true,
  },
  {
    id: 'join-borrowed-call-separator',
    source: 'function frames(error:Error){return Array.prototype.join.call(["a","b"],[error]);}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'join-borrowed-apply-separator',
    source:
      'function frames(error:Error){return Array.prototype.join.apply(["a","b"],[[error]]as never);}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'join-error-separator-pin',
    source: 'function frames(error:Error){return["a","b"].join(error as never);}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'join-local-words-separator-pin',
    source: 'function frames(error:Error){return["a","b"].join([new Error("fixed")]as never);}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'join-data-separator-pin',
    source: 'function frames(error:Error){return["a","b"].join(["-"]as never);}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'join-own-to-string-separator-pin',
    source:
      'function frames(error:Error){const separator=[error];separator.toString=()=>"-";return["a","b"].join(separator as never);}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'join-own-join-separator-pin',
    source:
      'function frames(error:Error){const separator=[error];separator.join=()=>"-";return["a","b"].join(separator as never);}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'join-ignored-argument-pin',
    source:
      'function frames(error:Error){return(["a","b"].join as(...args:unknown[])=>string)(",",[error]);}',
    invocation: OURS,
    refused: false,
  },
];

describe('join separator array readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'join-separators.ts', source);
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

describe('shared join separator array admissions', () => {
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
