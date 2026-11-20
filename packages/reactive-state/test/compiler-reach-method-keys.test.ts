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
 * `outsideFunctions`): the computed key of a method or an accessor, and the arguments of a decorator,
 * run as the object or the class is made; only its parameters and its body run when it is called.
 */

const DEC = 'const dec = (...given: unknown[]): never => given as never;\n';

interface Row {
  readonly id: string;
  readonly source: string;
}

/** Each read the clock where the object or the class is made. */
const MADE: readonly Row[] = [
  { id: 'object-method-key', source: 'const holder = { [Date.now()]() {} };' },
  { id: 'object-async-method-key', source: 'const holder = { async [Date.now()]() {} };' },
  { id: 'object-generator-method-key', source: 'const holder = { *[Date.now()]() {} };' },
  { id: 'object-getter-key', source: 'const holder = { get [Date.now()]() { return 1; } };' },
  { id: 'object-setter-key', source: 'const holder = { set [Date.now()](value: number) {} };' },
  { id: 'class-method-key', source: 'class Holder { [Date.now()]() {} }' },
  { id: 'class-static-method-key', source: 'class Holder { static [Date.now()]() {} }' },
  { id: 'class-getter-key', source: 'class Holder { get [Date.now()]() { return 1; } }' },
  { id: 'class-expression-method-key', source: 'const Holder = class { [Date.now()]() {} };' },
  { id: 'method-decorator-argument', source: `${DEC}class Holder { @dec(Date.now()) m() {} }` },
  {
    id: 'parameter-decorator-argument',
    source: `${DEC}class Holder { m(@dec(Date.now()) value: number) {} }`,
  },
  {
    id: 'constructor-parameter-decorator-argument',
    source: `${DEC}class Holder { constructor(@dec(Date.now()) value: number) {} }`,
  },
  {
    id: 'key-beside-a-body-that-reads-too',
    source: 'const holder = { [Date.now()]() { return Date.now(); } };',
  },
];

/** What runs when a function is called, which the flag leaves out as before. */
const DEFERRED: readonly Row[] = [
  { id: 'method-body', source: 'const holder = { m() { return Date.now(); } };' },
  { id: 'accessor-body', source: 'const holder = { get m() { return Date.now(); } };' },
  { id: 'class-method-body', source: 'class Holder { m() { return Date.now(); } }' },
  { id: 'constructor-body', source: 'class Holder { constructor() { Date.now(); } }' },
  { id: 'method-default-parameter', source: 'const holder = { m(value = Date.now()) {} };' },
  {
    id: 'method-destructured-default',
    source: 'const holder = { m({ value = Date.now() }: { value?: number }) {} };',
  },
  {
    id: 'parameter-default-beside-a-decorator',
    source: `${DEC}class Holder { m(@dec(1) value = Date.now()) {} }`,
  },
  { id: 'arrow-default-parameter', source: 'const read = (value = Date.now()) => value;' },
  { id: 'function-body', source: 'function read() { return Date.now(); }' },
  { id: 'arrow-body', source: 'const read = () => Date.now();' },
];

/** What runs as it stands, which the flag reads as before. */
const STANDING: readonly Row[] = [
  { id: 'plain-constant', source: 'const stamp = Date.now();' },
  { id: 'property-key', source: 'const holder = { [Date.now()]: 1 };' },
  { id: 'arrow-value-key', source: 'const holder = { [Date.now()]: () => 1 };' },
  { id: 'class-property-key', source: 'class Holder { [Date.now()] = 1; }' },
  { id: 'class-field', source: 'class Holder { field = Date.now(); }' },
  { id: 'class-static-block', source: 'class Holder { static { Date.now(); } }' },
  { id: 'class-extends', source: 'class Holder extends (Date.now() as never) {}' },
  { id: 'class-decorator-argument', source: `${DEC}@dec(Date.now())\nclass Holder {}` },
  {
    id: 'property-decorator-argument',
    source: `${DEC}class Holder { @dec(Date.now()) field = 1; }`,
  },
];

/** Each writes what the module holds where the object or the class is made, in a function's constants. */
const KEPT_MADE: readonly Row[] = [
  {
    id: 'object-method-key',
    source:
      'let n = 0;\nexport function C() { const x = Object.keys({ [n++]() {} })[0]; return x; }',
  },
  {
    id: 'class-expression-method-key',
    source:
      'let n = 0;\nexport function C() { const x = Object.getOwnPropertyNames(class { [n++]() {} }.prototype); return x; }',
  },
  {
    id: 'method-decorator-argument',
    source: `let n = 0;\n${DEC}export function C() { const x = class { @dec(n++) m() {} }; return x; }`,
  },
];

const KEPT_STANDING: readonly Row[] = [
  {
    id: 'property-key',
    source: 'let n = 0;\nexport function C() { const x = Object.keys({ [n++]: 1 })[0]; return x; }',
  },
  {
    id: 'plain-write',
    source: 'let n = 0;\nexport function C() { const x = n++; return x; }',
  },
];

const KEPT_DEFERRED: readonly Row[] = [
  {
    id: 'method-body',
    source: 'let n = 0;\nexport function C() { const x = { m() { n++; } }; return x; }',
  },
  {
    id: 'method-default-parameter',
    source:
      'let n = 0;\nexport function C() { const x = { m(value = n++) { return value; } }; return x; }',
  },
];

describe('what a part reads outside the functions it holds', () => {
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
    const root = await mkdtemp(path.join(os.tmpdir(), 'reactive-state-reach-keys-'));
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

  it.each(MADE)('reads a key or a decorator that runs as it is made: $id', ({ source }) => {
    expect(untracked(source, true)).toBe('Date');
    expect(untracked(source, false)).toBe('Date');
  });

  it.each(DEFERRED)('leaves what runs when it is called: $id', ({ source }) => {
    expect(untracked(source, true)).toBeUndefined();
    expect(untracked(source, false)).toBe('Date');
  });

  it.each(STANDING)('reads what runs as it stands: $id', ({ source }) => {
    expect(untracked(source, true)).toBe('Date');
    expect(untracked(source, false)).toBe('Date');
  });

  it.each(KEPT_MADE)(
    'finds a write in a key or a decorator as it is made: $id',
    async ({ source }) => {
      await expect(kept(source, true)).resolves.toBe('n');
      await expect(kept(source, false)).resolves.toBe('n');
    },
  );

  it.each(KEPT_STANDING)('finds a write that runs as it stands: $id', async ({ source }) => {
    await expect(kept(source, true)).resolves.toBe('n');
  });

  it.each(KEPT_DEFERRED)('leaves a write that runs when it is called: $id', async ({ source }) => {
    await expect(kept(source, true)).resolves.toBeUndefined();
    await expect(kept(source, false)).resolves.toBe('n');
  });
});
