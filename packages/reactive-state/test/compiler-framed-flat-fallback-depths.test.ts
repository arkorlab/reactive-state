import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A flat whose depth the compile cannot read keeps each depth that reads something different. That
 * holds for a depth an unresolved spread supplies, and also where a spread tuple's entries may have
 * changed since they were written, and where the argument list `apply` or `Reflect.apply` hands on
 * cannot be read: neither is the depth the first written entry names, or the default of one.
 */
const READ = '{stack?:string}';

const CASES = [
  {
    id: 'spread-tuple-written-before',
    source: `function frames(error:Error){const depth:number[]=[1];depth[0]=0;return (([[1,2],error] as unknown[]).flat(...depth)[1] as ${READ}).stack;}`,
    refused: true,
  },
  {
    id: 'spread-tuple-changed-by-a-call',
    source: `function change(list:number[]){list[0]=0;}function frames(error:Error){const depth:number[]=[1];change(depth);return (([[1,2],error] as unknown[]).flat(...depth)[1] as ${READ}).stack;}`,
    refused: true,
  },
  {
    id: 'spread-tuple-written-before-to-the-deeper-depth',
    source: `function frames(error:Error){const depth:number[]=[0];depth[0]=1;return (([[1,2],error] as unknown[]).flat(...depth)[1] as ${READ}).stack;}`,
    refused: true,
  },
  {
    id: 'spread-parameter-list',
    source: `function frames(error:Error,depth:number[]){return (([[1,2],error] as unknown[]).flat(...depth)[1] as ${READ}).stack;}`,
    refused: true,
  },
  {
    id: 'apply-parameter-list',
    source: `function frames(error:Error,list:number[]){return ((Array.prototype.flat.apply([[1,2],error] as unknown[],list as never) as unknown[])[1] as ${READ}).stack;}`,
    refused: true,
  },
  {
    id: 'reflect-apply-parameter-list',
    source: `function frames(error:Error,list:number[]){return ((Reflect.apply(Array.prototype.flat,[[1,2],error] as unknown[],list) as unknown[])[1] as ${READ}).stack;}`,
    refused: true,
  },
  {
    id: 'apply-list-written-before',
    source: `function frames(error:Error){const list:number[]=[1];list[0]=0;return ((Array.prototype.flat.apply([[1,2],error] as unknown[],list as never) as unknown[])[1] as ${READ}).stack;}`,
    refused: true,
  },
  {
    id: 'apply-literal-list-of-zero',
    source: `function frames(error:Error){return ((Array.prototype.flat.apply([[1,2],error] as unknown[],[0] as never) as unknown[])[1] as ${READ}).stack;}`,
    refused: true,
  },
  {
    id: 'spread-tuple-unchanged-data',
    source: `function frames(error:Error){const depth:[number]=[1];return (([[1,2],error] as unknown[]).flat(...depth)[1] as ${READ}).stack;}`,
    refused: false,
  },
  {
    id: 'apply-literal-list-of-one-data',
    source: `function frames(error:Error){return ((Array.prototype.flat.apply([[1,2],error] as unknown[],[1] as never) as unknown[])[1] as ${READ}).stack;}`,
    refused: false,
  },
  {
    id: 'written-depth-one-data',
    source: `function frames(error:Error){return (([[1,2],error] as unknown[]).flat(1)[1] as ${READ}).stack;}`,
    refused: false,
  },
  {
    id: 'spread-tuple-written-before-no-error-data',
    source: `function frames(error:Error){void error;const depth:number[]=[1];depth[0]=0;return (([[1,2],[3]] as unknown[]).flat(...depth)[1] as ${READ}).stack;}`,
    refused: false,
  },
  {
    id: 'apply-parameter-list-no-error-data',
    source: `function frames(error:Error,list:number[]){void error;return ((Array.prototype.flat.apply([[1,2],[3]] as unknown[],list as never) as unknown[])[1] as ${READ}).stack;}`,
    refused: false,
  },
] as const;

describe('flat depths that no written argument holds', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, refused }) => {
    const invocation = source.includes('frames(error:Error,')
      ? "frames(new Error('ours'),[])"
      : "frames(new Error('ours'))";
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

  it.each(CASES)('reads $id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'flat-fallback-depths.ts', source);
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
