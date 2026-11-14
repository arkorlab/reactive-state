import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { declaredAtTop } from '../src/compiler/hook-exports.ts';

/**
 * An alias a module of hooks declares at its top level, `import alias = Hooks.value`, is a name of
 * the module, as a constant or a namespace is: what a hook of it reads, `alias`, is the module's,
 * and is refused as the module's own, not as a name in no scope. An alias of a type alone, `import
 * type alias = Hooks.Shape`, names a type, as an interface does. An alias of a namespace's body is
 * the namespace's.
 */

const CASES = [
  {
    names: ['Hooks', 'alias'],
    source: 'namespace Hooks {\n  export const value = 1;\n}\nimport alias = Hooks.value;',
    what: 'an alias of a member of a namespace',
  },
  {
    names: ['Hooks', 'alias'],
    source: 'namespace Hooks {\n  export const value = 1;\n}\nexport import alias = Hooks.value;',
    what: 'an exported alias of a member',
  },
  {
    names: ['Outer', 'alias'],
    source:
      'namespace Outer {\n  export namespace Inner {\n    export const value = 1;\n  }\n}\nimport alias = Outer.Inner.value;',
    what: 'an alias of a member of a namespace in a namespace',
  },
  {
    names: ['Hooks', 'alias'],
    source: 'namespace Hooks {}\nimport type alias = Hooks.Shape;',
    what: 'an alias of a type alone',
  },
  {
    names: ['Hooks'],
    source: 'namespace Hooks {\n  import alias = Other.value;\n}',
    what: "an alias in a namespace's body, which is the namespace's",
  },
] as const;

describe('the names a module of hooks declares at its top level, an alias among them', () => {
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
