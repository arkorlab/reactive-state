import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    group: 'copy',
    id: 'slice-first-error',
    source: 'function frames(error:Error){return [error].slice()[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'copy',
    id: 'concat-inserted-error',
    source:
      'function frames(error:Error){return [{stack:"fixed"}].concat(error as any)[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'copy',
    id: 'filter-retained-error',
    source: 'function frames(error:Error){return [error].filter(()=>true)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'copy',
    id: 'reversed-selected-error',
    source: 'function frames(error:Error){return [error,{stack:"fixed"}].toReversed()[1]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'copy',
    id: 'with-selected-error',
    source:
      'function frames(error:Error){return [{stack:"fixed"}].with(0,error as any)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'copy',
    id: 'slice-excludes-error',
    source: 'function frames(error:Error){return [error,{stack:"fixed"}].slice(1)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'copy',
    id: 'filter-excludes-all',
    source:
      'function frames(error:Error){return ([error].filter(()=>false)[0]??{stack:"fixed"}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'copy',
    id: 'slice-own-data',
    source:
      'function frames(error:Error){const values=[error];values.slice=()=>[{stack:"fixed"}as any];return values.slice()[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'copy',
    id: 'slice-local-words',
    source: 'function frames(){return [new Error("fixed")].slice()[0]!.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    group: 'copy',
    id: 'slice-copy-before-original-write',
    source:
      'function frames(error:Error){const source:any[]=[{stack:"fixed"}];const values=source.slice();source[0]=error;return values[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'copy',
    id: 'slice-empty-after-rebind',
    source:
      'function frames(error:Error){let source:any[]=[];source=[error];return(source.slice(0,0)[0]??{stack:"fixed"}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'copy',
    id: 'reverse-out-of-range',
    source: 'function frames(error:Error){return([error].toReversed()[1]??{stack:"fixed"}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('native array copy readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-copy.ts', source);
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

describe('native array copy shared', () => {
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
