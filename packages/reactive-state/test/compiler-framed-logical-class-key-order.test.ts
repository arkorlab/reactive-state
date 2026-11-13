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
 * A logical assignment tests the slot it reads, and skips its right side only while that slot is
 * the one the array was written with. A class evaluates the computed keys of all its members before
 * it runs any static initializer or static block, though they are written after: a write to the
 * slot, or the array handed to a call, in a key replaces the slot a logical assignment in a static
 * initializer tests. A write in a static initializer written after the assignment, in a key of
 * another class, to another array and a key that touches nothing leave the slot as it was.
 */
const DECLARATION = 'declare function g(): number; declare function lift(a: number[]): number[];';
const WRITE = "[(arr[0] = 0, 'k')]";

const CASES = [
  {
    id: 'reviewed-write-in-a-key-after-a-static-field',
    source: `${DECLARATION} const arr = [1]; class C { static x = (arr[0] ||= g()); ${WRITE} = 0; } void C;`,
    skipped: false,
  },
  {
    id: 'write-in-a-method-key-after-a-static-field',
    source: `${DECLARATION} const arr = [1]; class C { static x = (arr[0] ||= g()); static ${WRITE}() { return 0; } } void C;`,
    skipped: false,
  },
  {
    id: 'write-in-an-accessor-key-after-a-static-field',
    source: `${DECLARATION} const arr = [1]; class C { static x = (arr[0] ||= g()); get ${WRITE}() { return 0; } } void C;`,
    skipped: false,
  },
  {
    id: 'write-in-a-key-after-a-static-block',
    source: `${DECLARATION} const arr = [1]; class C { static { arr[0] ||= g(); } ${WRITE} = 0; } void C;`,
    skipped: false,
  },
  {
    id: 'write-in-a-key-of-a-class-expression',
    source: `${DECLARATION} const arr = [1]; const C = class { static x = (arr[0] ||= g()); ${WRITE} = 0; }; void C;`,
    skipped: false,
  },
  {
    id: 'write-in-a-key-of-the-outer-class',
    source: `${DECLARATION} const arr = [1]; class Outer { static Nested = class { static x = (arr[0] ||= g()); }; ${WRITE} = 0; } void Outer;`,
    skipped: false,
  },
  {
    id: 'array-handed-to-a-call-in-a-key',
    source: `${DECLARATION} const arr = [1]; class C { static x = (arr[0] ||= g()); [(lift(arr), 'k')] = 0; } void C;`,
    skipped: false,
  },
  {
    id: 'write-in-a-nullish-assignment-after-a-key',
    source: `${DECLARATION} const arr = [1]; class C { static x = (arr[0] ??= g()); ${WRITE} = 0; } void C;`,
    skipped: false,
  },
  {
    id: 'write-in-a-key-before-the-static-field-pin',
    source: `${DECLARATION} const arr = [1]; class C { ${WRITE} = 0; static x = (arr[0] ||= g()); } void C;`,
    skipped: false,
  },
  {
    id: 'write-in-a-static-field-after-the-assignment-pin',
    source: `${DECLARATION} const arr = [1]; class C { static x = (arr[0] ||= g()); static y = (arr[0] = 0); } void C;`,
    skipped: true,
  },
  {
    id: 'write-in-a-key-of-another-class-pin',
    source: `${DECLARATION} const arr = [1]; class C { static x = (arr[0] ||= g()); } class D { ${WRITE} = 0; } void C; void D;`,
    skipped: true,
  },
  {
    id: 'write-to-another-array-in-a-key-pin',
    source: `${DECLARATION} const arr = [1]; const other = [1]; class C { static x = (arr[0] ||= g()); [(other[0] = 0, 'k')] = 0; } void C;`,
    skipped: true,
  },
  {
    id: 'key-that-touches-nothing-pin',
    source: `${DECLARATION} const arr = [1]; class C { static x = (arr[0] ||= g()); ['k'] = 0; } void C;`,
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

/** The binding `arr` the source declares. */
function arrayBinding(root: Node): FrameBinding {
  for (const node of nodesOf(root))
    if (isVariableDeclaration(node) && isIdentifier(node.name) && node.name.text === 'arr')
      return node;
  throw new Error('no arr');
}

describe('whether a logical assignment can skip its right side past the keys of a class', () => {
  it.each(CASES)('$id', ({ source, skipped }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'logical-class-key-order.ts', source);
    const write = logicalWrite(parsed.sourceFile);
    const root = arrayBinding(parsed.sourceFile);
    const same = (value: Expression): boolean => {
      const name = unwrapped(value);
      return isIdentifier(name) && frameBindingOf(name)?.binding === root;
    };

    expect(framedLogicalElementSkipped(write, root, same)).toBe(skipped);
  });
});
