import { isFunctionDeclaration, isVariableStatement, type VariableStatement } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canOmit } from '../src/compiler/omitted-work.ts';

/**
 * A `using` or an `await using` declaration is more than its initializer: it reads the resource's
 * disposal method as it is made and registers a cleanup that runs when its scope exits, `await`ed
 * where it is `await using`, so that leaving it out skips getters, a cleanup and its disposal. Each
 * row is the first statement of a function's body and whether `canOmit` takes it as work to leave
 * out; the `const` rows, an alias and a literal among them, pin what the change keeps.
 */
const CASES = [
  { statement: 'using resource = source;', omitted: false, what: 'a using of an alias' },
  {
    statement: 'await using resource = source;',
    omitted: false,
    what: 'an await using of an alias',
  },
  { statement: 'using resource = null;', omitted: false, what: 'a using of null' },
  {
    statement: 'using first = source, second = other;',
    omitted: false,
    what: 'several using declarations',
  },
  { statement: 'const resource = source;', omitted: true, what: 'a const of an alias' },
  { statement: 'const resource = 1;', omitted: true, what: 'a const of a literal' },
  { statement: 'let resource = source;', omitted: true, what: 'a let of an alias' },
  { statement: 'const resource = make();', omitted: false, what: 'a const of a call' },
] as const;

describe('a statement that may be left out of the browser', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether `canOmit` leaves out `statement`, written first in an `async` function's body. */
  function omitted(statement: string): boolean {
    using parsed = api.createSourceFile(
      'omitted-resources.ts',
      `async function frames(source: unknown, other: unknown) {\n${statement}\n}\n`,
    );
    let first: VariableStatement | undefined;
    for (const declaration of parsed.sourceFile.statements) {
      const body = isFunctionDeclaration(declaration) ? declaration.body : undefined;
      const [head] = body?.statements ?? [];
      if (head !== undefined && isVariableStatement(head)) first = head;
    }
    if (first === undefined) throw new Error(`No variable statement is written in ${statement}.`);
    return canOmit(first);
  }

  it.each(CASES)('$what', ({ statement, omitted: expected }) => {
    expect(omitted(statement)).toBe(expected);
  });
});
