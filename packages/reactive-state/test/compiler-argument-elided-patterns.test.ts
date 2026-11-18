import {
  type Expression,
  isCallExpression,
  isClassDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  type Node,
  type SourceFile,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { argumentChanges } from '../src/compiler/argument-effects.ts';
import { unwrapped } from '../src/compiler/bounded.ts';
import { declarationOf, initializerOf } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Array-binding elisions have omitted names and must not abort sibling pattern walks. */
const CASES = [
  {
    id: 'leading-elision-nested-object-default-write',
    expression: 'changeAfterElision([0, {}])',
    changed: true,
  },
  {
    id: 'trailing-elision-after-nested-object-default-write',
    expression: 'changeBeforeElision([{}, 0])',
    changed: true,
  },
  {
    id: 'middle-elision-computed-key-write',
    expression: 'changeMiddleElision([0, 0, { a: 1 }])',
    changed: true,
  },
  {
    id: 'nested-object-array-elision-default-write',
    expression: 'changeNestedArrayElision({ items: [0, {}] })',
    changed: true,
  },
  {
    id: 'rest-array-elision-default-write',
    expression: 'changeRestElision(0)',
    changed: true,
  },
  {
    id: 'native-callback-elision-default-write',
    expression:
      'Array.from([[0, {}] as [number, { value?: number }]], ([, { value = (selected.value = 0) }]) => value)',
    changed: true,
  },
  {
    id: 'pure-leading-elision-pattern',
    expression: 'pureElision([1, 2])',
    changed: false,
  },
  {
    id: 'pure-multiple-elisions-nested-pattern',
    expression: 'pureNestedElision([1, undefined, { value: 2 }])',
    changed: false,
  },
  {
    id: 'non-elided-array-pattern-write-pin',
    expression: 'changePlainPair([0, {}])',
    changed: true,
  },
  {
    id: 'non-elided-pure-array-pattern-pin',
    expression: 'purePlainPair([1, 2])',
    changed: false,
  },
];

/** Constant and declaration resolution matching the caller's static callee lookup. */
function calleeOf(node: Expression): Node | undefined {
  let value = unwrapped(node);
  const seen = new Set<Expression>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = declarationOf(value);
    if (
      declared !== undefined &&
      (isFunctionDeclaration(declared) || isClassDeclaration(declared))
    ) {
      return declared;
    }
    const initial = initializerOf(value);
    if (initial === undefined) {
      return value;
    }
    value = unwrapped(initial);
  }
  return value;
}

/** The argument passed to the trailing `take(...)` call in `file`. */
function testedArgument(file: SourceFile): Expression | undefined {
  const last = file.statements.at(-1);
  const call = last !== undefined && isExpressionStatement(last) ? last.expression : undefined;
  return call !== undefined && isCallExpression(call) ? call.arguments[0] : undefined;
}

describe('argument effects of elided array-binding parameter patterns', () => {
  it.each(CASES)('$id', ({ expression, changed }) => {
    const source = [
      'const selected = { value: 1 };',
      'function changeAfterElision([, { value = (selected.value = 0) }]: [unknown, { value?: number }]) { void value; }',
      'function changeBeforeElision([{ value = (selected.value = 0) }, ,]: [{ value?: number }, unknown?, unknown?]) { void value; }',
      "function changeMiddleElision([, , { [(selected.value = 0, 'a')]: value }]: [unknown, unknown, Record<string, number>]) { void value; }",
      'function changeNestedArrayElision({ items: [, { value = (selected.value = 0) }] }: { items: [unknown, { value?: number }] }) { void value; }',
      'function changeRestElision(...[, value = (selected.value = 0)]: [unknown, number?]) { void value; }',
      'function pureElision([, second = 0]: [number, number?]) { return second; }',
      'function pureNestedElision([, , { value = 0 } = {}]: [number?, unknown?, { value?: number }?]) { return value; }',
      'function changePlainPair([_first, { value = (selected.value = 0) }]: [unknown, { value?: number }]) { void value; }',
      'function purePlainPair([_first, second = 0]: [number, number?]) { return second; }',
      'function take(_value: unknown): void {}',
      `take(${expression});`,
    ].join('\n');
    using api = openTypeScript();
    using parsed = parseModule(api, 'argument-elided-patterns.ts', source);
    const argument = testedArgument(parsed.sourceFile);

    expect(argument === undefined ? undefined : argumentChanges(argument, calleeOf)).toBe(changed);
  });
});
