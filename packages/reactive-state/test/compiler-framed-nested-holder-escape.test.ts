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
 * A method read through an object a literal holds, `methods.inner.join`, is read again after the
 * rest of a loop, or by another function: handing the nested object `methods.inner` away, or
 * keeping it under a name, lets what receives it replace `join` as handing the whole holder away
 * does. Reading a function of it, a value that is not an object, or taking the object apart in a
 * pattern hands it nowhere.
 */
const HOLDER = "const methods = { inner: { join() { return 'fixed'; } }, label: 'x' };";
const TAKEN = 'const values = [error]; values.join = methods.inner.join;';
const DEEP = "const methods = { a: { b: { join() { return 'fixed'; } }, label: 'x' } };";
const DEEP_TAKEN = 'const values = [error]; values.join = methods.a.b.join;';
const KEEP = 'function keep(held: { join: unknown }) { held.join = Array.prototype.join; }';

/** A function of the parameters `error` and `more`, whose body is `body`. */
function framed(body: string): string {
  return `function frames(error: Error, more: boolean) { ${body} }`;
}

const METHODS = [
  {
    id: 'reviewed-loop-hands-the-nested-holder-away',
    source: framed(
      `${HOLDER} for (const each of [1, 2]) { void each; ${TAKEN} keep(methods.inner); } ${KEEP}`,
    ),
    custom: false,
  },
  {
    id: 'loop-keeps-the-nested-holder-under-a-name',
    source: framed(
      `${HOLDER} for (const each of [1, 2]) { void each; ${TAKEN} const held = methods.inner; held.join = Array.prototype.join; }`,
    ),
    custom: false,
  },
  {
    id: 'while-hands-the-nested-holder-away',
    source: framed(`${HOLDER} while (more) { ${TAKEN} keep(methods.inner); } ${KEEP}`),
    custom: false,
  },
  {
    id: 'loop-hands-a-deeper-holder-away',
    source: framed(
      `const methods = { a: { b: { join() { return 'fixed'; } } } }; for (const each of [1, 2]) { void each; const values = [error]; values.join = methods.a.b.join; keep(methods.a); } ${KEEP}`,
    ),
    custom: false,
  },
  {
    id: 'another-function-hands-the-nested-holder-away',
    source: framed(
      `${HOLDER} function read() { ${TAKEN} } function swap() { keep(methods.inner); } ${KEEP} read(); swap();`,
    ),
    custom: false,
  },
  {
    id: 'loop-keeps-a-nested-holder-through-a-pattern',
    source: framed(
      `${DEEP} for (const each of [1, 2]) { void each; ${DEEP_TAKEN} const { b: held } = methods.a; held.join = Array.prototype.join; }`,
    ),
    custom: false,
  },
  {
    id: 'loop-keeps-a-nested-holder-through-a-computed-key',
    source: framed(
      `${DEEP} for (const each of [1, 2]) { void each; ${DEEP_TAKEN} const key = more ? 'b' : 'label'; const { [key]: held } = methods.a; void held; }`,
    ),
    custom: false,
  },
  {
    id: 'loop-keeps-the-rest-of-a-holder',
    source: framed(
      `${DEEP} for (const each of [1, 2]) { void each; ${DEEP_TAKEN} const { ...rest } = methods.a; void rest; }`,
    ),
    custom: false,
  },
  {
    id: 'another-function-keeps-a-nested-holder-through-a-pattern',
    source: framed(
      `${DEEP} function read() { ${DEEP_TAKEN} } function swap() { const { b: held } = methods.a; held.join = Array.prototype.join; } read(); swap();`,
    ),
    custom: false,
  },
  {
    id: 'loop-takes-a-nested-holder-apart-in-turn-pin',
    source: framed(
      `${DEEP} for (const each of [1, 2]) { void each; ${DEEP_TAKEN} const { b: { join } } = methods.a; void join; }`,
    ),
    custom: true,
  },
  {
    id: 'loop-takes-a-data-member-through-a-pattern-pin',
    source: framed(
      `${DEEP} for (const each of [1, 2]) { void each; ${DEEP_TAKEN} const { label } = methods.a; void label; }`,
    ),
    custom: true,
  },
  {
    id: 'loop-takes-a-function-through-a-pattern-with-a-default-pin',
    source: framed(
      `${DEEP} for (const each of [1, 2]) { void each; ${DEEP_TAKEN} const { join = Array.prototype.join } = methods.a.b; void join; }`,
    ),
    custom: true,
  },
  {
    id: 'loop-hands-a-function-away-pin',
    source: framed(
      `${HOLDER} for (const each of [1, 2]) { void each; ${TAKEN} keep(methods.inner.join as never); } ${KEEP}`,
    ),
    custom: true,
  },
  {
    id: 'loop-hands-a-data-member-away-pin',
    source: framed(
      `${HOLDER} for (const each of [1, 2]) { void each; ${TAKEN} keep(methods.label as never); } ${KEEP}`,
    ),
    custom: true,
  },
  {
    id: 'loop-takes-the-nested-holder-apart-pin',
    source: framed(
      `${HOLDER} for (const each of [1, 2]) { void each; ${TAKEN} const { join } = methods.inner; void join; }`,
    ),
    custom: true,
  },
  {
    id: 'loop-reads-the-nested-method-pin',
    source: framed(`${HOLDER} for (const each of [1, 2]) { void each; ${TAKEN} }`),
    custom: true,
  },
  {
    id: 'nested-holder-handed-away-after-the-loop-pin',
    source: framed(
      `${HOLDER} for (const each of [1, 2]) { void each; ${TAKEN} } keep(methods.inner); ${KEEP}`,
    ),
    custom: true,
  },
];

/** Every node of `root`'s tree, in the order a walk of it meets them. */
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

/** Whether `node` is the left side of an assignment of `=`, which reads nothing of it. */
function isPlainTarget(node: Node): boolean {
  return (
    isBinaryExpression(node.parent) &&
    node.parent.left === node &&
    node.parent.operatorToken.kind === SyntaxKind.EqualsToken
  );
}

/** The reads of the nested method, `join` of an object the holder's literal holds, but writes. */
function methodReads(root: Node): readonly Expression[] {
  return nodesOf(root).filter((node): node is Expression => {
    return (
      isPropertyAccessExpression(node) &&
      /^methods(?:\.\w+)+\.join$/u.test(node.getText()) &&
      !isPlainTarget(node) &&
      !isPropertyAccessExpression(node.parent)
    );
  });
}

describe('a method proof through a nested holder', () => {
  it.each(METHODS)('$id', ({ source, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'nested-holder-escape.ts', source);
    const [taken] = methodReads(parsed.sourceFile).toSorted((a, b) => a.pos - b.pos);

    expect(taken).toBeDefined();
    expect(taken === undefined ? undefined : sourceArrayFunction(taken)).toBe(custom);
  });
});
