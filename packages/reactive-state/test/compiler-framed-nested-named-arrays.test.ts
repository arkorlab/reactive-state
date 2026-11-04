import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A nested read through a named inner array reads that array's own elements and writes. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly refused: boolean;
}

const INNER = 'const inner:{stack?:string}[]=[{stack:"fixed"}];';

const CASES: readonly Case[] = [
  {
    id: 'named-inner-write',
    source: `function frames(error:Error){${INNER}const rows=[inner];inner[0]=error;return rows[0]![0]!.stack;}`,
    refused: true,
  },
  {
    id: 'named-inner-push',
    source: `function frames(error:Error){${INNER}const rows=[inner];inner.push(error);return rows[0]![1]!.stack;}`,
    refused: true,
  },
  {
    id: 'named-inner-initializer',
    source:
      'function frames(error:Error){const inner=[error];const rows=[inner];return rows[0]![0]!.stack;}',
    refused: true,
  },
  {
    id: 'named-inner-copy-shares-array',
    source: `function frames(error:Error){${INNER}const rows=[inner].slice();inner[0]=error;return rows[0]![0]!.stack;}`,
    refused: true,
  },
  {
    id: 'named-inner-data-pin',
    source: `function frames(error:Error){${INNER}const rows=[inner];return rows[0]![0]!.stack;}`,
    refused: false,
  },
  {
    id: 'named-inner-other-index-pin',
    source: `function frames(error:Error){${INNER}const rows=[inner];inner[1]=error;return rows[0]![0]!.stack;}`,
    refused: false,
  },
  {
    id: 'named-inner-later-write-pin',
    source: `function frames(error:Error){${INNER}const rows=[inner];const stack=rows[0]![0]!.stack;inner[0]=error;return stack;}`,
    refused: false,
  },
];

describe('nested named array readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'nested-named.ts', source);
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

describe('shared nested named array admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
