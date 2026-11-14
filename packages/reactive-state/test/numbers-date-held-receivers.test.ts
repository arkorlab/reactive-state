import {
  type Expression,
  type Identifier,
  isElementAccessExpression,
  isExpressionStatement,
  isIdentifier,
  isVariableStatement,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { frameMemberName } from '../src/compiler/framed-bindings.ts';
import { constantNumber } from '../src/compiler/numbers.ts';

/**
 * A date a constant holds is the same object wherever the name is read, but its time is what was
 * last set of it, which a setter called on the name changes: `when.setTime(Infinity)` before
 * `when.getTime()`. A method's answer is computed only of a date the code makes there; of one a
 * name holds, a getter answers none, and a setter what it answers whatever the date. The rows
 * marked a pin answer the same before the change as after it.
 */

const SOURCE = [
  'declare const value: Record<string, unknown>;',
  'const when = new Date(0);',
  'when.setTime(Infinity);',
  "const bad = new Date('bad');",
].join('\n');

const CASES = [
  { answer: undefined, source: 'when.getTime()', what: 'a date set since it was made' },
  { answer: undefined, source: 'bad.getTime()', what: 'a date of no time a name holds' },
  { answer: 0, source: 'new Date(0).getTime()', what: 'a date made there (pin)' },
  { answer: NaN, source: "new Date('bad').getTime()", what: 'a date of none made there (pin)' },
  { answer: NaN, source: 'when.setTime(NaN)', what: 'a setter of a held date (pin)' },
] as const;

describe('the time of a date a constant holds', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /**
   * What `read` answers of the expression a module ends with, of `last` after `SOURCE`, and of what
   * the module's constants are declared of, by their names.
   */
  function withModule<T>(
    last: string,
    read: (expression: Expression, constants: ReadonlyMap<string, Expression>) => T,
  ): T {
    using parsed = api.createSourceFile('numbers.ts', `${SOURCE}\n${last};\n`);
    const constants = new Map<string, Expression>();
    for (const statement of parsed.sourceFile.statements) {
      if (!isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          constants.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    const statement = parsed.sourceFile.statements.at(-1);
    if (statement === undefined || !isExpressionStatement(statement)) {
      throw new Error(`No expression ends the module of ${last}.`);
    }
    return read(statement.expression, constants);
  }

  /** The number `source` computes to, its names read as what the constants it names hold. */
  function answerOf(source: string): number | undefined {
    return withModule(source, (expression, constants) =>
      constantNumber(expression, (name: Identifier) => constants.get(name.text)),
    );
  }

  it.each(CASES)('$what', ({ answer, source }) => {
    expect(answerOf(source)).toBe(answer);
  });

  it('records no member of a key of a date set since it was made', () => {
    const member = withModule('value[when.getTime()]', (expression) =>
      isElementAccessExpression(expression) ? frameMemberName(expression) : 'no member read',
    );

    expect(member).toBeUndefined();
  });
});
