import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    group: 'reduce',
    id: 'reduce-sole-error',
    source: 'function frames(error:Error){return [error].reduce(value=>value).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'reduce',
    id: 'reduce-right-sole-error',
    source: 'function frames(error:Error){return [error].reduceRight(value=>value).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'reduce',
    id: 'reduce-initial-empty',
    source: 'function frames(error:Error){return ([]as unknown[]).reduce(()=>({}),error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'reduce',
    id: 'reduce-callback-error',
    source: 'function frames(error:Error){return [0,1].reduce(()=>error,0as any).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'reduce',
    id: 'reduce-borrowed-call',
    source:
      'function frames(error:Error){return Array.prototype.reduce.call([error],(value:any)=>value).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'reduce',
    id: 'reduce-typed-input',
    source: 'function frames(values:Error[]){return values.reduce(value=>value).stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    group: 'reduce',
    id: 'reduce-callback-data',
    source:
      'function frames(error:Error){return [error].reduce(()=>({stack:"fixed"}),{stack:"initial"}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'reduce',
    id: 'reduce-own-data',
    source:
      'function frames(error:Error){const values=[error];values.reduce=()=>({stack:"fixed"}as any);return values.reduce(()=>error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'reduce',
    id: 'reduce-local-words',
    source: 'function frames(){return [new Error("fixed")].reduce(value=>value).message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    group: 'reduce',
    id: 'reduce-data-empty',
    source:
      'function frames(error:Error){return ([]as unknown[]).reduce(()=>error,{stack:"fixed"}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'reduce',
    id: 'reduce-local-callback-frames',
    source: 'function frames(){return [0].reduce(()=>new Error("fixed"),{}as any).stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    group: 'reduce',
    id: 'reduce-right-current-data',
    source:
      'function frames(error:Error){return [{stack:"fixed"},error].reduceRight((_acc,current)=>current).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native array reduce readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-reduce.ts', source);
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

describe('native array reduce shared', () => {
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
