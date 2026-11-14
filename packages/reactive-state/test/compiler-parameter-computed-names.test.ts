import { isIdentifier, isParameterDeclaration, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parameterOf } from '../src/compiler/framed-type-queries.ts';
import { readsBinding } from '../src/compiler/scope.ts';

/**
 * A method's parameters are in scope in its body and its own parameter list, not in the computed
 * name of the method, which runs where the method is defined: in `class C { [Date.now()](Date:
 * number) {} }` the `Date` of the key is the global's, and the `Date` of the body is the parameter's.
 */

const CASES = [
  {
    lines: ['class C {', '  [Date.now()](Date: number) {', '    return Date;', '  }', '}'],
    reads: ['2:none', '3:parameter'],
    what: "a class's method",
  },
  {
    lines: ['const value = {', '  [Date.now()](Date: number) {', '    return Date;', '  },', '};'],
    reads: ['2:none', '3:parameter'],
    what: "an object's method",
  },
  {
    lines: ['class C {', '  static [Date.now()](Date: number) {', '    return Date;', '  }', '}'],
    reads: ['2:none', '3:parameter'],
    what: "a class's static method",
  },
  {
    lines: ['class C {', '  set [Date.now()](Date: number) {', '    void Date;', '  }', '}'],
    reads: ['2:none', '3:parameter'],
    what: "a class's setter",
  },
  {
    lines: [
      'class C {',
      '  [Date.now()](Date: number, other = Date) {',
      '    return other;',
      '  }',
      '}',
    ],
    reads: ['2:none', '2:parameter'],
    what: 'a default of the parameter list, beside the key',
  },
  {
    lines: ['function run(Date: number) {', '  return () => Date;', '}'],
    reads: ['2:parameter'],
    what: "a function's parameter, read in a function within it",
  },
  {
    lines: ['const run = (Date: number) => Date;'],
    reads: ['1:parameter'],
    what: "an arrow's parameter",
  },
  {
    lines: ['class C {', '  [Date.now()]() {', '    return Date;', '  }', '}'],
    reads: ['2:none', '3:none'],
    what: 'a method of no parameter',
  },
] as const;

describe("a parameter read in a method's computed name", () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The reads of `Date` in `lines`, `line:parameter` where `parameterOf` finds one, else `line:none`. */
  function readsOfDate(lines: readonly string[]): readonly string[] {
    using parsed = api.createSourceFile('methods.ts', `${lines.join('\n')}\n`);
    const { sourceFile } = parsed;
    const found: string[] = [];
    const visit = (node: Node): void => {
      if (
        isIdentifier(node) &&
        node.text === 'Date' &&
        readsBinding(node) &&
        !(isParameterDeclaration(node.parent) && node.parent.name === node)
      ) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        found.push(`${String(line + 1)}:${parameterOf(node) === undefined ? 'none' : 'parameter'}`);
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    return found;
  }

  it.each(CASES)('finds the parameter of $what', ({ lines, reads }) => {
    expect(readsOfDate(lines)).toStrictEqual(reads);
  });
});
