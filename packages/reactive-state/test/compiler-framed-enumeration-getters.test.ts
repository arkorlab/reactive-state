import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native enumeration runs each getter in turn, which may replace or delete what it reads later. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly refused: boolean;
}

const REPLACING =
  '{get first(){(this as {failure:Error|{stack:string}}).failure={stack:"fixed"};return{stack:"first"};},failure:error as Error|{stack:string}}';

const CASES: readonly Case[] = [
  {
    id: 'values-earlier-getter-replaces',
    source: `function frames(error:Error){return Object.values(${REPLACING})[1]!.stack;}`,
    refused: false,
  },
  {
    id: 'entries-earlier-getter-replaces',
    source: `function frames(error:Error){return Object.entries(${REPLACING})[1]![1]!.stack;}`,
    refused: false,
  },
  {
    id: 'values-earlier-getter-deletes',
    source:
      'function frames(error:Error){return(Object.values({get first(){delete (this as {failure?:unknown}).failure;return{stack:"first"};},failure:error as Error|{stack:string}})[1]as{stack?:string}|undefined)?.stack;}',
    refused: false,
  },
  {
    id: 'values-later-getter-rewrites',
    source:
      'function frames(error:Error){return(Object.values({failure:error,get later(){Object.assign(error,{stack:"fixed"});return 1;}})[0]as{stack?:string}).stack;}',
    refused: false,
  },
  {
    id: 'values-quiet-getter-pin',
    source:
      'function frames(error:Error){return(Object.values({get first(){return{stack:"first"};},failure:error})[1]as{stack?:string}).stack;}',
    refused: true,
  },
  {
    id: 'values-selected-quiet-getter-pin',
    source:
      'function frames(error:Error){return Object.values({get failure(){return error;}})[0]!.stack;}',
    refused: true,
  },
  {
    id: 'values-plain-fields-pin',
    source:
      'function frames(error:Error){return(Object.values({first:{stack:"first"},failure:error})[1]as{stack?:string}).stack;}',
    refused: true,
  },
];

describe('enumeration getter readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'enumeration-getters.ts', source);
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

describe('shared enumeration getter admissions', () => {
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
