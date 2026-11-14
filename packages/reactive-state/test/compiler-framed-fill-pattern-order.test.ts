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
 * array's length, which holds only while nothing changes the length first. A destructuring pattern
 * evaluates what it destructures before its defaults and its computed keys, though they are
 * written first: a use of the array in that source changes the length before a fill in a default
 * reads it, and one a pattern's source holds before the fill it destructures into a default's
 * consumer does not.
 */
const CASES = [
  {
    id: 'reviewed-push-in-declaration-source',
    source:
      'const values = [1, 2]; const { x = values.fill(0, 2) } = (values.push(3), {}); void x;',
    empty: false,
  },
  {
    id: 'push-in-array-declaration-source',
    source: 'const values = [1, 2]; const [x = values.fill(0, 2)] = (values.push(3), []); void x;',
    empty: false,
  },
  {
    id: 'push-in-assignment-source',
    source:
      'const values = [1, 2]; let x: unknown; ({ x = values.fill(0, 2) } = (values.push(3), {})); void x;',
    empty: false,
  },
  {
    id: 'push-in-loop-source',
    source:
      'const values = [1, 2]; for (const { x = values.fill(0, 2) } of (values.push(3), [{}])) void x;',
    empty: false,
  },
  {
    id: 'push-in-parameter-source',
    source:
      'const values = [1, 2]; function pick({ x = values.fill(0, 2) } = (values.push(3), {})) { return x; } pick();',
    empty: false,
  },
  {
    id: 'push-in-nested-source',
    source:
      'const values = [1, 2]; const { x: { y = values.fill(0, 2) } } = { x: (values.push(3), {}) }; void y;',
    empty: false,
  },
  {
    id: 'push-in-computed-key-pin',
    source:
      'const values = [1, 2]; const { [(values.push(3), "k")]: x = values.fill(0, 2) } = {}; void x;',
    empty: false,
  },
  {
    id: 'fill-in-source-pin',
    source:
      'const values = [1, 2]; const { x = values.push(3) } = (values.fill(0, 2), {}); void x;',
    empty: true,
  },
  {
    id: 'fill-then-push-statements-pin',
    source: 'const values = [1, 2]; values.fill(0, 2); values.push(3);',
    empty: true,
  },
  {
    id: 'push-then-fill-statements-pin',
    source: 'const values = [1, 2]; values.push(3); values.fill(0, 2);',
    empty: false,
  },
  {
    id: 'push-and-fill-in-defaults-pin',
    source:
      'const values = [1, 2]; const { a = values.fill(0, 2), b = values.push(3) } = {}; void a; void b;',
    empty: true,
  },
  {
    id: 'push-in-default-before-fill-pin',
    source:
      'const values = [1, 2]; const { a = values.push(3), b = values.fill(0, 2) } = {}; void a; void b;',
    empty: false,
  },
  {
    id: 'fill-in-source-of-default-pin',
    source:
      'const values = [1, 2]; const { x = (values.push(3), 0) } = (values.fill(0, 2), {}); void x;',
    empty: true,
  },
  {
    id: 'unrelated-source-pin',
    source:
      'const values = [1, 2]; const other = [1]; const { x = values.fill(0, 2) } = (other.push(3), {}); void x;',
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

describe('a fill of a literal array beside a destructuring pattern', () => {
  it.each(CASES)('$id', ({ source, empty }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'fill-pattern-order.ts', source);
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
