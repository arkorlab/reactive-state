import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A nested index read selects an element of the outer array, then the inner element it holds. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const OURS = 'frames(new Error("ours"))';

const CASES: readonly Case[] = [
  {
    id: 'flat-map-nested-index',
    source: 'function frames(error:Error){return[0].flatMap(()=>[...[[error]]])[0]![0]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'nested-literal-index',
    source: 'function frames(error:Error){return[[error]][0]![0]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'nested-literal-later-index',
    source:
      'function frames(error:Error){return[[{stack:"fixed"}],[{stack:"fixed"},error]][1]![1]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'nested-literal-words',
    source: 'function frames(error:Error){return[[error]][0]![0]!.message;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'nested-whole-alias',
    source: 'function frames(error:Error){const rows=[[error]];return rows[0]![0]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'nested-copy-index',
    source: 'function frames(error:Error){return[[error]].slice()[0]![0]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'triple-nested-index',
    source: 'function frames(error:Error){return[[[error]]][0]![0]![0]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'flat-map-nested-data-pin',
    source:
      'function frames(error:Error){return[0].flatMap(()=>[...[[{stack:"fixed"}]]])[0]![0]!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'nested-literal-data-pin',
    source: 'function frames(error:Error){return[[{stack:"fixed"},error]][0]![0]!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'nested-alias-data-pin',
    source:
      'function frames(error:Error){const rows=[[error],[{stack:"fixed"}]];return rows[1]![0]!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'nested-local-words-pin',
    source: 'function frames(error:Error){return[[new Error("fixed")]][0]![0]!.message;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'nested-out-of-range-pin',
    source: 'function frames(error:Error){return[[error]][0]![1]?.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'nested-typed-pin',
    source: 'function frames(error:Error,rows:Error[][]){return rows[0]![0]!.stack;}',
    invocation: 'frames(new Error("ours"),[[new Error("ours")]])',
    refused: true,
  },
];

describe('nested array index readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'nested-indexes.ts', source);
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

describe('shared nested array index admissions', () => {
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
