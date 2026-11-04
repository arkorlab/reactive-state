import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native Array.with reads its index and replacement after argument spreads expand. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const ONE = '([{stack:"fixed"}]as{stack?:string}[])';
const TWO = '([{stack:"fixed"},{stack:"fixed"}]as{stack?:string}[])';
const OURS = 'frames(new Error("ours"))';

const CASES: readonly Case[] = [
  {
    id: 'with-spread-review',
    source: `function frames(error:Error){return ${ONE}.with(...([0,error]as const))[0]!.stack;}`,
    invocation: OURS,
    refused: true,
  },
  {
    id: 'with-replacement-spread',
    source: `function frames(error:Error){return ${ONE}.with(0,...[error])[0]!.stack;}`,
    invocation: OURS,
    refused: true,
  },
  {
    id: 'with-negative-spread',
    source: `function frames(error:Error){return ${ONE}.with(...([-1,error]as const))[0]!.stack;}`,
    invocation: OURS,
    refused: true,
  },
  {
    id: 'with-spread-alias',
    source: `function frames(error:Error){const args=[0,error]as const;return ${ONE}.with(...args)[0]!.stack;}`,
    invocation: OURS,
    refused: true,
  },
  {
    id: 'with-borrowed-call-spread',
    source:
      'function frames(error:Error){return(Array.prototype.with.call([{stack:"fixed"}],...([0,error]as const))as{stack?:string}[])[0]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'with-unresolved-spread',
    source: `function frames(error:Error,args:[number,Error]){return ${ONE}.with(...args)[0]!.stack;}`,
    invocation: 'frames(new Error("ours"),[0,new Error("ours")])',
    refused: true,
  },
  {
    id: 'with-spread-other-index-pin',
    source: `function frames(error:Error){return ${TWO}.with(...([1,error]as const))[0]!.stack;}`,
    invocation: OURS,
    refused: false,
  },
  {
    id: 'with-spread-data-pin',
    source: `function frames(error:Error){return ${ONE}.with(...([0,{stack:"other"}]as const))[0]!.stack;}`,
    invocation: OURS,
    refused: false,
  },
  {
    id: 'with-spread-local-words-pin',
    source:
      'function frames(error:Error){return([{message:"fixed"}]as{message?:string}[]).with(...([0,new Error("fixed")]as const))[0]!.message;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'with-unresolved-data-pin',
    source: `function frames(error:Error,args:[number,{stack:string}]){return ${ONE}.with(...args)[0]!.stack;}`,
    invocation: 'frames(new Error("ours"),[0,{stack:"other"}])',
    refused: false,
  },
  {
    id: 'with-unresolved-source-error-pin',
    source:
      'function frames(error:Error,args:[number,{stack:string}]){return[error].with(...args)[0]!.stack;}',
    invocation: 'frames(new Error("ours"),[1,{stack:"other"}])',
    refused: true,
  },
];

describe('array.with spread argument readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'with-spreads.ts', source);
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

describe('shared Array.with spread argument admissions', () => {
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
