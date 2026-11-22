import {
  type Expression,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isReturnStatement,
  isSwitchStatement,
  isThrowStatement,
  type Statement,
  type SwitchStatement,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { switchEnding } from '../src/compiler/throw-branches.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * How a `switch` ends the function it stands in, where a clause returns what throws. The compiler's
 * `check` reads an expression that surely throws, such as `decodeURIComponent('%')`; here it is a
 * call of `boom()`. `throws-always.ts`, which calls `switchEnding`, is not in this tree.
 */

type Ending = 'returns' | 'runs' | 'throws';

/** The expressions of these fixtures that throw where they stand: a call of `boom`. */
function check(expression: Expression): Expression | undefined {
  return isCallExpression(expression) &&
    isIdentifier(expression.expression) &&
    expression.expression.text === 'boom'
    ? expression
    : undefined;
}

/** How `statements`, run in turn, end the function: a `throw`, a `return` of what does not throw. */
function endingOf(statements: readonly Statement[]): Ending {
  for (const statement of statements) {
    if (isThrowStatement(statement)) {
      return 'throws';
    }
    if (isReturnStatement(statement)) {
      return statement.expression === undefined || check(statement.expression) === undefined
        ? 'returns'
        : 'throws';
    }
  }
  return 'runs';
}

interface Row {
  readonly id: string;
  readonly statement: string;
  readonly ending: Ending;
}

/** A return of what throws is no exit: the clause throws, or the statement after the switch runs. */
const THROWING_RETURNS: readonly Row[] = [
  {
    id: 'a clause returns what throws',
    statement: 'switch (x) { case 1: return boom(); }',
    ending: 'runs',
  },
  {
    id: 'every clause returns what throws',
    statement: 'switch (x) { case 1: return boom(); case 2: return boom(); }',
    ending: 'runs',
  },
  {
    id: 'a clause works and then returns what throws',
    statement: 'switch (x) { case 1: items.push(1); return boom(); }',
    ending: 'runs',
  },
  {
    id: 'a default returns what throws',
    statement: 'switch (x) { case 1: items.push(1); break; default: return boom(); }',
    ending: 'runs',
  },
  {
    id: 'a loop in a clause returns what throws',
    statement: 'switch (x) { case 1: for (const item of items) { return boom(); } }',
    ending: 'runs',
  },
  {
    id: 'an if in a clause returns what throws',
    statement: 'switch (x) { case 1: if (items.length) { return boom(); } }',
    ending: 'runs',
  },
];

/** A return that may answer, in a clause the source does not select, still ends the function. */
const ANSWERING_RETURNS: readonly Row[] = [
  {
    id: 'a clause returns a value',
    statement: 'switch (x) { case 1: return 1; }',
    ending: 'returns',
  },
  {
    id: 'the clauses of an exhaustive guard return values',
    statement: 'switch (x) { case 1: return 1; case 2: return 2; }',
    ending: 'returns',
  },
  {
    id: 'a clause returns nothing',
    statement: 'switch (x) { case 1: return; }',
    ending: 'returns',
  },
  {
    id: 'one clause returns what throws and another a value',
    statement: 'switch (x) { case 1: return boom(); case 2: return 2; }',
    ending: 'returns',
  },
  {
    id: 'an if in a clause may return a value before what throws',
    statement: 'switch (x) { case 1: if (items.length) { return 1; } return boom(); }',
    ending: 'returns',
  },
  {
    id: 'a clause returns a call of another function',
    statement: 'switch (x) { case 1: return other(); }',
    ending: 'returns',
  },
];

/** What no clause returns, and what the source selects, as before. */
const AS_BEFORE: readonly Row[] = [
  { id: 'no clause returns', statement: 'switch (x) { case 1: items.push(1); }', ending: 'runs' },
  {
    id: 'a clause only breaks',
    statement: 'switch (x) { case 1: items.push(1); break; }',
    ending: 'runs',
  },
  {
    id: 'a case test throws',
    statement: 'switch (x) { case boom(): return 1; }',
    ending: 'throws',
  },
  {
    id: 'a literal selects a clause that returns a value',
    statement: 'switch (1) { case 1: return 1; }',
    ending: 'returns',
  },
  {
    id: 'a literal selects a clause that returns what throws',
    statement: 'switch (1) { case 1: return boom(); }',
    ending: 'throws',
  },
  {
    id: 'a literal selects no clause',
    statement: 'switch (1) { case 2: return 1; }',
    ending: 'runs',
  },
];

describe('a switch of a value the source does not give, where a clause returns what throws', () => {
  it.each(THROWING_RETURNS)('ends as runs: $id', ({ statement, ending }) => {
    expect(endingOfSwitch(statement)).toBe(ending);
  });

  it.each(ANSWERING_RETURNS)('ends as returns: $id', ({ statement, ending }) => {
    expect(endingOfSwitch(statement)).toBe(ending);
  });

  it.each(AS_BEFORE)('answers as before: $id', ({ statement, ending }) => {
    expect(endingOfSwitch(statement)).toBe(ending);
  });
});

/** How `switchEnding` ends the one `switch` of the fixture. */
function endingOfSwitch(source: string): Ending {
  using api = openTypeScript();
  using parsed = parseModule(
    api,
    'switch-throwing-returns.ts',
    `declare const x: number; declare const items: number[]; declare function boom(): never; declare function other(): number;\nfunction f() {\n${source}\n}\n`,
  );
  const fn = parsed.sourceFile.statements.find(
    (each) => isFunctionDeclaration(each) && each.name?.text === 'f',
  );
  const [first] = fn !== undefined && isFunctionDeclaration(fn) ? (fn.body?.statements ?? []) : [];
  if (first === undefined || !isSwitchStatement(first)) {
    throw new Error('The fixture holds a switch.');
  }
  const node: SwitchStatement = first;
  return switchEnding(node, undefined, endingOf, check);
}
