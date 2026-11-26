import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Only the native operation's consumed values expose supplied Error words. */
const CASES = [
  {
    id: 'factory-member-error',
    source:
      'function box(value:Error){return {failure:value};}function frames(error:Error){return box(error).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'factory-generic-member-error',
    source:
      'function box<T>(value:T){return {failure:value};}function frames(error:Error){return box(error).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'factory-nested-member-error',
    source:
      'function box<T>(value:T){return {detail:{failure:value}};}function frames(error:Error){return box(error).detail.failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'factory-array-member-error',
    source:
      'function box<T>(value:T){return [value] as const;}function frames(error:Error){return box(error)[0].stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'factory-destructured-member-error',
    source:
      'function box<T>(value:T){return {failure:value};}function frames(error:Error){const {failure}=box(error);return failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'factory-member-fixed-data',
    source:
      'function box(value:unknown){return {failure:{stack:"fixed"}};}function frames(error:Error){return box(error).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'factory-unselected-error-member',
    source:
      'function box(value:Error){return {failure:value,data:{stack:"fixed"}};}function frames(error:Error){return box(error).data.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'factory-local-error-member-words',
    source:
      'function box(value:Error){return {failure:value};}function frames(){return box(new Error("fixed")).failure.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'factory-local-literal-alias',
    source:
      'function box(value:unknown){const result={failure:{stack:"fixed"}};return result;}function frames(error:Error){return box(error).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'factory-member-own-name-shadow',
    source:
      'function frames(error:Error){const box=(_value:unknown)=>({failure:{stack:"fixed"}});return box(error).failure.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('local factory member results readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'blob-parts.ts', source);
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

describe('shared local factory member results', () => {
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
