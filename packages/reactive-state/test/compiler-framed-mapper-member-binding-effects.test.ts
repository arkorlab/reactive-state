import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source-known native array results and writes preserve selected error identities. */
const CASES = [
  {
    id: 'unused-pattern-getter-rewrites-stack',
    source:
      'function frames(error:Error){const holder={box:{failure:error},get other(){Object.assign(error,{stack:"fixed"});return 0;}};return([holder].map(({box,other}:{box:{failure:unknown};other:number})=>box.failure)[0]as{stack?:string}).stack;}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-pattern-default-getter-rewrites-stack',
    source:
      'function frames(error:Error){const fallback={get word(){Object.assign(error,{stack:"fixed"});return 0;}};return([{box:{failure:error}}].map(({box,other:{word}=fallback}:{box:{failure:unknown};other?:{word:number}})=>box.failure)[0]as{stack?:string}).stack;}',
    refused: false,
    reader: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unused-pattern-present-data-keeps-error',
    source:
      'function frames(error:Error){return([{box:{failure:error},other:0}].map(({box,other}:{box:{failure:unknown};other:number})=>box.failure)[0]as{stack?:string}).stack;}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unused-unread-getter-keeps-error',
    source:
      'function frames(error:Error){const holder={failure:error,get other(){Object.assign(error,{stack:"fixed"});return 0;}};return([holder].map((value:{failure:unknown})=>value.failure)[0]as{stack?:string}).stack;}',
    refused: true,
    reader: true,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('mapper input binding effects readers', () => {
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

describe('mapper input binding effects shared', () => {
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
