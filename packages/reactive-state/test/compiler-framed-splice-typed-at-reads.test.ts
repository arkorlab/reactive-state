import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A typed splice receiver keeps its element type, and a native at reads a fresh result immediately. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const OURS = 'frames(new Error("ours"))';
const TYPED = 'frames(new Error("ours"),[new Error("ours")])';

const CASES: readonly Case[] = [
  {
    id: 'splice-typed-receiver',
    source: 'function frames(error:Error,values:Error[]){return values.splice(0,1)[0]!.stack;}',
    invocation: TYPED,
    refused: true,
  },
  {
    id: 'splice-typed-saved-result',
    source:
      'function frames(error:Error,values:Error[]){const removed=values.splice(0,1);return removed[0]!.stack;}',
    invocation: TYPED,
    refused: true,
  },
  {
    id: 'splice-typed-variable',
    source:
      'function frames(error:Error,others:Error[]){const values:Error[]=others;return values.splice(0,1)[0]!.stack;}',
    invocation: TYPED,
    refused: true,
  },
  {
    id: 'splice-at-read',
    source: 'function frames(error:Error){return[error].splice(0,1).at(0)!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'filter-async-at-read',
    source: 'function frames(error:Error){return[error].filter(async()=>false).at(0)!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'filter-hole-at-read',
    source: 'function frames(error:Error){return[,error].filter(()=>true).at(0)!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'splice-typed-data-pin',
    source:
      'function frames(error:Error,values:{stack:string}[]){return values.splice(0,1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"),[{stack:"fixed"}])',
    refused: false,
  },
  {
    id: 'splice-changed-literal-pin',
    source:
      'function frames(error:Error){const input:{stack?:string}[]=[error];input[0]={stack:"fixed"};return input.splice(0,1)[0]!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'splice-saved-literal-pin',
    source:
      'function frames(error:Error){const removed=[error].splice(0,1);Object.assign(error,{stack:"fixed"});return removed[0]!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'splice-at-other-index-pin',
    source:
      'function frames(error:Error){return([error,{stack:"fixed"}]as{stack?:string}[]).splice(0,2).at(1)!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'filter-hole-at-data-pin',
    source:
      'function frames(error:Error){return([,{stack:"fixed"},error]as{stack?:string}[]).filter(()=>true).at(0)!.stack;}',
    invocation: OURS,
    refused: false,
  },
];

describe('typed splice and at reads', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'splice-typed.ts', source);
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

describe('shared typed splice and at admissions', () => {
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
