import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isExpressionStatement,
  isIdentifier,
  isNewExpression,
  isVariableStatement,
  type NewExpression,
  type SourceFile,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import type { Resolve } from '../src/compiler/numbers.ts';
import {
  callbackKindsThrow,
  madeKindsThrow,
  reflectedTargetThrows,
} from '../src/compiler/throw-brands.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

interface Row {
  readonly id: string;
  /** The statements before the last construction or call of the source are the fixture's own. */
  readonly source: string;
  /** The global path of what is made or called, as the callers hand it; none for a method of a value. */
  readonly path: string;
  /** Whether the compile follows the constants of the module, as a reader that does. */
  readonly resolved?: boolean;
}

/** A pattern is no function: Node 26.13.1 throws a `TypeError` for each of these. */
const PATTERN_AS_FUNCTION: readonly Row[] = [
  { id: 'new Promise of a literal', path: 'Promise', source: 'new Promise(/x/);' },
  { id: 'new Promise of new RegExp', path: 'Promise', source: "new Promise(new RegExp('x'));" },
  {
    id: 'new FinalizationRegistry of a literal',
    path: 'FinalizationRegistry',
    source: 'new FinalizationRegistry(/x/);',
  },
  { id: 'map of a literal', path: '', source: '[1].map(/x/);' },
  { id: 'filter of a literal', path: '', source: '[1].filter(/x/);' },
  { id: 'forEach of new RegExp', path: '', source: "[1].forEach(new RegExp('x'));" },
  { id: 'sort of a literal', path: '', source: '[2, 1].sort(/x/);' },
  { id: 'toSorted of a literal', path: '', source: '[2, 1].toSorted(/x/);' },
  { id: 'Array.from of a literal', path: 'Array.from', source: 'Array.from([1], /x/);' },
  {
    id: 'a literal held by a constant',
    path: '',
    resolved: true,
    source: 'const pattern = /x/;\n[1].map(pattern);',
  },
];

/** What was no function already, as before. */
const NO_FUNCTION_BEFORE: readonly Row[] = [
  { id: 'map of an object', path: '', source: '[1].map({});' },
  { id: 'map of a number', path: '', source: '[1].map(5);' },
  { id: 'new Promise of a number', path: 'Promise', source: 'new Promise(5);' },
];

/** A function, or what the code does not tell, is no throw. */
const FUNCTIONS_AND_UNKNOWNS: readonly Row[] = [
  { id: 'map of an arrow function', path: '', source: '[1].map(() => 1);' },
  { id: 'map of a function expression', path: '', source: '[1].map(function () {});' },
  { id: 'sort of a comparator', path: '', source: '[2, 1].sort((left, right) => left - right);' },
  { id: 'sort of nothing', path: '', source: '[2, 1].sort(undefined);' },
  {
    id: 'Array.from of a mapper',
    path: 'Array.from',
    source: 'Array.from([1], (value) => value);',
  },
  { id: 'new Promise of an executor', path: 'Promise', source: 'new Promise(() => {});' },
  {
    id: 'map of a callback the code does not write',
    path: '',
    source: 'declare const callback: () => number;\n[1].map(callback);',
  },
  {
    id: 'new Promise of what an unknown class makes',
    path: 'Promise',
    source: 'declare class Executor {}\nnew Promise(new Executor() as never);',
  },
  {
    id: 'new Promise of what a class that shadows RegExp makes',
    path: 'Promise',
    source: 'class RegExp {}\nnew Promise(new RegExp() as never);',
  },
  {
    id: 'map of a pattern held by a name the module does not resolve',
    path: '',
    source: 'const pattern = /x/;\n[1].map(pattern);',
  },
];

