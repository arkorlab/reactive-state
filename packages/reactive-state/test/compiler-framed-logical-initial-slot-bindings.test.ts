import {
  type BinaryExpression,
  type Expression,
  isBinaryExpression,
  isElementAccessExpression,
  isIdentifier,
  type Node,
  SyntaxKind,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedLogicalElementSkipped } from '../src/compiler/framed-array-logical-writes.ts';
import { type FrameBinding, frameBindingOf } from '../src/compiler/framed-bindings.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A logical assignment skips its right side only while the slot it tests holds what the array was
 * written with, and that is known only of a `const` variable named by an identifier and written as
 * an array literal. A parameter's default is what a call that passes nothing gives; a call that
 * passes an array gives that one. A `let` or `var` can be given another array, a binding pattern
 * names a part of its source, and none of them holds one literal. Each such row ran in Node with its
 * right side evaluated.
 */
const DECLARATION = 'declare function g(): number;';

const CASES = [
  {
    id: 'function-parameter-default',
    source: `${DECLARATION} function f(arr = [1]) { arr[0] ||= g(); } f([0]);`,
    skipped: false,
  },
  {
    id: 'and-assignment-of-a-parameter-default',
    source: `${DECLARATION} function f(arr = [0]) { arr[0] &&= g(); } f([1]);`,
    skipped: false,
  },
  {
    id: 'nullish-assignment-of-a-parameter-default',
    source: `${DECLARATION} function f(arr = [1]) { arr[0] ??= g(); } f([null]);`,
    skipped: false,
  },
  {
    id: 'arrow-parameter-default',
    source: `${DECLARATION} const f = (arr = [1]) => { arr[0] ||= g(); }; f([0]);`,
    skipped: false,
  },
  {
    id: 'method-parameter-default',
    source: `${DECLARATION} const holder = { f(arr = [1]) { arr[0] ||= g(); } }; holder.f([0]);`,
    skipped: false,
  },
  {
    id: 'constructor-parameter-default',
    source: `${DECLARATION} class C { constructor(arr = [1]) { arr[0] ||= g(); } } new C([0]);`,
    skipped: false,
  },
  {
    id: 'parameter-default-called-without-an-argument',
    source: `${DECLARATION} function f(arr = [1]) { arr[0] ||= g(); } f();`,
    skipped: false,
  },
  {
    id: 'destructured-parameter-default',
    source: `${DECLARATION} function f([arr] = [[1]]) { arr[0] ||= g(); } f([[0]]);`,
    skipped: false,
  },
  {
    id: 'let-given-another-array-before',
    source: `${DECLARATION} let arr = [1]; arr = [0]; arr[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'let-given-another-array-by-a-call',
    source: `${DECLARATION} let arr = [1]; function w() { arr = [0]; } w(); arr[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'let-given-another-array-in-a-loop',
    source: `${DECLARATION} let arr = [1]; for (let i = 0; i < 2; i++) { arr[0] ||= g(); arr = [0]; }`,
    skipped: false,
  },
  {
    id: 'let-never-written-again',
    source: `${DECLARATION} let arr = [1]; arr[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'let-of-a-for-statement',
    source: `${DECLARATION} for (let arr = [1], i = 0; i < 2; i++) { arr[0] ||= g(); arr[0] = 0; }`,
    skipped: false,
  },
  {
    id: 'var-given-another-array-by-a-call',
    source: `${DECLARATION} var arr = [1]; (function () { arr = [0]; })(); arr[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'var-never-written-again',
    source: `${DECLARATION} var arr = [1]; arr[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'var-declared-again-with-another-array',
    source: `${DECLARATION} var arr = [1]; var arr = [0]; arr[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'var-declared-again-in-a-block',
    source: `${DECLARATION} var arr = [1]; { var arr = [0]; } arr[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'var-declared-again-by-a-for',
    source: `${DECLARATION} var arr = [1]; for (var arr = [0], i = 0; i < 1; i++) { arr[0] ||= g(); }`,
    skipped: false,
  },
  {
    id: 'const-of-a-for-statement',
    source: `${DECLARATION} for (const arr = [1]; ; ) { arr[0] ||= g(); break; }`,
    skipped: false,
  },
  {
    id: 'const-taken-apart-by-an-array-pattern',
    source: `${DECLARATION} const [arr] = [[0]]; arr[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'const-taken-apart-by-an-object-pattern',
    source: `${DECLARATION} const { arr } = { arr: [[0]] }; arr[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'catch-binding',
    source: `${DECLARATION} try { throw [1]; } catch (arr) { arr[0] ||= g(); }`,
    skipped: false,
  },
  {
    id: 'const-written-by-a-call-first',
    source: `${DECLARATION} const arr = [1]; function w() { arr[0] = 0; } w(); arr[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'const-written-before-pin',
    source: `${DECLARATION} const arr = [1]; arr[0] = 0; arr[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'const-or-assignment-pin',
    source: `${DECLARATION} const arr = [1]; arr[0] ||= g();`,
    skipped: true,
  },
  {
    id: 'const-and-assignment-pin',
    source: `${DECLARATION} const arr = [0]; arr[0] &&= g();`,
    skipped: true,
  },
  {
    id: 'const-nullish-assignment-pin',
    source: `${DECLARATION} const arr = [{}]; arr[0] ??= g();`,
    skipped: true,
  },
  {
    id: 'const-in-a-function-pin',
    source: `${DECLARATION} function f() { const arr = [1]; arr[0] ||= g(); } f();`,
    skipped: true,
  },
  {
    id: 'const-in-a-block-pin',
    source: `${DECLARATION} { const arr = [1]; arr[0] ||= g(); }`,
    skipped: true,
  },
  {
    id: 'const-with-a-whole-alias-pin',
    source: `${DECLARATION} const arr = [1]; const alias = arr; arr[0] ||= g(); void alias;`,
    skipped: true,
  },
];

const LOGICAL: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

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

/** The logical assignment of an element of `root`, the one such. */
function logicalWrite(root: Node): BinaryExpression {
  const writes = nodesOf(root).filter((node): node is BinaryExpression => {
    return (
      isBinaryExpression(node) &&
      LOGICAL.has(node.operatorToken.kind) &&
      isElementAccessExpression(unwrapped(node.left))
    );
  });
  const [write] = writes;
  if (write === undefined || writes.length !== 1) throw new Error('no single logical write');
  return write;
}

/** The binding the write's receiver names, which is what a caller that follows the name passes. */
function receiverBinding(write: BinaryExpression): FrameBinding {
  const target = unwrapped(write.left);
  if (!isElementAccessExpression(target)) throw new Error('no element write');
  const receiver = unwrapped(target.expression);
  const selected = isIdentifier(receiver) ? frameBindingOf(receiver) : undefined;
  if (selected === undefined) throw new Error('no binding');
  return selected.binding;
}

describe('whether a logical assignment can skip its right side by the array a binding is given', () => {
  it.each(CASES)('$id', ({ source, skipped }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'logical-initial-slot-bindings.ts', source);
    const write = logicalWrite(parsed.sourceFile);
    const root = receiverBinding(write);
    const same = (value: Expression): boolean => {
      const name = unwrapped(value);
      return isIdentifier(name) && frameBindingOf(name)?.binding === root;
    };

    expect(framedLogicalElementSkipped(write, root, same)).toBe(skipped);
  });
});
