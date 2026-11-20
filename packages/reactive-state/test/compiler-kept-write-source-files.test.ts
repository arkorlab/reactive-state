import type { Node, SourceFile } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { keptMethodWrite, keptWrite } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const MODULE = 'kept-write-source-files.ts';

interface KeptCase {
  readonly id: string;
  /** The names the module holds that a walk of every node finds written, in the order met. */
  readonly kept: readonly string[];
  readonly source: string;
}

/**
 * A walk that asks `keptWrite` of every node of a module starts at the source file itself, which
 * writes nothing and has no parent: the answer there is none, and the walk goes on to the writes
 * the functions below it make.
 */
const KEPT_CASES: readonly KeptCase[] = [
  {
    id: 'a-function-writes-a-module-name',
    source: 'let count = 0;\nexport function bump(): number { count += 1; return count; }',
    kept: ['count'],
  },
  {
    id: 'a-method-of-a-module-held-object-writes-through-this',
    source:
      'const counter = { n: 0, bump(): void { this.n += 1; } };\nexport function run(): void { counter.bump(); }',
    kept: ['counter'],
  },
  {
    id: 'a-write-as-the-module-loads-is-none',
    source: 'let count = 0;\ncount += 1;\nexport const now = count;',
    kept: [],
  },
  {
    id: 'a-function-writes-its-own-name-only',
    source: 'export function next(start: number): number { let at = start; at += 1; return at; }',
    kept: [],
  },
  {
    id: 'an-empty-module',
    source: '',
    kept: [],
  },
];

describe('keptWrite asked of every node of a module, the source file first', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(KEPT_CASES)('$id', ({ kept, source }) => {
    using parsed = parseModule(api, MODULE, source);

    expect(keptWrite(parsed.sourceFile)).toBeUndefined();
    expect(keptMethodWrite(parsed.sourceFile)).toBeUndefined();
    expect(keptNamesIn(parsed.sourceFile)).toStrictEqual(kept);
  });
});

/** The names `keptWrite` and `keptMethodWrite` answer over `file` and every node below it. */
function keptNamesIn(file: SourceFile): readonly string[] {
  const names: string[] = [];
  const visit = (node: Node): void => {
    const name = keptWrite(node) ?? keptMethodWrite(node);
    if (name !== undefined) {
      names.push(name.text);
    }
    node.forEachChild(visit);
  };
  visit(file);
  return names;
}
