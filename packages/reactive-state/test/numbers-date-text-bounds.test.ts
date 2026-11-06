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
 * Text of no offset is read in the time zone where it runs, which moves its time by less than a
 * day: a time within a day of the dates the language holds is one in some time zones and none in
 * others — `+275760-09-13T10:00` is none in UTC and in Tokyo, a time in Kiritimati — so that the
 * compile's reading tells no `NaN` of it. Text that writes no digit names no time in any. The rows
 * marked a pin answer the same before the change as after it.
 */

const SOURCE = ['declare const error: Error;'].join('\n');

const CASES = [
  {
    answer: undefined,
    source: "new Date('+275760-09-13T10:00').getTime()",
    what: 'ISO text past the last date here',
  },
  {
    answer: undefined,
    source: "new Date('-271821-04-19T13:00').getTime()",
    what: 'ISO text before the first date here',
  },
  {
    answer: undefined,
    source: "Date.parse('+275760-09-13T10:00')",
    what: 'ISO text past the last date parsed',
  },
  {
    answer: undefined,
    source: "Date.parse('-271821-04-19T13:00')",
    what: 'ISO text before the first date parsed',
  },
  {
    answer: undefined,
    source: "new Date('Jan 32 2020').getTime()",
    what: 'text of digits of no time',
  },
  { answer: NaN, source: "new Date('bad').getTime()", what: 'text of no digit (pin)' },
  { answer: NaN, source: "Date.parse('not-a-date')", what: 'text of no digit parsed (pin)' },
  {
    answer: NaN,
    source: "new Date('+275761-01-01T00:00Z').getTime()",
    what: 'zoned text past the dates (pin)',
  },
  {
    answer: undefined,
    source: "new Date('2020-01-01T00:00').getTime()",
    what: 'local ISO text (pin)',
  },
] as const;

describe('the time of text of no offset near the dates the language holds', () => {
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

  it('records no member of a key of text past the last date here', () => {
    const member = withModule("error[new Date('+275760-09-13T10:00').getTime()]", (expression) =>
      isElementAccessExpression(expression) ? frameMemberName(expression) : 'no member read',
    );

    expect(member).toBeUndefined();
  });
});
