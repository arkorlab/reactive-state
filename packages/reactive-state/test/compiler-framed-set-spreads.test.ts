import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A native Set spread into an immediately indexed array literal yields its finite source values. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const OURS = 'frames(new Error("ours"))';

const CASES: readonly Case[] = [
  {
    id: 'set-spread-review',
    source: 'function frames(error:Error){return[...new Set([error])][0]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'set-spread-message',
    source: 'function frames(error:Error){return[...new Set([error])][0]!.message;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'set-spread-offset',
    source: 'function frames(error:Error){return[{stack:"fixed"},...new Set([error])][1]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'set-spread-second-value',
    source: 'function frames(error:Error){return[...new Set([{stack:"fixed"},error])][1]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'set-spread-repeated-value',
    source:
      'function frames(error:Error){return[...new Set([{stack:"fixed"},error,error])][1]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'set-spread-alias',
    source:
      'function frames(error:Error){const values=new Set([error]);return[...values][0]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'set-spread-input-alias',
    source:
      'function frames(error:Error){const input=[error];return[...new Set(input)][0]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'set-spread-add-chain',
    source:
      'function frames(error:Error){return[...new Set<{stack?:string}>().add(error)][0]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'set-spread-fresh-error-frames',
    source: 'function frames(error:Error){return[...new Set([new Error("fixed")])][0]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'set-spread-uncertain-identity',
    source:
      'function frames(error:Error,other:Error){return[...new Set([error,other])][1]!.stack;}',
    invocation: 'frames(new Error("ours"),new Error("other"))',
    refused: true,
  },
  {
    id: 'set-spread-data-pin',
    source: 'function frames(error:Error){return[...new Set([{stack:"fixed"}])][0]!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'set-spread-other-value-pin',
    source: 'function frames(error:Error){return[...new Set([{stack:"fixed"},error])][0]!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'set-spread-before-offset-pin',
    source: 'function frames(error:Error){return[{stack:"fixed"},...new Set([error])][0]!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'set-spread-out-of-range-pin',
    source: 'function frames(error:Error){return[...new Set([error])][1]?.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'set-spread-local-words-pin',
    source: 'function frames(error:Error){return[...new Set([new Error("fixed")])][0]!.message;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'set-spread-saved-result-pin',
    source:
      'function frames(error:Error){const values=[...new Set([error])];Object.assign(error,{stack:"fixed"});return values[0]!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'set-spread-later-element-pin',
    source:
      'function frames(error:Error){return[...new Set([error]),Object.assign(error,{stack:"fixed"})][0]!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'set-spread-prior-write-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return[...new Set([error])][0]!.stack;}',
    invocation: OURS,
    refused: false,
  },
];

describe('set spread readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'set-spreads.ts', source);
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

describe('shared Set spread admissions', () => {
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
