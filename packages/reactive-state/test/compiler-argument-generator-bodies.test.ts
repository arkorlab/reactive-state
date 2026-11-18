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

/**
 * A call of a generator function only acquires an iterator, but what consumes it within the
 * argument (`Array.from(gen())`, `[...gen()]`, `new Set(gen())`) runs the body, which was left out of
 * the walk: a generator that wrote what the argument's earlier siblings selected answered `false`.
 */
const CASES = [
  {
    id: 'array-from-generator-writes-captured-data',
    expression: 'Array.from(change())',
    changed: true,
  },
  {
    id: 'spread-generator-writes-captured-data',
    expression: '[...change()]',
    changed: true,
  },
  {
    id: 'set-of-generator-writes-captured-data',
    expression: 'new Set(change())',
    changed: true,
  },
  {
    id: 'spread-drain-generator-shifts-captured-queue',
    expression: '[...drain(queue)]',
    changed: true,
  },
  {
    id: 'array-from-generator-expression-writes-captured-data',
    expression: 'Array.from(changeLater())',
    changed: true,
  },
  {
    id: 'generator-delegating-to-writing-helper',
    expression: 'Array.from(delegating())',
    changed: true,
  },
  {
    id: 'pin-generator-of-locals-only',
    expression: 'Array.from(counted())',
    changed: false,
  },
  {
    id: 'pin-generator-reading-captured-data',
    expression: '[...reading()]',
    changed: false,
  },
  {
    id: 'pin-generator-mapper-is-not-consumed',
    expression: 'Array.from([1], function* mapper() { selected.value = 0; })',
    changed: false,
  },
  {
    id: 'pin-plain-function-draining-queue',
    expression: 'plainDrain(queue)',
    changed: true,
  },
] as const;

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

describe('argument effects of a generator the argument consumes', () => {
  it.each(CASES)('$id', ({ expression, changed }) => {
    const source = [
      'const selected = { value: 1 };',
      'const queue: number[] = [1, 2];',
      'function* change() { selected.value = 0; yield 1; }',
      'const changeLater = function* () { selected.value = 0; yield 1; };',
      'function* drain(items: number[]) { while (items.length > 0) yield items.shift(); }',
      'function* delegating() { yield* change(); }',
      'function* counted() { let seen = 0; seen += 1; yield seen; }',
      'function* reading() { yield selected.value; }',
      'function plainDrain(items: number[]) { return items.splice(0); }',
      'function take(_value: unknown): void {}',
      `take(${expression});`,
    ].join('\n');
    using api = openTypeScript();
    using parsed = parseModule(api, 'argument-generator-bodies.ts', source);
    const argument = testedArgument(parsed.sourceFile);

    expect(argument === undefined ? undefined : argumentChanges(argument, calleeOf)).toBe(changed);
  });
});
