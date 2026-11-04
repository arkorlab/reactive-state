import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A Map or WeakMap set that a get evaluates in its own argument runs before the get reads. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly refused: boolean;
}

const WEAK =
  'const key={};const weak=new WeakMap<object,{stack?:string}>([[key,{stack:"fixed"}]]);';
const MAP = 'const map=new Map<number,{stack?:string}>([[1,{stack:"fixed"}]]);';

const CASES: readonly Case[] = [
  {
    id: 'weak-map-set-in-get-argument',
    source: `function frames(error:Error){${WEAK}return weak.get((weak.set(key,error),key))!.stack;}`,
    refused: true,
  },
  {
    id: 'empty-weak-map-set-in-get-argument',
    source:
      'function frames(error:Error){const key={};const weak=new WeakMap<object,{stack?:string}>();return weak.get((weak.set(key,error),key))!.stack;}',
    refused: true,
  },
  {
    id: 'map-set-in-get-argument-pin',
    source: `function frames(error:Error){${MAP}return map.get((map.set(1,error),1))!.stack;}`,
    refused: true,
  },
  {
    id: 'map-get-replaced-in-argument-pin',
    source:
      'function frames(error:Error){const map=new Map<number,{stack?:string}>([[1,error]]);return map.get(((map as {get:unknown}).get=()=>({stack:"fixed"}),1))!.stack;}',
    refused: true,
  },
  {
    id: 'weak-map-other-key-set-pin',
    source: `function frames(error:Error){${WEAK}const other={};return weak.get((weak.set(other,error),key))!.stack;}`,
    refused: false,
  },
  {
    id: 'weak-map-later-set-pin',
    source: `function frames(error:Error){${WEAK}const value=weak.get(key)!;weak.set(key,error);return value.stack;}`,
    refused: false,
  },
];

describe('map argument write readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'map-argument-writes.ts', source);
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

describe('shared map argument write admissions', () => {
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
