import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native array logical writes and reduction carry preserve possible Error origins. */
const CASES = [
  {
    id: 'logical-null-alias',
    source:
      'function frames(error:Error){const NONE=null;const values:unknown[]=[NONE];values[0]??=error;return values.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'logical-null-chain',
    source:
      'function frames(error:Error){const NONE=null;const NEXT=NONE;const values:unknown[]=[NEXT];values[0]??=error;return values.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'logical-undefined-alias',
    source:
      'function frames(error:Error){const NONE=undefined;const values:unknown[]=[NONE];values[0]??=error;return values.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'logical-null-and-skips',
    source:
      'function frames(error:Error){const NONE=null;const values:unknown[]=[NONE];values[0]&&=error;return values.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'logical-present-nullish-skips',
    source:
      'function frames(error:Error){const FIXED="fixed";const values:unknown[]=[FIXED];values[0]??=error;return values.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'logical-opaque-alias',
    source:
      'function frames(error:Error,value:unknown){const initial=value;const values:unknown[]=[initial];values[0]??=error;return values.join();}',
    invocation: 'frames(new Error("ours"),null)',
    refused: true,
  },
  {
    id: 'reduce-middle-carried',
    source:
      'function frames(error:Error){return[{stack:"first"},error,{stack:"last"}].reduce((acc,cur,index)=>index===1?cur:acc).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reduce-right-middle-carried',
    source:
      'function frames(error:Error){return[{stack:"first"},error,{stack:"last"}].reduceRight((acc,cur,index)=>index===1?cur:acc).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reduce-initial-middle-carried',
    source:
      'function frames(error:Error){return[{stack:"first"},error,{stack:"last"}].reduce((acc,cur,index)=>index===1?cur:acc,{stack:"initial"}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reduce-constant-branch-data',
    source:
      'function frames(error:Error){return[{stack:"first"},error,{stack:"last"}].reduce((acc,cur)=>false?cur:acc).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'reduce-unconditional-last-data',
    source:
      'function frames(error:Error){return[error,{stack:"last"}].reduce((_acc,cur)=>cur).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'reduce-conditional-no-carry-data',
    source:
      'function frames(error:Error){return[{stack:"first"},error,{stack:"last"}].reduce((_acc,cur,index)=>index===1?cur:{stack:"fixed"}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'reduce-right-direct-data',
    source:
      'function frames(error:Error){return[{stack:"first"},error].reduceRight((_acc,cur)=>cur).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('array conditional source readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-rebinding.ts', source);
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

describe('array conditional source shared', () => {
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
