import { isVariableStatement } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handedGlobal } from '../src/compiler/handed-globals.ts';

/**
 * A pattern that takes a global apart by a key written in brackets, `{ ['abs']: abs }`, takes it
 * apart by that key, as `{ abs }` does: a member the compile reads by its name alone is handed on
 * where the key is that member's, whichever way it is written, and wherever the code computes it.
 */

/** The members of `Math` the compile reads by their names alone, as a shared module's checks do. */
const REACHED: ReadonlySet<string> = new Set(['Math.random']);

const CASES = [
  { hands: false, pattern: "{ ['abs']: abs }", what: 'another member by text' },
  { hands: false, pattern: '{ [`abs`]: abs }', what: 'another member by a template' },
  { hands: false, pattern: '{ abs }', what: 'another member by its name' },
  { hands: true, pattern: "{ ['random']: random }", what: 'the member by text' },
  { hands: true, pattern: '{ [`random`]: random }', what: 'the member by a template' },
  { hands: true, pattern: '{ random }', what: 'the member by its name' },
  { hands: true, pattern: '{ [key]: taken }', what: 'a key it computes' },
  { hands: true, pattern: "{ ['abs']: abs, ...rest }", what: 'a rest beside' },
] as const;

describe('a global taken apart by a key in brackets', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** What `handedGlobal` says of `Math`, which `pattern` takes apart. */
  function handed(pattern: string): string | undefined {
    using parsed = api.createSourceFile('handed.ts', `const ${pattern} = Math;\n`);
    const [statement] = parsed.sourceFile.statements;
    const initializer =
      statement !== undefined && isVariableStatement(statement)
        ? statement.declarationList.declarations[0]?.initializer
        : undefined;
    if (initializer === undefined) {
      throw new Error(`No pattern ${pattern} is declared.`);
    }
    return handedGlobal(initializer, REACHED);
  }

  it.each(CASES)('$what', ({ hands, pattern }) => {
    expect(handed(pattern) !== undefined).toBe(hands);
  });
});
