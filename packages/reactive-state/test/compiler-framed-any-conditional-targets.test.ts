import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Whole checked any operands retain native target and inference semantics before union comparison. */
const CASES = [
  {
    id: 'reported-number',
    source:
      'type Failure = (any | string) extends number ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-boolean',
    source:
      'type Failure = (any | string) extends boolean ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-null',
    source:
      'type Failure = (any | string) extends null ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-undefined',
    source:
      'type Failure = (any | string) extends undefined ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-bigint',
    source:
      'type Failure = (any | string) extends bigint ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-symbol',
    source:
      'type Failure = (any | string) extends symbol ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-object',
    source:
      'type Failure = (any | string) extends object ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-record',
    source:
      'type Failure = (any | string) extends { tag: string } ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-array',
    source:
      'type Failure = (any | string) extends number[] ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-tuple',
    source:
      'type Failure = (any | string) extends [number] ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-callable',
    source:
      'type Failure = (any | string) extends () => number ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-number-literal',
    source:
      'type Failure = (any | string) extends 3 ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-string-literal',
    source:
      'type Failure = (any | string) extends "fixed" ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-union',
    source:
      'type Failure = (any | string) extends number | boolean ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-string',
    source:
      'type Failure = (any | number) extends string ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'checked-alias-any',
    source:
      'type Open = any; type Failure = (Open | string) extends number ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'checked-actual-any',
    source:
      'type Mix<T> = T | string; type Failure = Mix<any> extends number ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-alias-default',
    source:
      'type Target<T = number> = T; type Failure = (any | string) extends Target ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'checked-conditional',
    source:
      'type Failure = (true extends true ? any | string : never) extends number ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'inferred-whole-any',
    source:
      'type Failure = (any | string) extends infer Item ? (Item extends number ? Error : { stack: string }) : never; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-unknown-union',
    source:
      'type Failure = (any | string) extends unknown | number ? { stack: string } : Error; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'target-any-data',
    source:
      'type Failure = (any | string) extends any ? { stack: string } : Error; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'target-unknown-data',
    source:
      'type Failure = (any | string) extends unknown ? { stack: string } : Error; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'target-never-prior-pin',
    source:
      'type Failure = (any | string) extends never ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'plain-any-prior-pin',
    source:
      'type Failure = any extends number ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'unknown-source-data',
    source:
      'type Failure = (unknown | string) extends number ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'flat-disjoint-intersection',
    source:
      'type Failure = ((any & string & number) | boolean) extends number ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'opaque-awaited-union',
    source:
      'type Thenable = { then(resolve: (value: string) => void): void }; type Failure = (Awaited<Thenable> | string) extends number ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'template-span-any-data',
    source: `type Failure = (\`\${any}\` | string) extends number ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }`,
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'recursive-shape-data',
    source:
      'type Cycle = { next: Cycle }; type Failure = (Cycle | string) extends number ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'generic-unknown-data',
    source:
      'type Select<T> = (T | string) extends number ? Error : { stack: string }; type Failure = Select<unknown>; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'target-any-error-pin',
    source:
      'type Failure = (any | string) extends any ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'target-unknown-error-pin',
    source:
      'type Failure = (any | string) extends unknown ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'opposite-branches-pin',
    source:
      'type Failure = (any | string) extends number ? { stack: string } : Error; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'any-unknown-union',
    source:
      'type Failure = (any | unknown) extends number ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'any-string-intersection',
    source:
      'type Failure = (any & string) extends number ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'both-argument-environments',
    source:
      'type Select<T, U> = (T | string) extends U ? Error : { stack: string }; type Failure = Select<any, number>; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
  {
    id: 'infer-target-any-data',
    source:
      'type Failure = (any | string) extends infer Item ? ([Item] extends [any] ? { stack: string } : Error) : never; function frames(value: Failure) { return value.stack; }',
    argument: '{ stack: "fixed" }',
    refused: false,
  },
  {
    id: 'intersection-union-target-string',
    source:
      'type Failure = ((any & string) | number) extends string ? Error : { stack: string }; function frames(value: Failure) { return value.stack; }',
    argument: 'new Error("ours")',
    refused: true,
  },
] as const;

describe('whole-any conditional target readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'whole-any-targets.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(refused);
  });
});

describe('shared helpers with whole-any target tests', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, argument, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(frames(${argument})).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const unsettled = compile(app).refusals.map((item) =>
      item.reason.includes('a shared module that answers otherwise'),
    );

    expect(unsettled).toStrictEqual(refused ? [true] : []);
  });
});

/** Stack observations are read through the original native compiler syntax tree. */
function readsFrames(root: Node): boolean {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
