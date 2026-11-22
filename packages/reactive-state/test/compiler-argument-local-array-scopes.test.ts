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
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { argumentChanges } from '../src/compiler/argument-effects.ts';
import { unwrapped } from '../src/compiler/bounded.ts';
import { declarationOf, initializerOf } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

interface ScopeArrayCase {
  readonly body: string;
  readonly changed: boolean;
  readonly id: string;
}

/** Nested function/class `var` scopes and shadowed blocks must not taint outer fresh local arrays. */
const CASES: readonly ScopeArrayCase[] = [
  {
    body: 'const values: number[] = []; function unused() { var values: number[] = []; return values; } void unused; values.push(1); return values.length;',
    changed: false,
    id: 'outer-const-array-beside-unused-nested-function-var',
  },
  {
    body: 'let values: number[] = []; function unused() { var values = sharedItems; return values; } void unused; values[0] = 1; values.length = 0; return values.length;',
    changed: false,
    id: 'outer-let-array-slot-and-length-beside-nested-function-var',
  },
  {
    body: 'var values: number[] = []; function unused() { var values = sharedItems; return values; } void unused; values.push(1); return values.length;',
    changed: false,
    id: 'outer-var-array-beside-unused-nested-function-var',
  },
  {
    body: 'const values: number[] = []; const inner = () => { var values = sharedItems; return values; }; void inner; values.push(1); return values.length;',
    changed: false,
    id: 'outer-const-array-beside-nested-arrow-var',
  },
  {
    body: 'const values: number[] = []; const inner = function named() { var values = sharedItems; return values; }; void inner; values.unshift(1); return values.length;',
    changed: false,
    id: 'outer-const-array-beside-nested-function-expression-var',
  },
  {
    body: 'const values: number[] = []; const holder = { read() { var values = sharedItems; return values; }, get current() { var values = sharedItems; return values; }, set current(_next: unknown) { var values = sharedItems; void values; } }; void holder; values.push(1); return values.length;',
    changed: false,
    id: 'outer-const-array-beside-object-method-and-accessor-vars',
  },
  {
    body: 'const values: number[] = []; class Box { static { var values: number[] = []; values.push(2); } constructor() { var values = sharedItems; void values; } read() { var values = sharedItems; return values; } } void Box; values.push(1); return values.length;',
    changed: false,
    id: 'outer-const-array-beside-class-static-block-and-member-vars',
  },
  {
    body: 'const values: number[] = []; function inner() { var values: number[] = []; values.push(2); return values.length; } values.push(1); return values.length + inner();',
    changed: false,
    id: 'invoked-nested-function-with-independent-fresh-var-array',
  },
  {
    body: 'var values = sharedItems; { const values: number[] = []; values.push(1); values[0] = 2; } return values.length;',
    changed: false,
    id: 'inner-block-const-array-shadowing-outer-var-binding',
  },
  {
    body: 'const values: number[] = []; try { void 0; } catch (values) { void values; } values.push(1); return values.length;',
    changed: false,
    id: 'outer-const-array-beside-catch-clause-shadowed-binding',
  },
  {
    body: '{ const values: number[] = []; values.push(1); } { const values = sharedItems; return values.length; }',
    changed: false,
    id: 'sibling-block-const-arrays-remain-independent-pin',
  },
  {
    body: 'var values: number[] = []; { var values = sharedItems; } values.push(1); return values.length;',
    changed: true,
    id: 'same-function-nested-block-duplicate-var-rejected-pin',
  },
  {
    body: 'var values: number[] = []; for (var values of [sharedItems]) { values.push(1); } return values.length;',
    changed: true,
    id: 'same-function-for-of-duplicate-var-rejected-pin',
  },
  {
    body: 'var [values]: number[][] = [[]]; var values = sharedItems; values.push(1); return values.length;',
    changed: true,
    id: 'same-function-destructured-and-plain-duplicate-var-rejected-pin',
  },
  {
    body: 'const values: number[] = []; function inner() { var items: number[] = []; var items = sharedItems; items.push(1); return items.length; } values.push(1); return values.length + inner();',
    changed: true,
    id: 'invoked-nested-function-with-own-duplicate-var-rejected-pin',
  },
  {
    body: 'let values: number[] = []; function retarget() { values = sharedItems; } retarget(); values.push(1); return values.length;',
    changed: true,
    id: 'nested-function-rebinding-outer-let-array-rejected-pin',
  },
];

describe('function-scoped and block-scoped local-array redeclaration boundaries', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ body, changed }) => {
    const source = [
      'const sharedItems = [10, 20];',
      `function helper() { ${body} }`,
      'function take(_value: unknown): void {}',
      'take(helper());',
    ].join('\n');
    using parsed = parseModule(api, 'argument-local-array-scopes.ts', source);
    const argument = testedArgument(parsed.sourceFile);

    expect(argument === undefined ? undefined : argumentChanges(argument, calleeOf)).toBe(changed);
  });
});

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
