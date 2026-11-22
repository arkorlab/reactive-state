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

/** Destructured parameter patterns execute nested defaults and computed keys during binding. */
const CASES = [
  {
    id: 'object-pattern-default-write',
    expression: 'changeObject({})',
    changed: true,
  },
  {
    id: 'array-pattern-default-write',
    expression: 'changeArray([])',
    changed: true,
  },
  {
    id: 'nested-pattern-default-write',
    expression: 'changeNested({ box: {} })',
    changed: true,
  },
  {
    id: 'computed-pattern-key-write',
    expression: 'changeComputed({ a: 1 })',
    changed: true,
  },
  {
    id: 'rest-pattern-default-write',
    expression: 'changeRest()',
    changed: true,
  },
  {
    id: 'constructor-pattern-default-write',
    expression: 'new PatternBox({})',
    changed: true,
  },
  {
    id: 'generator-pattern-default-write',
    expression: 'changeGenerator({})',
    changed: true,
  },
  {
    id: 'native-callback-pattern-default-write',
    expression: 'Array.from([{}], ({ value = (selected.value = 0) }: { value?: number }) => value)',
    changed: true,
  },
  {
    id: 'spread-shifted-outer-default-write',
    expression: 'outerSecondDefault(...[], 1)',
    changed: true,
  },
  {
    id: 'pure-object-pattern-default',
    expression: 'purePattern({})',
    changed: false,
  },
  {
    id: 'present-outer-identifier-default-pin',
    expression: 'outerDefault(1)',
    changed: false,
  },
  {
    id: 'omitted-outer-identifier-default-pin',
    expression: 'outerDefault()',
    changed: true,
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

describe('argument effects of parameter binding pattern defaults', () => {
  it.each(CASES)('$id', ({ expression, changed }) => {
    const source = [
      'const selected = { value: 1 };',
      'function changeObject({ value = (selected.value = 0) }: { value?: number }) { void value; }',
      'function changeArray([value = (selected.value = 0)]: number[]) { void value; }',
      'function changeNested({ box: { value = (selected.value = 0) } }: { box: { value?: number } }) { void value; }',
      "function changeComputed({ [(selected.value = 0, 'a')]: value }: Record<string, number>) { void value; }",
      'function changeRest(...[value = (selected.value = 0)]: number[]) { void value; }',
      'class PatternBox { constructor({ value = (selected.value = 0) }: { value?: number }) { void value; } }',
      'function* changeGenerator({ value = (selected.value = 0) }: { value?: number }) { yield value; }',
      'function purePattern({ value = selected.value + 1 }: { value?: number }) { return value; }',
      'function outerDefault(value = (selected.value = 0)) { return value; }',
      'function outerSecondDefault(_first = 0, second = (selected.value = 0)) { return second; }',
      'function take(_value: unknown): void {}',
      `take(${expression});`,
    ].join('\n');
    using api = openTypeScript();
    using parsed = parseModule(api, 'argument-pattern-defaults.ts', source);
    const argument = testedArgument(parsed.sourceFile);

    expect(argument === undefined ? undefined : argumentChanges(argument, calleeOf)).toBe(changed);
  });
});
