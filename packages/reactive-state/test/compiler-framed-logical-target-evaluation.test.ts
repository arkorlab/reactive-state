import {
  type BinaryExpression,
  type Expression,
  isBinaryExpression,
  isElementAccessExpression,
  isIdentifier,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedLogicalElementSkipped } from '../src/compiler/framed-array-logical-writes.ts';
import { type FrameBinding, frameBindingOf } from '../src/compiler/framed-bindings.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A logical assignment evaluates its target — the receiver and the key of the element — before it
 * tests the slot, and the right side only after, when the test lets it run. What the target does to
 * the array comes before the test: a write in a receiver that is a comma expression, in a key, or
 * a call that is handed the array replaces the slot the test reads. What the right side does comes
 * after the test and cannot change it, and the receiver's own name is no use that changes the array.
 */
const DECLARATION = 'declare function g(): number; declare function lift(a: number[]): number[];';

const CASES = [
  {
    id: 'reviewed-write-in-a-comma-receiver',
    source: `${DECLARATION} const arr = [1]; (arr[0] = 0, arr)[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'write-in-a-key-pin',
    source: `${DECLARATION} const arr = [1]; arr[(arr[0] = 0, 0)] ||= g();`,
    skipped: false,
  },
  {
    id: 'array-handed-to-a-call-in-the-receiver',
    source: `${DECLARATION} const arr = [1]; lift(arr)[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'write-in-a-comma-receiver-of-a-nullish-assignment',
    source: `${DECLARATION} const arr = [1]; (arr[0] = undefined as never, arr)[0] ??= g();`,
    skipped: false,
  },
  {
    id: 'write-in-a-comma-receiver-of-an-and-assignment',
    source: `${DECLARATION} const arr = [0]; (arr[0] = 1, arr)[0] &&= g();`,
    skipped: false,
  },
  {
    id: 'plain-receiver-pin',
    source: `${DECLARATION} const arr = [1]; arr[0] ||= g();`,
    skipped: true,
  },
  {
    id: 'parenthesized-receiver-pin',
    source: `${DECLARATION} const arr = [1]; (arr)[0] ||= g();`,
    skipped: true,
  },
  {
    id: 'comma-receiver-of-a-constant-pin',
    source: `${DECLARATION} const arr = [1]; (0, arr)[0] ||= g();`,
    skipped: true,
  },
  {
    id: 'asserted-receiver-pin',
    source: `${DECLARATION} const arr = [1]; (arr as number[])[0] ||= g();`,
    skipped: true,
  },
  {
    id: 'write-in-the-right-side-pin',
    source: `${DECLARATION} const arr = [1]; arr[0] ||= (arr[0] = 5);`,
    skipped: true,
  },
  {
    id: 'write-after-the-assignment-pin',
    source: `${DECLARATION} const arr = [1]; arr[0] ||= g(); arr[0] = 0;`,
    skipped: true,
  },
  {
    id: 'write-before-the-assignment-pin',
    source: `${DECLARATION} const arr = [1]; arr[0] = 0; arr[0] ||= g();`,
    skipped: false,
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

/** The binding `arr` the source declares. */
function arrayBinding(root: Node): FrameBinding {
  for (const node of nodesOf(root))
    if (isVariableDeclaration(node) && isIdentifier(node.name) && node.name.text === 'arr')
      return node;
  throw new Error('no arr');
}

describe('whether a logical assignment can skip its right side past the work of its target', () => {
  it.each(CASES)('$id', ({ source, skipped }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'logical-target-evaluation.ts', source);
    const write = logicalWrite(parsed.sourceFile);
    const root = arrayBinding(parsed.sourceFile);
    const same = (value: Expression): boolean => {
      const name = unwrapped(value);
      return isIdentifier(name) && frameBindingOf(name)?.binding === root;
    };

    expect(framedLogicalElementSkipped(write, root, same)).toBe(skipped);
  });
});
