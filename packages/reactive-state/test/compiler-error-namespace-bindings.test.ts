import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Namespace value bindings stop outer lookup even where the shared syntax gate already refuses. */
const CASES = [
  {
    id: 'namespace-const-error',
    source:
      'namespace Frames{const failure=new Error("ours");export function read(){return failure.stack;}}',
    invocation: 'Frames.read()',
    readerRefused: true,
  },
  {
    id: 'namespace-let-error',
    source:
      'namespace Frames{let failure:Error=new Error("ours");export function read(){return failure.stack;}}',
    invocation: 'Frames.read()',
    readerRefused: true,
  },
  {
    id: 'namespace-local-error-class',
    source:
      'namespace Frames{class Failure extends Error{}const failure=new Failure();export function read(){return failure.stack;}}',
    invocation: 'Frames.read()',
    readerRefused: true,
  },
  {
    id: 'namespace-const-data-shadows-error',
    source:
      'const failure=new Error("ours");namespace Frames{const failure={stack:"fixed"};export function read(){return failure.stack;}}',
    invocation: 'Frames.read()',
    readerRefused: false,
  },
  {
    id: 'namespace-let-data-shadows-error',
    source:
      'const failure=new Error("ours");namespace Frames{let failure={stack:"fixed"};export function read(){return failure.stack;}}',
    invocation: 'Frames.read()',
    readerRefused: false,
  },
  {
    id: 'namespace-class-data-shadows-error',
    source:
      'const failure=new Error("ours");namespace Frames{class failure{static stack="fixed";}export function read(){return failure.stack;}}',
    invocation: 'Frames.read()',
    readerRefused: false,
  },
  {
    id: 'namespace-ordinary-data',
    source:
      'namespace Frames{const failure={stack:"fixed"};export function read(){return failure.stack;}}',
    invocation: 'Frames.read()',
    readerRefused: false,
  },
  {
    id: 'namespace-nested-error-shadows-data',
    source:
      'namespace Frames{const failure={stack:"fixed"};export namespace Nested{const failure=new Error("ours");export function read(){return failure.stack;}}}',
    invocation: 'Frames.Nested.read()',
    readerRefused: true,
  },
] as const;

describe('namespace error binding readers', () => {
  it.each(CASES)('$id', ({ source, readerRefused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'namespace-binding.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(readerRefused);
  });
});

describe('shared namespace syntax remains refused', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);

    expect(reasons).toStrictEqual([
      expect.stringContaining('a shared module that answers otherwise'),
    ]);
  });
});
