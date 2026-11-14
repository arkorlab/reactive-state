import { isImportDeclaration, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkModuleStatement } from '../src/compiler/hook-exports.ts';

/**
 * What a module of custom hooks may hold at its top level, whose copy runs in the browser: its
 * declarations, and nothing that runs as it loads for what it does — no statement of an expression,
 * and none that runs the statements it holds either: a condition, a loop, a `switch`, a `try`, a
 * block, a label, a `throw`, a `debugger`, a namespace's body of such a statement. A declaration's
 * initializer makes what it declares, and stays the module's: a constant's, the default export's.
 */

/** The words a refusal of what runs as the module loads begins with. */
const RUNS = 'A module of custom hooks declares its hooks and what they use, and runs nothing';

/** Each statement refused, and the statement the refusal stands at: itself, or one it holds. */
const REFUSED = [
  { at: undefined, source: 'if (enabled) register();', what: 'a condition' },
  { at: undefined, source: 'for (const each of [1]) register(each);', what: 'a loop over values' },
  { at: undefined, source: 'while (enabled) register();', what: 'a loop while' },
  { at: undefined, source: 'do register(); while (enabled);', what: 'a loop at least once' },
  { at: undefined, source: 'switch (mode) {\n  default:\n    register();\n}', what: 'a switch' },
  { at: undefined, source: 'try {\n  register();\n} catch {}', what: 'a try' },
  { at: undefined, source: '{\n  register();\n}', what: 'a block' },
  { at: undefined, source: 'loaded: register();', what: 'a label' },
  { at: undefined, source: "throw new Error('loaded');", what: 'a throw' },
  { at: undefined, source: 'debugger;', what: 'a debugger' },
  {
    at: 'register();',
    source: 'namespace Effects {\n  register();\n}',
    what: "a namespace's effect",
  },
  {
    at: 'register();',
    source: 'namespace Outer.Inner {\n  register();\n}',
    what: "a nested namespace's effect",
  },
  { at: undefined, source: 'register();', what: 'an expression' },
] as const;

const TAKEN = [
  { source: 'export function useThing() {\n  return 1;\n}', what: 'a hook' },
  { source: 'const LIMIT = register();', what: "a constant's initializer" },
  { source: 'export default register();', what: "the default export's" },
  { source: "'use client';", what: 'a directive' },
  { source: 'export function useThing() {}\n;', what: 'an empty statement' },
  { source: 'type Thing = string;\ninterface Shape {}', what: 'types' },
  { source: 'enum Mode {\n  On,\n}', what: 'an enum' },
  {
    source: "namespace Keys {\n  export const filter = 'filter';\n}",
    what: 'a namespace of constants',
  },
  {
    source: 'declare global {\n  interface Window {\n    thing: string;\n  }\n}',
    what: 'an ambient namespace',
  },
  { source: "export { useThing } from '@/hooks/thing';", what: 'a re-export of a path' },
] as const;

describe('what a module of custom hooks runs as it loads', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `checkModuleStatement` refuses of `source`'s statements but its imports, and where. */
  function refusalOf(source: string): string | undefined {
    using parsed = api.createSourceFile('use-thing.ts', `${source}\n`);
    const { sourceFile } = parsed;
    const fail = (reason: string, node?: Node): never => {
      const at = node === undefined ? '' : source.slice(node.getStart(sourceFile), node.end);
      throw new Error(`${reason} @ ${at}`);
    };
    try {
      for (const statement of sourceFile.statements) {
        if (!isImportDeclaration(statement)) {
          checkModuleStatement(statement, fail);
        }
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return undefined;
  }

  it.each(REFUSED)('refuses $what', ({ at, source }) => {
    const refusal = refusalOf(source);

    expect(refusal).toContain(RUNS);
    expect(refusal?.endsWith(` @ ${at ?? source}`)).toBe(true);
  });

  it.each(TAKEN)('takes $what', ({ source }) => {
    expect(refusalOf(source)).toBeUndefined();
  });

  it('refuses what CommonJS imports, and a relative path, for what they are', () => {
    expect(refusalOf("import thing = require('thing');")).toContain("CommonJS's import and export");
    expect(refusalOf("export * from './thing';")).toContain('is a relative path');
  });
});
