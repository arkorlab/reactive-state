import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'literal-object-asserted-Error',
    source:
      'function frames(){return ({name:"Error",message:"fixed",stack:"fixed"} as Error).stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'literal-message-asserted-Error',
    source:
      'function frames(){return ({name:"Error",message:"fixed",stack:"fixed"} as Error).message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'opaque-asserted-Error',
    source: 'function frames(value:unknown){return (value as Error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-Error-asserted-data',
    source: 'function frames(){return (new Error("ours") as unknown as {stack:string}).stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'prototype-Error-assertion',
    source: 'function frames(error:Error){return ({__proto__:error} as Error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'getter-Error-assertion',
    source:
      'function frames(error:Error){return ({get stack(){return error.stack;}} as Error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('asserted-data readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'recursive-error-members.ts', source);
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

describe('shared asserted-data', () => {
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
