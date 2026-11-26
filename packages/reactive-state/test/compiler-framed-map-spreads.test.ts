import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A native Map spread yields one entry per distinct key, holding the last value written for it. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'map-spread-value',
    source: 'function frames(error:Error){return[...new Map([[1,error]])][0]![1]!.stack;}',
    refused: true,
  },
  {
    id: 'map-spread-value-words',
    source: 'function frames(error:Error){return[...new Map([[1,error]])][0]![1]!.message;}',
    refused: true,
  },
  {
    id: 'map-spread-key',
    source: 'function frames(error:Error){return[...new Map([[error,1]])][0]![0]!.stack;}',
    refused: true,
  },
  {
    id: 'map-spread-second-entry',
    source:
      'function frames(error:Error){return[...new Map([[1,{stack:"fixed"}],[2,error]])][1]![1]!.stack;}',
    refused: true,
  },
  {
    id: 'map-spread-overwritten-value',
    source:
      'function frames(error:Error){return[...new Map([[1,{stack:"fixed"}],[1,error]])][0]![1]!.stack;}',
    refused: true,
  },
  {
    id: 'map-spread-offset',
    source:
      'function frames(error:Error){return[{stack:"fixed"},...new Map([[1,error]])][1]![1]!.stack;}',
    refused: true,
  },
  {
    id: 'map-spread-map-alias',
    source:
      'function frames(error:Error){const entries=new Map([[1,error]]);return[...entries][0]![1]!.stack;}',
    refused: true,
  },
  {
    id: 'map-spread-input-alias',
    source:
      'function frames(error:Error){const input:[number,Error][]=[[1,error]];return[...new Map(input)][0]![1]!.stack;}',
    refused: true,
  },
  {
    id: 'map-spread-data-pin',
    source:
      'function frames(error:Error){return[...new Map([[1,{stack:"fixed"}]])][0]![1]!.stack;}',
    refused: false,
  },
  {
    id: 'map-spread-overwritten-error-pin',
    source:
      'function frames(error:Error){return[...new Map<number,{stack?:string}>([[1,error],[1,{stack:"fixed"}]])][0]![1]!.stack;}',
    refused: false,
  },
  {
    id: 'map-spread-other-entry-pin',
    source:
      'function frames(error:Error){return[...new Map<number,{stack?:string}>([[1,error],[2,{stack:"fixed"}]])][1]![1]!.stack;}',
    refused: false,
  },
  {
    id: 'map-spread-data-key-pin',
    source:
      'function frames(error:Error){return[...new Map<{stack?:string},Error>([[{stack:"fixed"},error]])][0]![0]!.stack;}',
    refused: false,
  },
  {
    id: 'map-spread-whole-entry-pin',
    source:
      'function frames(error:Error){return([...new Map([[1,error]])][0]as unknown as{stack?:string}).stack;}',
    refused: false,
  },
  {
    id: 'map-spread-local-words-pin',
    source:
      'function frames(error:Error){return[...new Map([[1,new Error("fixed")]])][0]![1]!.message;}',
    refused: false,
  },
  {
    id: 'map-spread-prior-write-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return[...new Map([[1,error]])][0]![1]!.stack;}',
    refused: false,
  },
  {
    id: 'map-spread-saved-literal-pin',
    source:
      'function frames(error:Error){const entries=[...new Map([[1,error]])];Object.assign(error,{stack:"fixed"});return entries[0]![1]!.stack;}',
    refused: false,
  },
];

describe('native Map spread readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'map-spreads.ts', source);
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

describe('shared native Map spread admissions', () => {
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
