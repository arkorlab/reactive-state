import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { emptyArrayFill } from '../src/compiler/framed-array-fill-ranges.ts';
import { framedLogicalElementSkipped } from '../src/compiler/framed-array-logical-writes.ts';
import { type FrameBinding, frameBindingOf } from '../src/compiler/framed-bindings.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A function can be called again, and a call sees what an earlier call left in an array that is
 * declared outside the function: a use written after a logical assignment or a fill, in the same
 * function, is done before them in the next call. An array the function declares, one in a body that
 * runs once, and a function that leaves the array alone after the read are not affected.
 */
const DECLARATION = 'declare function g(): number; declare const v: unknown;';

const LOGICAL = [
  {
    id: 'write-after-the-logical-assignment-in-a-function',
    source: `${DECLARATION} const arr = [1]; function f() { arr[0] ||= g(); arr[0] = 0; } f(); f();`,
    skipped: false,
  },
  {
    id: 'write-after-the-logical-assignment-in-an-arrow',
    source: `${DECLARATION} const arr = [1]; const f = () => { arr[0] ||= g(); arr[0] = 0; }; f(); f();`,
    skipped: false,
  },
  {
    id: 'write-after-the-logical-assignment-in-a-method',
    source: `${DECLARATION} const arr = [1]; const holder = { f() { arr[0] ||= g(); arr[0] = 0; } }; holder.f(); holder.f();`,
    skipped: false,
  },
  {
    id: 'array-of-an-outer-function-and-a-nested-one',
    source: `${DECLARATION} function outer() { const arr = [1]; function f() { arr[0] ||= g(); arr[0] = 0; } f(); f(); } outer();`,
    skipped: false,
  },
  {
    id: 'array-declared-by-the-function-pin',
    source: `${DECLARATION} function f() { const arr = [1]; arr[0] ||= g(); arr[0] = 0; } f(); f();`,
    skipped: true,
  },
  {
    id: 'array-declared-where-the-module-runs-pin',
    source: `${DECLARATION} const arr = [1]; arr[0] ||= g(); arr[0] = 0;`,
    skipped: true,
  },
  {
    id: 'function-that-leaves-the-array-alone-after-pin',
    source: `${DECLARATION} const arr = [1]; function f() { arr[0] ||= g(); } f(); f();`,
    skipped: true,
  },
];

const FILLS = [
  {
    id: 'push-after-the-fill-in-a-function',
    source: `${DECLARATION} const a = [1, 2]; function f() { a.fill(v, 2); a.push(0); } f(); f();`,
    empty: false,
  },
  {
    id: 'push-after-the-fill-in-an-arrow',
    source: `${DECLARATION} const a = [1, 2]; const f = () => { a.fill(v, 2); a.push(0); }; f(); f();`,
    empty: false,
  },
  {
    id: 'array-of-an-outer-function-and-a-nested-one',
    source: `${DECLARATION} function outer() { const a = [1, 2]; function f() { a.fill(v, 2); a.push(0); } f(); f(); } outer();`,
    empty: false,
  },
  {
    id: 'array-declared-by-the-function-pin',
    source: `${DECLARATION} function f() { const a = [1, 2]; a.fill(v, 2); a.push(0); } f(); f();`,
    empty: true,
  },
  {
    id: 'array-declared-where-the-module-runs-pin',
    source: `${DECLARATION} const a = [1, 2]; a.fill(v, 2); a.push(0);`,
    empty: true,
  },
  {
    id: 'function-that-leaves-the-array-alone-after-pin',
    source: `${DECLARATION} const a = [1, 2]; function f() { a.fill(v, 2); } f(); f();`,
    empty: true,
  },
];

/** Every node of `root`'s tree. */
function nodesOf(root: Node): readonly Node[] {
  const nodes: Node[] = [];
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    nodes.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return nodes;
}

/** The binding of the array the source declares, `arr` or `a`. */
function arrayBinding(root: Node): FrameBinding {
  for (const node of nodesOf(root))
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      (node.name.text === 'arr' || node.name.text === 'a')
    )
      return node;
  throw new Error('no array');
}

/** Whether `value` names the array `root` stands for. */
function namesRoot(root: FrameBinding): (value: Expression) => boolean {
  return (value) => {
    const name = unwrapped(value);
    return isIdentifier(name) && frameBindingOf(name)?.binding === root;
  };
}

describe('an array a function that can be called again leaves to its next call', () => {
  it.each(LOGICAL)('logical: $id', ({ source, skipped }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'repeated-call-logical.ts', source);
    const write = nodesOf(parsed.sourceFile).find((node): node is BinaryExpression => {
      return (
        isBinaryExpression(node) &&
        node.operatorToken.kind === SyntaxKind.BarBarEqualsToken &&
        isElementAccessExpression(unwrapped(node.left))
      );
    });
    const root = arrayBinding(parsed.sourceFile);

    expect(write).toBeDefined();
    expect(write !== undefined && framedLogicalElementSkipped(write, root, namesRoot(root))).toBe(
      skipped,
    );
  });

  it.each(FILLS)('fill: $id', ({ source, empty }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'repeated-call-fill.ts', source);
    const call = nodesOf(parsed.sourceFile).find((node): node is CallExpression => {
      return (
        isCallExpression(node) &&
        isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'fill'
      );
    });
    const root = arrayBinding(parsed.sourceFile);
    const receiver =
      call !== undefined && isPropertyAccessExpression(call.expression)
        ? call.expression.expression
        : undefined;

    expect(call).toBeDefined();
    expect(receiver).toBeDefined();
    expect(
      call !== undefined &&
        receiver !== undefined &&
        emptyArrayFill(call.arguments, {
          receiver,
          root,
          call,
          borrowed: false,
          identity: (value) => (namesRoot(root)(value) ? root : undefined),
        }),
    ).toBe(empty);
  });
});
