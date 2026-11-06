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
 * A date's setter answers `NaN` of what is no finite number whatever the date, and a method of a
 * date's name called on what the code does not show is read as a date's: but where the code shows
 * what it is called on holds a method of that name of its own — an object, an instance of a class
 * of its own — the call answers what that method does, which the compile does not read. The rows
 * marked a pin answer the same before the change as after it.
 */

const SOURCE = [
  'declare const date: Date;',
  'declare const stamp: number;',
  'declare const error: Error;',
  "const receiver = { setTime(_value: number) { return 'stack'; } };",
  'class Clock { setTime(_value: number) { return 0; } }',
  'const when = new Date(stamp);',
].join('\n');

const CASES = [
  {
    answer: undefined,
    source: '({ setTime: (_value: number) => 0 }).setTime(Infinity)',
    what: 'an object of its own setter',
  },
  { answer: undefined, source: 'receiver.setTime(Infinity)', what: 'a constant of its own setter' },
  { answer: undefined, source: 'new Clock().setTime(NaN)', what: 'a class of its own setter' },
  { answer: NaN, source: 'new Date(0).setTime(NaN)', what: 'a date the code writes (pin)' },
  { answer: NaN, source: 'date.setTime(Infinity)', what: 'a date it does not show (pin)' },
  {
    answer: NaN,
    source: 'when.setUTCHours(Infinity)',
    what: 'a date of a time it does not write (pin)',
  },
  {
    answer: NaN,
    source: 'new globalThis.Date(stamp).setTime(NaN)',
    what: "the global object's date (pin)",
  },
  { answer: NaN, source: 'date.setTime(9e15)', what: 'a time past the dates (pin)' },
] as const;

describe("a date setter's name on a value of methods of its own", () => {
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

  /** The member name a read of `error` by the key `source` records. */
  function memberOf(source: string): string | undefined {
    return withModule(`error[${source}]`, (expression) => {
      if (!isElementAccessExpression(expression)) {
        throw new Error(`error[${source}] is no member read.`);
      }
      return frameMemberName(expression);
    });
  }

  it.each(CASES)('$what', ({ answer, source }) => {
    expect(answerOf(source)).toBe(answer);
  });

  it("records no member of a key an object's own setter answers", () => {
    expect(memberOf('receiver.setTime(Infinity)')).toBeUndefined();
  });

  it('records the member a date setter answers of a date (pin)', () => {
    expect(memberOf('date.setTime(Infinity)')).toBe('NaN');
  });
});
