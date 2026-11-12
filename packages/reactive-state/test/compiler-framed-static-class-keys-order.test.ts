import {
  type Expression,
  isBinaryExpression,
  isPropertyAccessExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { sourceArrayFunction } from '../src/compiler/framed-array-functions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A class evaluates the computed keys of all its members, in order, before it runs any static
 * initializer or static block, whatever the order they are written in: a write in a key written
 * after a static initializer is done by the time the initializer reads. A key of an instance
 * member, whose initializer runs at each construction, one that is no work, and a key of another
 * class that is written after leave the method as it was.
 */
const HOLDER = "const methods = { join() { return 'fixed'; } };";
const REPLACE = "[(methods.join = Array.prototype.join, 'x')]";

const METHODS = [
  {
    id: 'reviewed-key-after-a-static-field',
    source: `${HOLDER} class C { static taken = methods.join; ${REPLACE} = 0; } void C;`,
    custom: false,
  },
  {
    id: 'key-of-a-method-after-a-static-field',
    source: `${HOLDER} class C { static taken = methods.join; static ${REPLACE}() { return 0; } } void C;`,
    custom: false,
  },
  {
    id: 'key-after-a-static-block',
    source: `${HOLDER} class C { static { void methods.join; } ${REPLACE} = 0; } void C;`,
    custom: false,
  },
  {
    id: 'key-after-a-static-field-of-a-class-expression',
    source: `${HOLDER} const C = class { static taken = methods.join; ${REPLACE} = 0; }; void C;`,
    custom: false,
  },
  {
    id: 'key-after-another-member-and-a-static-field',
    source: `${HOLDER} class C { static taken = methods.join; other = 1; get ${REPLACE}() { return 0; } } void C;`,
    custom: false,
  },
  {
    id: 'key-before-a-static-field-pin',
    source: `${HOLDER} class C { ${REPLACE} = 0; static taken = methods.join; } void C;`,
    custom: false,
  },
  {
    id: 'key-after-an-instance-initializer-pin',
    source: `${HOLDER} class C { taken = methods.join; ${REPLACE} = 0; } void C;`,
    custom: false,
  },
  {
    id: 'static-field-and-no-computed-key-pin',
    source: `${HOLDER} class C { static taken = methods.join; other = 0; } void C;`,
    custom: true,
  },
  {
    id: 'constant-key-after-a-static-field-pin',
    source: `${HOLDER} class C { static taken = methods.join; ['x'] = 0; } void C;`,
    custom: true,
  },
  {
    id: 'key-of-another-class-after-pin',
    source: `${HOLDER} class A { static taken = methods.join; } class B { ${REPLACE} = 0; } void A; void B;`,
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

/** The first read of `methods.join`, but the writes of a plain assignment. */
function firstRead(root: Node): Expression {
  const reads = nodesOf(root).filter((node): node is Expression => {
    return (
      isPropertyAccessExpression(node) &&
      node.getText() === 'methods.join' &&
      !(
        isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === SyntaxKind.EqualsToken &&
        node.parent.left.pos === node.pos
      )
    );
  });
  const [read] = reads.toSorted((a, b) => a.pos - b.pos);
  if (read === undefined) throw new Error('no read');
  return read;
}

describe('a method read by a static initializer of a class with computed keys', () => {
  it.each(METHODS)('$id', ({ source, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'static-class-keys-order.ts', source);

    expect(sourceArrayFunction(firstRead(parsed.sourceFile))).toBe(custom);
  });
});
