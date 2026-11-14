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
 * What a method of a date the code makes answers is computed only of a time that is the same
 * wherever and whenever the code runs: none of the clock's, `new Date()`, nor of parts or text of
 * no offset, which a date reads in the time zone where it runs — the compile's need not be the
 * authority's — but `NaN` where no time zone holds a time of them. The rows marked a pin answer the
 * same before the change as after it.
 */

const SOURCE = [
  'declare const error: Error;',
  'declare const stamp: number;',
  'const now = new Date();',
].join('\n');

const CASES = [
  { answer: undefined, source: 'new Date().getTime()', what: 'the clock' },
  { answer: undefined, source: '(new Date).valueOf()', what: 'the clock of no parentheses' },
  { answer: undefined, source: 'now.getTime()', what: 'a constant of the clock' },
  { answer: undefined, source: 'new Date(2020, 0, 1).getTime()', what: 'local parts' },
  {
    answer: undefined,
    source: 'new Date(2020, 0, 1).getUTCFullYear()',
    what: 'local parts in UTC',
  },
  { answer: undefined, source: "new Date('2020-01-01T00:00').getTime()", what: 'local ISO text' },
  {
    answer: undefined,
    source: "new Date('Jan 1 2020').getTime()",
    what: 'local text of no ISO form',
  },
  { answer: undefined, source: "new Date('-000000-01-01').getTime()", what: 'the year -000000' },
  {
    answer: undefined,
    source: 'new Date(275760, 8, 13, 5).getTime()',
    what: 'parts within a day of the last date',
  },
  { answer: undefined, source: "Date.parse('2020-01-01T00:00')", what: 'local ISO text parsed' },
  {
    answer: 1_577_836_800_000,
    source: "Date.parse('2020-01-01T00:00:00Z')",
    what: 'a time in UTC parsed (pin)',
  },
  { answer: NaN, source: "Date.parse('bad')", what: 'text of no time parsed (pin)' },
  { answer: 0, source: 'new Date(0).getTime()', what: 'a number (pin)' },
  { answer: 1, source: 'new Date(1000).getUTCSeconds()', what: 'a number in UTC (pin)' },
  { answer: 1_577_836_800_000, source: "new Date('2020-01-01').getTime()", what: 'a day (pin)' },
  {
    answer: 1_577_836_800_000,
    source: "new Date('2020-01-01T00:00:00Z').getTime()",
    what: 'a time in UTC (pin)',
  },
  {
    answer: 1_577_836_800_000,
    source: "new Date('2020-01-01T09:00:00+09:00').getTime()",
    what: 'a time of an offset (pin)',
  },
  { answer: NaN, source: "new Date('bad').getTime()", what: 'text of no time (pin)' },
  { answer: NaN, source: 'new Date(9e15).getTime()', what: 'a number past the dates (pin)' },
  { answer: NaN, source: 'new Date(NaN, 0).getTime()', what: 'a part of no number (pin)' },
  { answer: NaN, source: 'new Date(2020, Infinity).getTime()', what: 'an infinite part (pin)' },
  { answer: NaN, source: 'new Date(1e20, 0).getTime()', what: 'a year past the dates (pin)' },
  { answer: NaN, source: 'new Date().setTime(NaN)', what: 'a setter of the clock (pin)' },
  { answer: undefined, source: 'new Date(2020, 0, 1).getHours()', what: 'local hours (pin)' },
  { answer: undefined, source: 'new Date(stamp).getTime()', what: 'a number it reads (pin)' },
] as const;

describe('the time of a date the code makes', () => {
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

  it('records no member of a key of the clock', () => {
    const member = withModule('error[new Date().getTime()]', (expression) =>
      isElementAccessExpression(expression) ? frameMemberName(expression) : 'no member read',
    );

    expect(member).toBeUndefined();
  });
});