/** A pattern where a pattern is asked for, or an object a constructor takes, throws nothing. */
const PATTERN_AS_PATTERN: readonly Row[] = [
  { id: 'replace of a literal', path: '', source: "'a'.replace(/a/, 'b');" },
  { id: 'split of a literal', path: '', source: "'a'.split(/a/);" },
  { id: 'matchAll of a literal', path: '', source: "'a'.matchAll(/a/g);" },
  { id: 'test of a literal', path: '', source: "/a/.test('a');" },
  { id: 'new WeakRef of a literal', path: 'WeakRef', source: 'new WeakRef(/x/);' },
  { id: 'new Proxy of a literal', path: 'Proxy', source: 'new Proxy(/x/, {});' },
];

describe('a regular expression written where a function goes', () => {
  it.each(PATTERN_AS_FUNCTION.map((row) => [row.id, row] as const))(
    'reads %s as a throw',
    (_id, row) => {
      expect(throwsOf(row)).toBe(true);
    },
  );

  it.each(NO_FUNCTION_BEFORE.map((row) => [row.id, row] as const))(
    'still reads %s as a throw',
    (_id, row) => {
      expect(throwsOf(row)).toBe(true);
    },
  );

  it.each(FUNCTIONS_AND_UNKNOWNS.map((row) => [row.id, row] as const))(
    'reads %s as no throw',
    (_id, row) => {
      expect(throwsOf(row)).toBe(false);
    },
  );

  it.each(PATTERN_AS_PATTERN.map((row) => [row.id, row] as const))(
    'reads %s as no throw',
    (_id, row) => {
      expect(throwsOf(row)).toBe(false);
    },
  );
});

describe('a regular expression written as the target of Reflect', () => {
  it.each([
    ['Reflect.apply of a literal', 'Reflect.apply(/x/, undefined, []);', true],
    ['Reflect.apply of new RegExp', "Reflect.apply(new RegExp('x'), undefined, []);", true],
    ['Reflect.construct of new RegExp', "Reflect.construct(new RegExp('x'), []);", true],
    ['Reflect.apply of a function', 'Reflect.apply(() => 1, undefined, []);', false],
  ] as const)('reads %s', (_id, source, expected) => {
    expect(reflectedOf(source)).toBe(expected);
  });
});

/** Whether the module answers that the last construction or call of the row throws of its kinds. */
function throwsOf(row: Row): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'regexp-callbacks.ts', row.source);
  const declarations = new Map<string, Expression>();
  for (const statement of parsed.sourceFile.statements) {
    if (!isVariableStatement(statement)) {
      continue;
    }
    for (const each of statement.declarationList.declarations) {
      if (isIdentifier(each.name) && each.initializer !== undefined) {
        declarations.set(each.name.text, each.initializer);
      }
    }
  }
  const resolve: Resolve | undefined =
    row.resolved === true ? (name) => declarations.get(name.text) : undefined;
  const found = lastOperation(parsed.sourceFile);
  if (found === undefined) {
    throw new Error('The fixture constructs or calls.');
  }
  return isNewExpression(found)
    ? madeKindsThrow(row.path, found.arguments ?? [], resolve)
    : callbackKindsThrow(unwrapped(found.expression), row.path, found.arguments, { resolve });
}

/** Whether `reflectedTargetThrows` answers for the one `Reflect` call of the source. */
function reflectedOf(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'regexp-reflect.ts', source);
  const found = lastOperation(parsed.sourceFile);
  if (found === undefined || !isCallExpression(found)) {
    throw new Error('The fixture calls Reflect.');
  }
  const path = unwrapped(found.expression).getText(parsed.sourceFile);
  return reflectedTargetThrows(path, found.arguments, undefined);
}

/** The expression of the last statement of a source, when it is a construction or a call. */
function lastOperation(file: SourceFile): CallExpression | NewExpression | undefined {
  const statement = file.statements.at(-1);
  const expression =
    statement !== undefined && isExpressionStatement(statement)
      ? unwrapped(statement.expression)
      : undefined;
  return expression !== undefined && (isCallExpression(expression) || isNewExpression(expression))
    ? expression
    : undefined;
}
