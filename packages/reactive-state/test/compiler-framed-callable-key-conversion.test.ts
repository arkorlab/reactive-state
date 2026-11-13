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
 * A class turns the computed key of every member into a property key where it defines the member,
 * and an object key runs its `toString` then, a method's, an accessor's and a setter's key as much
 * as a field's: what that does to a holder's method is done before a static initializer reads it,
 * and before a class written after the key is defined. A key that is a written constant, a method
 * without a computed key, work in a method's body, which waits for a call, and a class defined
 * after the read leave the method as it was.
 */
const HOLDER = "const methods = { join() { return 'fixed'; } };";
const KEY =
  "const key = { toString() { methods.join = Array.prototype.join; return 'x'; } }; declare const x: number;";
const SETUP = `${HOLDER} ${KEY}`;

const METHODS = [
  {
    id: 'reviewed-object-key-of-a-method-after-a-static-field',
    source: `${SETUP} class C { static taken = methods.join; [key]() {} } void C;`,
    custom: false,
  },
  {
    id: 'object-key-of-a-getter',
    source: `${SETUP} class C { static taken = methods.join; get [key]() { return 0; } } void C;`,
    custom: false,
  },
  {
    id: 'object-key-of-a-setter',
    source: `${SETUP} class C { static taken = methods.join; set [key](value: number) { void value; } } void C;`,
    custom: false,
  },
  {
    id: 'object-key-of-a-static-method',
    source: `${SETUP} class C { static taken = methods.join; static [key]() {} } void C;`,
    custom: false,
  },
  {
    id: 'object-key-of-a-method-after-a-static-block',
    source: `${SETUP} class C { static { void methods.join; } [key]() {} } void C;`,
    custom: false,
  },
  {
    id: 'object-key-of-a-method-before-the-static-field',
    source: `${SETUP} class C { [key]() {} static taken = methods.join; } void C;`,
    custom: false,
  },
  {
    id: 'object-key-of-a-method-of-the-outer-class',
    source: `${SETUP} class Outer { static Nested = class { static taken = methods.join; }; [key]() {} } void Outer;`,
    custom: false,
  },
  {
    id: 'object-key-of-a-method-of-a-class-defined-before-pin',
    source: `${SETUP} class D { [key]() {} } class C { static taken = methods.join; } void D; void C;`,
    custom: false,
  },
  {
    id: 'written-constant-key-of-a-method-pin',
    source: `${SETUP} class C { static taken = methods.join; ['x']() {} } void C;`,
    custom: true,
  },
  {
    id: 'numeric-key-of-a-getter-pin',
    source: `${SETUP} class C { static taken = methods.join; get [0]() { return 0; } } void C;`,
    custom: true,
  },
  {
    id: 'method-without-a-computed-key-pin',
    source: `${SETUP} class C { static taken = methods.join; m() {} } void C;`,
    custom: true,
  },
  {
    id: 'conversion-in-the-body-of-a-method-pin',
    source: `${SETUP} class C { static taken = methods.join; ['x']() { return \`\${key}\`; } } void C;`,
    custom: true,
  },
  {
    id: 'object-key-of-a-method-of-a-class-defined-after-pin',
    source: `${SETUP} class C { static taken = methods.join; } class D { [key]() {} } void C; void D;`,
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

/** The first read of `methods.join` that is no assignment's target. */
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

describe('a method read beside a computed key of a method, an accessor or a setter', () => {
  it.each(METHODS)('$id', ({ source, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'callable-key-conversion.ts', source);

    expect(sourceArrayFunction(firstRead(parsed.sourceFile))).toBe(custom);
  });
});
