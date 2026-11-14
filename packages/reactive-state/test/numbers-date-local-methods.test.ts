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
 * A method of a date that reads or sets its time in the time zone where it runs answers what that
 * time zone makes of it, which may be past the dates the language holds in one and not in another:
 * `new Date(8.64e15).setHours(1)` is none in UTC and a time in Tokyo. `NaN` is told only where no
 * time zone holds a time: a date of none read, or set of what is no finite number. The rows marked
 * a pin answer the same before the change as after it.
 */

const SOURCE = ['declare const error: Error;'].join('\n');

const CASES = [
  {
    answer: undefined,
    source: 'new Date(8.64e15).setHours(1)',
    what: 'local hours set past the last date here',
  },
  {
    answer: undefined,
    source: 'new Date(-8.64e15).setHours(0)',
    what: 'local hours set before the first date here',
  },
  { answer: NaN, source: 'new Date(NaN).getHours()', what: 'local hours of a date of none (pin)' },
  { answer: NaN, source: 'new Date(NaN).setHours(1)', what: 'local hours set of none (pin)' },
  { answer: NaN, source: 'new Date(0).setHours(NaN)', what: 'local hours set to NaN (pin)' },
  {
    answer: NaN,
    source: 'new Date(0).setMinutes(0, Infinity)',
    what: 'an infinite part set (pin)',
  },
  {
    answer: undefined,
    source: 'new Date(NaN).setFullYear(2020)',
    what: 'a year set of a date of none (pin)',
  },
  { answer: undefined, source: 'new Date(0).getHours()', what: 'local hours of a time (pin)' },
  { answer: 3_600_000, source: 'new Date(0).setUTCHours(1)', what: 'UTC hours set (pin)' },
] as const;

describe('what a local method of a date the code makes answers', () => {
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

  it('records no member of a key of a local setter past the dates here', () => {
    const member = withModule('error[new Date(8.64e15).setHours(1)]', (expression) =>
      isElementAccessExpression(expression) ? frameMemberName(expression) : 'no member read',
    );

    expect(member).toBeUndefined();
  });
});
