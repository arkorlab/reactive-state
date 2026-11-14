import { isIdentifier, isQualifiedName, isTypeReferenceNode, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { qualifiedBuiltinName } from '../src/compiler/local-type-builtins.ts';

/**
 * `globalThis.Date` is the global type's where no namespace around it declares `globalThis` — and
 * in `namespace Outer.Inner {}` what the bodies of `Outer` export is around it, as in the body of
 * `namespace Outer { export namespace Inner {} }`: an `Outer` that exports a namespace `globalThis`
 * hides the global's. One it keeps to itself, and another namespace's, hide nothing.
 */

const CASES = [
  {
    lines: [
      'namespace Outer {',
      '  export namespace globalThis {',
      '    export type Date = number;',
      '  }',
      '}',
      'namespace Outer.Inner {',
      '  export const value: globalThis.Date = 1;',
      '}',
    ],
    name: undefined,
    what: 'a namespace the outer namespace exports',
  },
  {
    lines: [
      'namespace Outer.Inner {',
      '  export const value: globalThis.Date = 1;',
      '}',
      'namespace Outer {',
      '  export namespace globalThis {',
      '    export type Date = number;',
      '  }',
      '}',
    ],
    name: undefined,
    what: 'a namespace a later body of the outer namespace exports',
  },
  {
    lines: [
      'namespace Outer {',
      '  export namespace globalThis {',
      '    export type Date = number;',
      '  }',
      '}',
      'namespace Outer.Mid.Inner {',
      '  export const value: globalThis.Date = 1;',
      '}',
    ],
    name: undefined,
    what: 'a namespace the outermost namespace exports, in a body of three names',
  },
  {
    lines: [
      'namespace Outer {',
      '  namespace globalThis {',
      '    export type Date = number;',
      '  }',
      '}',
      'namespace Outer.Inner {',
      '  export const value: globalThis.Date = new Date();',
      '}',
    ],
    name: 'Date',
    what: 'a namespace the outer namespace keeps to itself',
  },
  {
    lines: [
      'namespace Other {',
      '  export namespace globalThis {',
      '    export type Date = number;',
      '  }',
      '}',
      'namespace Outer.Inner {',
      '  export const value: globalThis.Date = new Date();',
      '}',
    ],
    name: 'Date',
    what: "another namespace's exported namespace",
  },
  {
    lines: ['namespace Outer.Inner {', '  export const value: globalThis.Date = new Date();', '}'],
    name: 'Date',
    what: 'no namespace of the name',
  },
] as const;

describe('the global namespace in a namespace of a dotted name', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `qualifiedBuiltinName` reads of the one `globalThis.Date` the module `lines` writes. */
  function builtinOf(lines: readonly string[]): string | undefined {
    using parsed = api.createSourceFile('dotted.ts', `${lines.join('\n')}\n`);
    let found: { name: string | undefined } | undefined;
    const visit = (node: Node): void => {
      if (
        found === undefined &&
        isTypeReferenceNode(node) &&
        isQualifiedName(node.typeName) &&
        isIdentifier(node.typeName.left) &&
        node.typeName.left.text === 'globalThis'
      ) {
        found = { name: qualifiedBuiltinName(node.typeName) };
      }
      node.forEachChild(visit);
    };
    parsed.sourceFile.forEachChild(visit);
    if (found === undefined) {
      throw new Error('No `globalThis.Date` is written.');
    }
    return found.name;
  }

  it.each(CASES)('reads the global past $what', ({ lines, name }) => {
    expect(builtinOf(lines)).toBe(name);
  });
});
