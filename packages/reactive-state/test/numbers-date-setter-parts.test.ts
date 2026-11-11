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
 * A date's setter reads the parts it sets alone — `setDate` a day, `setHours` up to four — and
 * ignores what it is given past them, which it converts to no number: `new Date(0).setDate(5,
 * Infinity)` is a time, whatever the date. Only the parts a setter reads tell its `NaN`. The rows
 * marked a pin answer the same before the change as after it.
 */

const SOURCE = ['declare const value: Record<string, unknown>;', 'declare const date: Date;'].join(
  '\n',
);

const CASES = [
  { answer: undefined, source: 'new Date(0).setDate(5, Infinity)', what: 'a local day of more' },
  { answer: undefined, source: 'date.setDate(5, Infinity)', what: 'a day of more of a held date' },
  {
    answer: undefined,
    source: 'date.setHours(1, 2, 3, 4, Infinity)',
    what: 'hours of a fifth part',
  },
  { answer: undefined, source: 'new Date(0).setMonth(0, 1, NaN)', what: 'a month of a third part' },
  { answer: undefined, source: 'date.setTime(0, NaN)', what: 'a time of a second part' },
  {
    answer: NaN,
    source: 'date.setHours(1, 2, 3, Infinity)',
    what: 'hours of an infinite part (pin)',
  },
  { answer: NaN, source: 'new Date(0).setDate(NaN)', what: 'a day of NaN (pin)' },
  {
    answer: 345_600_000,
    source: 'new Date(0).setUTCDate(5, Infinity)',
    what: 'a UTC day of more (pin)',
  },
] as const;

describe('a date setter given more than it reads', () => {
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

  it('records no member of a key a setter answers of an ignored part', () => {
    const member = withModule('value[new Date(0).setDate(5, Infinity)]', (expression) =>
      isElementAccessExpression(expression) ? frameMemberName(expression) : 'no member read',
    );

    expect(member).toBeUndefined();
  });
});
