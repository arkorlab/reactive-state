import { isVariableStatement, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { globalPathOf, isErased, readsCodeGlobal } from '../src/compiler/code-globals.ts';

/**
 * A comma's value is its last operand, whatever runs before it: `(0, Reflect.get)` is `Reflect.get`,
 * as a bundle writes a call of a function apart from what it is read of, and a read of a global past
 * it is the global's read.
 */

const PATHS = [
  { path: ['Reflect', 'get'], source: '(0, Reflect.get)', what: 'a comma before a function' },
  {
    path: ['Reflect', 'get', 'apply'],
    source: '((0), Reflect.get).apply',
    what: 'a member of a comma',
  },
  { path: ['Math', 'random'], source: '(count(), Math.random)', what: 'a call before' },
  { path: ['Reflect', 'get'], source: '(Reflect.get)', what: 'parentheses alone' },
  { path: undefined, source: '(0, local)', what: 'a name of the module' },
] as const;

describe('a global read past a comma', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `globalPathOf` reads of `source`, what a constant is declared of, past its parentheses. */
  function pathOf(source: string): readonly string[] | undefined {
    using parsed = api.createSourceFile(
      'commas.ts',
      `const local = 1;\nconst value = ${source};\n`,
    );
    const statement = parsed.sourceFile.statements[1];
    const initializer =
      statement !== undefined && isVariableStatement(statement)
        ? statement.declarationList.declarations[0]?.initializer
        : undefined;
    if (initializer === undefined) {
      throw new Error(`No constant is declared of ${source}.`);
    }
    return globalPathOf(unwrapped(initializer));
  }

  it.each(PATHS)('$what', ({ path, source }) => {
    expect(pathOf(source)).toStrictEqual(path);
  });

  it('reads what made a function by a key a comma hands', () => {
    const source = [
      'export function run(text: string): unknown {',
      "  return (0, Reflect.get)(run, 'constructor')(text)();",
      '}',
      '',
    ].join('\n');
    using parsed = api.createSourceFile('commas.ts', source);
    const { sourceFile } = parsed;
    const reads: string[] = [];
    const visit = (node: Node): void => {
      if (isErased(node)) {
        return;
      }
      if (readsCodeGlobal(node)) {
        reads.push(source.slice(node.getStart(sourceFile), node.end));
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);

    expect(reads).toStrictEqual(["(0, Reflect.get)(run, 'constructor')"]);
  });
});
