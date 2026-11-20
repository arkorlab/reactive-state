import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isFunctionDeclaration, isVariableStatement, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Modules } from '../src/compiler/modules.ts';
import { Reach, untrackedIn } from '../src/compiler/reach.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * What a part reads outside the functions it holds (`untrackedIn` and `Reach.keptIn` with
 * `outsideFunctions`): a function called where it is written runs there, as a part renders, and is
 * read as the code around it; one that is handed on, held or returned runs when it is called.
 */

interface Row {
  readonly id: string;
  readonly source: string;
}

/** Each is called where it is written, and reads the clock as it runs. */
const IN_PLACE: readonly Row[] = [
  { id: 'arrow', source: 'const stamp = (() => Date.now())();' },
  { id: 'arrow-with-a-block', source: 'const stamp = (() => { return Date.now(); })();' },
  { id: 'function-expression', source: 'const stamp = (function () { return Date.now(); })();' },
  {
    id: 'call-inside-the-parentheses',
    source: 'const stamp = (function () { return Date.now(); }());',
  },
  { id: 'async-arrow', source: 'const stamp = (async () => Date.now())();' },
  { id: 'doubly-parenthesized', source: 'const stamp = ((() => Date.now()))();' },
  { id: 'default-parameter', source: 'const stamp = ((at = Date.now()) => at)();' },
  { id: 'cast-result', source: 'const stamp = (() => Date.now())() as number;' },
  { id: 'invoked-in-an-expression', source: 'const label = "at " + (() => Date.now())();' },
  {
    id: 'within-an-object-literal',
    source: 'const holder = { stamp: (() => Date.now())() };',
  },
];

/** Each runs when it is called, not where it stands, and is skipped as before. */
const DEFERRED: readonly Row[] = [
  { id: 'arrow-held', source: 'const read = () => Date.now();' },
  { id: 'function-held', source: 'const read = function () { return Date.now(); };' },
  { id: 'handler-property', source: 'const holder = { onClick: () => Date.now() };' },
  { id: 'returned-from-an-invoked-function', source: 'const read = (() => () => Date.now())();' },
  {
    id: 'inner-of-an-invoked-function',
    source: 'const read = (() => { const inner = () => Date.now(); return inner; })();',
  },
  {
    id: 'handed-to-a-call',
    source: 'const register = (run: () => number): number => 1;\nregister(() => Date.now());',
  },
  { id: 'bound-then-called', source: 'const stamp = (() => Date.now()).call(undefined);' },
  {
    id: 'argument-of-an-invoked-function',
    source: 'const stamp = ((run: () => number) => 1)(() => Date.now());',
  },
];

/** Each writes what the module holds as it runs, where it is called. */
const KEPT_IN_PLACE: readonly Row[] = [
  {
    id: 'arrow',
    source: 'let n = 0;\nexport function C() { const x = (() => n++)(); return x; }',
  },
  {
    id: 'function-expression',
    source:
      'let n = 0;\nexport function C() { const x = (function () { return n++; })(); return x; }',
  },
];

const KEPT_DEFERRED: readonly Row[] = [
  {
    id: 'arrow-held',
    source: 'let n = 0;\nexport function C() { const x = () => n++; return x; }',
  },
  {
    id: 'returned-from-an-invoked-function',
    source: 'let n = 0;\nexport function C() { const x = (() => () => n++)(); return x; }',
  },
];

describe('what a part reads outside the functions it holds, of a function called where it is written', () => {
  let api: API;
  const roots: string[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await Promise.all(roots.map(async (root) => rm(root, { force: true, recursive: true })));
  });

  function untracked(source: string, outsideFunctions: boolean): string | undefined {
    using file = parseModule(api, 'x.ts', source);
    return untrackedIn([file.sourceFile], outsideFunctions);
  }

  /** What `Reach.keptIn` finds in the constants of the one function `C` the source declares. */
  async function kept(source: string, outsideFunctions: boolean): Promise<string | undefined> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reactive-state-reach-place-'));
    roots.push(root);
    await mkdir(root, { recursive: true });
    const file = path.join(root, 'x.ts');
    await writeFile(file, source);
    using modules = new Modules(api, root);
    const reach = new Reach(modules, undefined);
    const { sourceFile } = modules.parse(file, false);
    const declared = sourceFile.statements.find((statement) => isFunctionDeclaration(statement));
    const constants: Node[] = [];
    if (declared !== undefined && isFunctionDeclaration(declared)) {
      declared.body?.forEachChild((statement) => {
        if (isVariableStatement(statement)) {
          constants.push(statement);
        }
      });
    }
    return reach.keptIn(constants, outsideFunctions);
  }

  it.each(IN_PLACE)('reads a function called where it is written: $id', ({ source }) => {
    expect(untracked(source, true)).toBe('Date');
    expect(untracked(source, false)).toBe('Date');
  });

  it.each(DEFERRED)('leaves a function that runs when it is called: $id', ({ source }) => {
    expect(untracked(source, true)).toBeUndefined();
    expect(untracked(source, false)).toBe('Date');
  });

  it.each(KEPT_IN_PLACE)(
    'finds a write of a function called where it is written: $id',
    async ({ source }) => {
      await expect(kept(source, true)).resolves.toBe('n');
      await expect(kept(source, false)).resolves.toBe('n');
    },
  );

  it.each(KEPT_DEFERRED)('leaves a write that runs when it is called: $id', async ({ source }) => {
    await expect(kept(source, true)).resolves.toBeUndefined();
    await expect(kept(source, false)).resolves.toBe('n');
  });
});
