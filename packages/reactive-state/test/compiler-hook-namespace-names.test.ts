import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { declaredAtTop } from '../src/compiler/hook-exports.ts';

/**
 * A namespace a module of hooks declares at its top level is a name of the module, as a function
 * or a constant is: what a hook of it reads, `Hooks.value`, is the module's. A module declared by
 * its text, `declare module 'x'`, names no binding, nor does a global's augmentation, `declare
 * global`.
 */

const CASES = [
  {
    names: ['Hooks'],
    source: 'namespace Hooks {\n  export const value = 1;\n}',
    what: 'a namespace',
  },
  {
    names: ['Hooks'],
    source: 'module Hooks {\n  export const value = 1;\n}',
    what: 'a namespace written `module`',
  },
  {
    names: ['Outer'],
    source: 'namespace Outer.Inner {\n  export const value = 1;\n}',
    what: 'a namespace of a dotted name',
  },
  {
    names: ['Hooks'],
    source: 'export namespace Hooks {\n  export const value = 1;\n}',
    what: 'an exported namespace',
  },
  {
    names: ['Hooks'],
    source: 'declare namespace Hooks {\n  const value: number;\n}',
    what: 'an ambient namespace',
  },
  {
    names: [],
    source: "declare module 'x' {\n  export const value: number;\n}",
    what: 'a module declared by its text',
  },
  {
    names: [],
    source: 'declare global {\n  interface Window {\n    value: number;\n  }\n}',
    what: "a global's augmentation",
  },
  { names: ['value'], source: 'const value = 1;', what: 'a constant' },
  { names: ['useThing'], source: 'export function useThing() {}', what: 'a function' },
] as const;

describe('the names a module of hooks declares at its top level', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('reads $what', ({ names, source }) => {
    using parsed = api.createSourceFile('use-thing.ts', `${source}\nexport {};\n`);
    const found = parsed.sourceFile.statements.flatMap((statement) =>
      declaredAtTop(statement).map((each) => each.text),
    );

    expect(found).toStrictEqual(names);
  });
});
