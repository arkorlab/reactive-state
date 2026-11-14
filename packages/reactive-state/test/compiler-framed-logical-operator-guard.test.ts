import {
  type BinaryExpression,
  type Expression,
  isBinaryExpression,
  isElementAccessExpression,
  isIdentifier,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedLogicalElementSkipped } from '../src/compiler/framed-array-logical-writes.ts';
import { type FrameBinding, frameBindingOf } from '../src/compiler/framed-bindings.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Only a logical assignment (`||=`, `&&=`, `??=`) can skip its right side, by the value the slot
 * holds: any other assignment evaluates its right side, whatever the slot holds. `=` always
 * evaluates it, and so do the compound assignments of arithmetic and bits, which are no logical
 * assignment and read the slot as a number or text, never as a test.
 */
const SLOTS = ['0', '1'];

/** Each assignment operator, with whether a slot of `0` or of `1` lets its right side be skipped. */
const OPERATORS = [
  { operator: '||=', skipped: { 0: false, 1: true } },
  { operator: '&&=', skipped: { 0: true, 1: false } },
  { operator: '??=', skipped: { 0: true, 1: true } },
  ...['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^='].map(
    (operator) => ({ operator, skipped: { 0: false, 1: false } }),
  ),
];

const CASES = OPERATORS.flatMap(({ operator, skipped }) => {
  return SLOTS.map((slot) => {
    return {
      id: `${operator} of a slot of ${slot}`,
      operator,
      slot,
      skipped: slot === '0' ? skipped[0] : skipped[1],
    };
  });
});

/** The binding a name stands for. */
function identity(value: Expression): FrameBinding | undefined {
  const name = unwrapped(value);
  return isIdentifier(name) ? frameBindingOf(name)?.binding : undefined;
}

/** The element assignment of `root`, and the array it writes. */
function elementWrite(root: Node): {
  readonly write: BinaryExpression;
  readonly array: Expression;
} {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isBinaryExpression(node)) {
      const target = unwrapped(node.left);
      if (isElementAccessExpression(target)) return { write: node, array: target.expression };
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no element write');
}

describe('whether an element assignment can skip its right side', () => {
  it.each(CASES)('$id', ({ operator, slot, skipped }) => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'logical-operator-guard.ts',
      `declare function g(): number; const arr = [${slot}]; arr[0] ${operator} g();`,
    );
    const { write, array } = elementWrite(parsed.sourceFile);
    const root = identity(array);

    expect(root).toBeDefined();
    expect(
      root !== undefined &&
        framedLogicalElementSkipped(write, root, (value) => identity(value) === root),
    ).toBe(skipped);
  });
});
