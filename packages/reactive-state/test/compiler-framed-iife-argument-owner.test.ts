import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { emptyArrayFill } from '../src/compiler/framed-array-fill-ranges.ts';
import { sourceArrayFunction } from '../src/compiler/framed-array-functions.ts';
import { framedLogicalElementSkipped } from '../src/compiler/framed-array-logical-writes.ts';
import { type FrameBinding, frameBindingOf } from '../src/compiler/framed-bindings.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A function called where it is written runs its body where the call stands, but its arguments
 * run first, and they are written after the body: what an argument does to an array or a holder
 * is done before a read in the body, so a body of a call with arguments does not share its
 * enclosing function's order. A call without arguments does, as it did.
 */
const FILLS = [
  {
    id: 'fill-length-changed-by-an-argument',
    source: 'declare const v: unknown; const a = [1, 2]; (() => a.fill(v, 2))(a.push(0));',
    empty: false,
  },
  {
    id: 'fill-in-a-function-called-through-call-pin',
    source:
      'declare const v: unknown; const a = [1, 2]; (function () { return a.fill(v, 2); }).call(null, a.push(0));',
    empty: false,
  },
  {
    id: 'fill-in-a-body-called-without-arguments-pin',
    source: 'declare const v: unknown; const a = [1, 2]; (() => a.fill(v, 2))(); a.push(0);',
    empty: true,
  },
  {
    id: 'fill-in-a-body-called-with-an-unrelated-argument-pin',
    source: 'declare const v: unknown; const a = [1, 2]; ((n: number) => a.fill(v, 2))(1);',
    empty: true,
  },
  {
    id: 'fill-length-changed-after-a-body-pin',
    source: 'declare const v: unknown; const a = [1, 2]; (() => a.fill(v, 2))(); a.push(0);',
    empty: true,
  },
];

const LOGICAL = [
  {
    id: 'slot-written-by-an-argument',
    source:
      'declare function g(): number; const arr = [1]; (() => { arr[0] ||= g(); })(arr[0] = 0);',
    skipped: false,
  },
  {
    id: 'slot-written-by-an-argument-of-a-function',
    source:
      'declare function g(): number; const arr = [1]; (function (n: number) { arr[0] ||= g(); })(arr[0] = 0);',
    skipped: false,
  },
  {
    id: 'slot-in-a-body-called-without-arguments-pin',
    source: 'declare function g(): number; const arr = [1]; (() => { arr[0] ||= g(); })();',
    skipped: true,
  },
  {
    id: 'slot-in-a-body-called-with-an-unrelated-argument-pin',
    source:
      'declare function g(): number; const arr = [1]; ((n: number) => { arr[0] ||= g(); })(2);',
    skipped: true,
  },
];

const METHODS = [
  {
    id: 'method-replaced-by-an-argument',
    source:
      "const methods = { join() { return 'fixed'; } }; const values = [1]; (() => { values.join = methods.join; })(methods.join = Array.prototype.join);",
    custom: false,
  },
  {
    id: 'method-replaced-by-an-argument-of-a-function',
    source:
      "const methods = { join() { return 'fixed'; } }; const values = [1]; (function (n: unknown) { values.join = methods.join; })(methods.join = Array.prototype.join);",
    custom: false,
  },
  {
    id: 'method-in-a-body-called-without-arguments-pin',
    source:
      "const methods = { join() { return 'fixed'; } }; const values = [1]; (() => { values.join = methods.join; })(); methods.join = Array.prototype.join;",
    custom: true,
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

/** The binding a name stands for. */
function identity(value: Expression): FrameBinding | undefined {
  const name = unwrapped(value);
  return isIdentifier(name) ? frameBindingOf(name)?.binding : undefined;
}

/** The `fill` call of `root`, and what it is called on. */
function fillCall(root: Node): { readonly call: CallExpression; readonly receiver: Expression } {
  for (const node of nodesOf(root)) {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'fill'
    )
      return { call: node, receiver: node.expression.expression };
  }
  throw new Error('no fill call');
}

/** The logical assignment of `root`, and what it is an element of. */
function logicalWrite(root: Node): {
  readonly write: BinaryExpression;
  readonly array: Expression;
} {
  for (const node of nodesOf(root)) {
    if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.BarBarEqualsToken) {
      const target = unwrapped(node.left);
      if (isElementAccessExpression(target)) return { write: node, array: target.expression };
    }
  }
  throw new Error('no logical write');
}

describe('a body called where it is written', () => {
  it.each(FILLS)('$id', ({ source, empty }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'iife-fill.ts', source);
    const { call, receiver } = fillCall(parsed.sourceFile);
    const root = identity(receiver);

    expect(root).toBeDefined();
    expect(
      root !== undefined &&
        emptyArrayFill(call.arguments, { receiver, root, call, borrowed: false, identity }),
    ).toBe(empty);
  });

  it.each(LOGICAL)('$id', ({ source, skipped }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'iife-logical.ts', source);
    const { write, array } = logicalWrite(parsed.sourceFile);
    const root = identity(array);

    expect(root).toBeDefined();
    expect(
      root !== undefined && framedLogicalElementSkipped(write, root, (v) => identity(v) === root),
    ).toBe(skipped);
  });

  it.each(METHODS)('$id', ({ source, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'iife-method.ts', source);
    const reads = nodesOf(parsed.sourceFile).filter((node): node is Expression => {
      return (
        isPropertyAccessExpression(node) &&
        node.getText() === 'methods.join' &&
        !(isBinaryExpression(node.parent) && node.parent.left === node)
      );
    });

    expect(reads).toHaveLength(1);
    expect(reads.map((each) => sourceArrayFunction(each))).toStrictEqual([custom]);
  });
});
