import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { emptyArrayFill } from '../src/compiler/framed-array-fill-ranges.ts';
import { type FrameBinding, frameBindingOf } from '../src/compiler/framed-bindings.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A fill of a constant literal array is taken for empty where its written bounds meet at the
 * array's length, which holds only while nothing changes the length first. An array exported where
 * it is declared (`export const values = [0]`) is one an importing module can extend before it
 * calls a function that fills it: a fill in a function, or in any body that runs later, is not
 * empty. A fill that runs where the module is evaluated, one in a body called where it is written,
 * and an array that is not exported, leave the length as written.
 */
const CASES = [
  {
    id: 'reviewed-fill-in-an-exported-function',
    source:
      'export const values = [0]; export function fill(value: number) { values.fill(value, 1); }',
    empty: false,
  },
  {
    id: 'fill-in-an-unexported-function-of-an-exported-array',
    source:
      'export const values = [0]; function fill(value: number) { values.fill(value, 1); } void fill;',
    empty: false,
  },
  {
    id: 'fill-in-an-arrow',
    source:
      'export const values = [0]; export const fill = (value: number) => values.fill(value, 1);',
    empty: false,
  },
  {
    id: 'fill-in-a-method',
    source:
      'export const values = [0]; export const holder = { fill(value: number) { return values.fill(value, 1); } };',
    empty: false,
  },
  {
    id: 'fill-in-a-class-method',
    source:
      'export const values = [0]; export class Filler { fill(value: number) { return values.fill(value, 1); } }',
    empty: false,
  },
  {
    id: 'fill-in-a-nested-function',
    source:
      'export const values = [0]; export function outer() { return (value: number) => values.fill(value, 1); }',
    empty: false,
  },
  {
    id: 'fill-up-to-a-negative-end',
    source:
      'export const values = [0, 1, 2, 3]; export function fill(value: number) { values.fill(value, 3, -1); }',
    empty: false,
  },
  {
    id: 'fill-where-the-module-is-evaluated-pin',
    source: 'export const values = [0]; values.fill(0, 1);',
    empty: true,
  },
  {
    id: 'fill-in-a-function-called-where-it-is-written-pin',
    source: 'export const values = [0]; (() => values.fill(0, 1))();',
    empty: true,
  },
  {
    id: 'fill-in-a-function-of-an-array-that-is-not-exported-pin',
    source: 'const values = [0]; export function fill(value: number) { values.fill(value, 1); }',
    empty: true,
  },
  {
    id: 'fill-in-a-function-of-an-array-in-an-export-clause-pin',
    source:
      'const values = [0]; export { values }; export function fill(value: number) { values.fill(value, 1); }',
    empty: false,
  },
  {
    id: 'fill-of-equal-bounds-in-an-exported-function-pin',
    source:
      'export const values = [0]; export function fill(value: number) { values.fill(value, 1, 1); }',
    empty: true,
  },
];

interface Fill {
  readonly call: CallExpression;
  readonly receiver: Expression;
}

/** The calls in `root` of the method `fill`, with what they are called on, by a walk of its tree. */
function fillCalls(root: Node): readonly Fill[] {
  const calls: Fill[] = [];
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'fill'
    )
      calls.push({ call: node, receiver: node.expression.expression });
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return calls;
}

/** The binding a name stands for, which the fill's receiver and a later use share. */
function identity(value: Expression): FrameBinding | undefined {
  const name = unwrapped(value);
  return isIdentifier(name) ? frameBindingOf(name)?.binding : undefined;
}

describe('a fill of a literal array that the module exports', () => {
  it.each(CASES)('$id', ({ source, empty }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'fill-exported-array.ts', source);
    const answers = fillCalls(parsed.sourceFile).map(({ call, receiver }) => {
      const root = identity(receiver);
      return (
        root !== undefined &&
        emptyArrayFill(call.arguments, { receiver, root, call, borrowed: false, identity })
      );
    });

    expect(answers).toStrictEqual([empty]);
  });
});
