import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkModuleStatement } from '../src/compiler/hook-exports.ts';

/**
 * `import alias = Namespace.member` names what a namespace holds, as a constant does: it is an
 * alias of the language's, emitted as a declaration, not CommonJS's import of a module. What a
 * module of hooks refuses is `import thing = require('thing')` and `export = thing`, which an ES
 * module has no place for.
 */

const TAKEN = [
  {
    source: 'namespace Hooks {\n  export const value = 1;\n}\nimport alias = Hooks.value;',
    what: 'an alias of a member of a namespace',
  },
  {
    source: 'namespace Hooks {\n  export const value = 1;\n}\nexport import alias = Hooks.value;',
    what: 'an exported alias of a member',
  },
  {
    source:
      'namespace Outer {\n  export namespace Inner {\n    export const value = 1;\n  }\n}\nimport alias = Outer.Inner.value;',
    what: 'an alias of a member of a namespace in a namespace',
  },
  {
    source: 'namespace Hooks {}\nimport type alias = Hooks.Shape;',
    what: 'an alias of a type alone',
  },
] as const;

const REFUSED = [
  { source: "import thing = require('thing');", what: "CommonJS's import" },
  { source: "export import thing = require('thing');", what: "CommonJS's import, exported" },
  { source: 'const thing = 1;\nexport = thing;', what: "CommonJS's export" },
] as const;

describe('an alias of a namespace in a module of custom hooks', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `checkModuleStatement` refuses of the statements of `source`. */
  function refusalOf(source: string): string | undefined {
    using parsed = api.createSourceFile('use-thing.ts', `${source}\n`);
    const fail = (reason: string, node?: Node): never => {
      throw new Error(`${reason} @ ${node === undefined ? '' : node.getText(parsed.sourceFile)}`);
    };
    try {
      for (const statement of parsed.sourceFile.statements) {
        checkModuleStatement(statement, fail);
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return undefined;
  }

  it.each(TAKEN)('takes $what', ({ source }) => {
    expect(refusalOf(source)).toBeUndefined();
  });

  it.each(REFUSED)('refuses $what', ({ source }) => {
    expect(refusalOf(source)).toContain("CommonJS's import and export");
  });
});
