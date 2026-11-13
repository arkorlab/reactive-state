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
 * array's length, which holds only while nothing changes the length first. A class evaluates the
 * computed keys of all its members before it runs any static initializer or static block, though
 * they are written after: a use of the array in a key changes the length before a fill in a static
 * initializer reads it. A use in a static initializer written after the fill, in a key of another
 * class and in a key of one that holds no fill leave the fill empty.
 */
const VALUES = 'const values = [1, 2];';
const PUSH = "[(values.push(3), 'k')]";

const CASES = [
  {
    id: 'reviewed-push-in-a-key-after-a-static-field',
    source: `${VALUES} class C { static x = values.fill(0, 2); ${PUSH} = 0; } void C;`,
    empty: false,
  },
  {
    id: 'push-in-a-method-key-after-a-static-field',
    source: `${VALUES} class C { static x = values.fill(0, 2); static ${PUSH}() { return 0; } } void C;`,
    empty: false,
  },
  {
    id: 'push-in-an-accessor-key-after-a-static-field',
    source: `${VALUES} class C { static x = values.fill(0, 2); get ${PUSH}() { return 0; } } void C;`,
    empty: false,
  },
  {
    id: 'push-in-a-key-after-a-static-block',
    source: `${VALUES} class C { static { values.fill(0, 2); } ${PUSH} = 0; } void C;`,
    empty: false,
  },
  {
    id: 'push-in-a-key-of-a-class-expression',
    source: `${VALUES} const C = class { static x = values.fill(0, 2); ${PUSH} = 0; }; void C;`,
    empty: false,
  },
  {
    id: 'push-in-a-key-of-the-outer-class',
    source: `${VALUES} class Outer { static Nested = class { static x = values.fill(0, 2); }; ${PUSH} = 0; } void Outer;`,
    empty: false,
  },
  {
    id: 'push-in-a-key-after-a-fill-called-where-it-is-written',
    source: `${VALUES} class C { static x = (() => values.fill(0, 2))(); ${PUSH} = 0; } void C;`,
    empty: false,
  },
  {
    id: 'push-in-a-key-before-the-static-field-pin',
    source: `${VALUES} class C { ${PUSH} = 0; static x = values.fill(0, 2); } void C;`,
    empty: false,
  },
  {
    id: 'push-in-a-static-field-after-the-fill-pin',
    source: `${VALUES} class C { static x = values.fill(0, 2); static y = values.push(3); } void C;`,
    empty: true,
  },
  {
    id: 'push-in-a-key-of-another-class-pin',
    source: `${VALUES} class C { static x = values.fill(0, 2); } class D { ${PUSH} = 0; } void C; void D;`,
    empty: true,
  },
  {
    id: 'push-of-another-array-in-a-key-pin',
    source: `${VALUES} const other = [1]; class C { static x = values.fill(0, 2); [(other.push(3), 'k')] = 0; } void C;`,
    empty: true,
  },
  {
    id: 'key-that-does-not-touch-the-array-pin',
    source: `${VALUES} class C { static x = values.fill(0, 2); ['k'] = 0; } void C;`,
    empty: true,
  },
  {
    id: 'fill-after-a-key-that-reads-another-array-pin',
    source: `${VALUES} const other = [1]; class C { [(other.push(3), 'k')] = 0; static x = values.fill(0, 2); } void C;`,
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

describe('a fill of a literal array beside the keys of a class', () => {
  it.each(CASES)('$id', ({ source, empty }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'fill-class-key-order.ts', source);
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
