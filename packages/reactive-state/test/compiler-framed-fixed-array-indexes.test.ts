import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Fixed canonical numeric positions select their Error elements without widening other fields. */
const CASES = [
  {
    id: 'literal-first-error',
    source: 'function frames(error:Error){return [error][0]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'literal-second-error',
    source: 'function frames(error:Error){return [{message:"fixed"},error][1]!.message;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'initializer-only-alias',
    source: 'function frames(error:Error){const values=[error];return values[0]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'numeric-string-index',
    source: 'function frames(error:Error){return [error]["0"]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'constant-index',
    source: 'function frames(error:Error){const index=0;return [error][index]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-made-frames',
    source: 'function frames(){return [new Error("fixed")][0]!.stack;}',
    refused: true,
    invocation: 'frames()',
  },
  {
    id: 'spread-literal-error',
    source: 'function frames(error:Error){return [...[error]][0]!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'asserted-selected-error',
    source: 'function frames(error:unknown){return ([error][0] as Error).message;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ordinary-selected-data',
    source: 'function frames(error:Error){return [{stack:"fixed"},error][0]!.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ordinary-alias-data',
    source: 'function frames(){const values=[{stack:"fixed"}];return values[0]!.stack;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'local-made-words',
    source: 'function frames(){return [new Error("fixed")][0]!.message;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'nested-array-data',
    source: 'function frames(error:Error){return [[error]][0]!.length;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'known-nonindex-property',
    source: 'function frames(error:Error){return [error].length;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'noncanonical-numeric-string',
    source:
      'function frames(error:Error){return ([error] as unknown as Record<string,{stack:string}>)["01"]?.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'negative-index',
    source: 'function frames(error:Error){return [error][-1]?.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-error-shadow',
    source: 'class Error{stack="fixed"}function frames(){return [new Error()][0]!.stack;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'opaque-asserted-error',
    source:
      'function frames(error:unknown){return ([new Error("fixed"),error][1] as Error).message;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('fixed array error readers', () => {
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

describe('shared fixed array errors', () => {
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
