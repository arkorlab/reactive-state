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
 * A class evaluates the computed keys of all its members before it runs any static initializer, and
 * a class written in a static initializer or static block of another is created while that one runs
 * them: the keys of the outer class, whichever is written first, are evaluated before the inner
 * class is created, so before its own keys and its own static initializers. A class written in an
 * instance initializer, whose initializer runs at each construction, or in a function, and the keys
 * of an outer class that the inner one precedes in a position that runs it first, are as they were.
 */
const HOLDER = "const methods = { join() { return 'fixed'; } };";
const REPLACE = "[(methods.join = Array.prototype.join, 'x')]";

const METHODS = [
  {
    id: 'reviewed-key-of-the-outer-class-after-a-nested-static-field',
    source: `${HOLDER} class Outer { static Nested = class Inner { static taken = methods.join; }; ${REPLACE} = 0; } void Outer;`,
    custom: false,
  },
  {
    id: 'key-of-the-outer-class-after-a-class-declared-in-a-static-block',
    source: `${HOLDER} class Outer { static { class Inner { static taken = methods.join; } void Inner; } ${REPLACE} = 0; } void Outer;`,
    custom: false,
  },
  {
    id: 'key-of-the-outer-class-after-a-nested-static-block',
    source: `${HOLDER} class Outer { static Nested = class Inner { static { void methods.join; } }; ${REPLACE} = 0; } void Outer;`,
    custom: false,
  },
  {
    id: 'key-of-the-outermost-of-three-classes',
    source: `${HOLDER} class A { static B = class B { static C = class C { static taken = methods.join; }; }; ${REPLACE} = 0; } void A;`,
    custom: false,
  },
  {
    id: 'key-of-a-method-of-the-outer-class',
    source: `${HOLDER} class Outer { static Nested = class Inner { static taken = methods.join; }; static ${REPLACE}() { return 0; } } void Outer;`,
    custom: false,
  },
  {
    id: 'key-of-the-inner-class-after-its-static-field-pin',
    source: `${HOLDER} class Outer { static Nested = class Inner { static taken = methods.join; ${REPLACE} = 0; }; } void Outer;`,
    custom: false,
  },
  {
    id: 'key-of-the-outer-class-before-pin',
    source: `${HOLDER} class Outer { ${REPLACE} = 0; static Nested = class Inner { static taken = methods.join; }; } void Outer;`,
    custom: false,
  },
  {
    id: 'inner-class-in-an-instance-initializer-pin',
    source: `${HOLDER} class Outer { nested = class Inner { static taken = methods.join; }; ${REPLACE} = 0; } void Outer;`,
    custom: false,
  },
  {
    id: 'inner-class-in-a-function-of-the-outer-class-pin',
    source: `${HOLDER} class Outer { static make() { return class Inner { static taken = methods.join; }; } ${REPLACE} = 0; } void Outer;`,
    custom: false,
  },
  {
    id: 'outer-class-without-computed-keys-pin',
    source: `${HOLDER} class Outer { static Nested = class Inner { static taken = methods.join; }; other = 0; } void Outer;`,
    custom: true,
  },
  {
    id: 'outer-class-with-a-constant-key-pin',
    source: `${HOLDER} class Outer { static Nested = class Inner { static taken = methods.join; }; ['x'] = 0; } void Outer;`,
    custom: true,
  },
  {
    id: 'key-of-a-class-after-the-nested-one-pin',
    source: `${HOLDER} class Outer { static Nested = class Inner { static taken = methods.join; }; } class Later { ${REPLACE} = 0; } void Outer; void Later;`,
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

describe('a method read by a static initializer of a class written in another class', () => {
  it.each(METHODS)('$id', ({ source, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'nested-static-owners.ts', source);

    expect(sourceArrayFunction(firstRead(parsed.sourceFile))).toBe(custom);
  });
});
