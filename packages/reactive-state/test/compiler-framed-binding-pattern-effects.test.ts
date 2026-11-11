import {
  type Expression,
  isBinaryExpression,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isVariableDeclaration,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { sourceArrayFunction, sourceArrayMethod } from '../src/compiler/framed-array-functions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A declaration that destructures an object reads its members, and an accessor of the object runs
 * as it does: a getter written before a method is read can replace the method, and a declaration
 * that takes the getter's value runs it where the declaration stands. An iterator that an array
 * pattern or a `for…of` takes runs there as well. A destructuring that stands after the read, one
 * in a function nothing has called yet, and a declaration of a plain name run nothing before it.
 */
const HOLDER = "const methods = { join() { return 'fixed'; } };";
const GETTER = 'const source = { get x() { methods.join = Array.prototype.join; return 0; } };';
const TAKEN = 'const taken = methods.join;';

const METHODS = [
  {
    id: 'reviewed-getter-taken-by-a-declaration',
    source: `${GETTER} ${HOLDER} const { x } = source; void x; ${TAKEN}`,
    custom: false,
  },
  {
    id: 'getter-taken-by-a-declaration-with-a-default',
    source: `${GETTER} ${HOLDER} const { x = 1 } = source; void x; ${TAKEN}`,
    custom: false,
  },
  {
    id: 'getter-taken-by-a-renamed-field',
    source: `${GETTER} ${HOLDER} const { x: taken } = source; void taken; ${TAKEN.replace('taken', 'later')}`,
    custom: false,
  },
  {
    id: 'getter-taken-through-a-nested-pattern',
    source: `${GETTER} ${HOLDER} const { x: { x } } = { x: source }; void x; ${TAKEN}`,
    custom: false,
  },
  {
    id: 'pattern-reading-another-field-is-work-too',
    source: `${GETTER} ${HOLDER} const { x: { y } } = { x: source }; void y; ${TAKEN}`,
    custom: false,
  },
  {
    id: 'getter-taken-by-an-array-pattern',
    source: `const source = [{ get x() { methods.join = Array.prototype.join; return 0; } }]; ${HOLDER} const [{ x }] = source; void x; ${TAKEN}`,
    custom: false,
  },
  {
    id: 'getter-taken-by-a-loop-binding',
    source: `${GETTER} ${HOLDER} for (const { x } of [source]) { void x; } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'getter-taken-before-a-default-that-reads-the-method',
    source: `${GETTER} ${HOLDER} const { x = methods.join } = source; void x;`,
    custom: false,
  },
  {
    id: 'getter-taken-by-a-destructuring-assignment-pin',
    source: `${GETTER} ${HOLDER} let x: unknown; ({ x } = source); void x; ${TAKEN}`,
    custom: false,
  },
  {
    id: 'declaration-of-a-plain-name-pin',
    source: `${GETTER} ${HOLDER} const x = source; void x; ${TAKEN}`,
    custom: true,
  },
  {
    id: 'destructuring-after-the-read-pin',
    source: `${GETTER} ${HOLDER} ${TAKEN} const { x } = source; void x;`,
    custom: true,
  },
  {
    id: 'destructuring-in-a-function-nothing-called-pin',
    source: `${GETTER} ${HOLDER} function unused() { const { x } = source; return x; } void unused; ${TAKEN}`,
    custom: true,
  },
];

/** The pattern declarations that take `methods` apart, with the path of the method each reads. */
const PATTERNS = [
  {
    id: 'flat-pattern-pin',
    source: `${HOLDER} const { join } = methods; void join;`,
    path: ['join'],
    custom: true,
  },
  {
    id: 'nested-pattern-of-the-source-holding-the-read',
    source:
      "const methods = { inner: { join() { return 'fixed'; } } }; const { inner: { join } } = methods; void join;",
    path: ['inner', 'join'],
    custom: true,
  },
  {
    id: 'doubly-nested-pattern-of-the-source-holding-the-read',
    source:
      "const methods = { a: { b: { join() { return 'fixed'; } } } }; const { a: { b: { join } } } = methods; void join;",
    path: ['a', 'b', 'join'],
    custom: true,
  },
  {
    id: 'nested-pattern-after-a-getter-pattern',
    source: `${GETTER} const methods = { inner: { join() { return 'fixed'; } } }; const { x } = source; void x; const { inner: { join } } = methods; void join;`,
    path: ['inner', 'join'],
    custom: false,
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

/** What each object pattern in `root` takes apart, where it is a declaration's initializer. */
function patternReceivers(root: Node): readonly Expression[] {
  return nodesOf(root).flatMap((node) => {
    return isVariableDeclaration(node) &&
      isObjectBindingPattern(node.name) &&
      node.initializer?.getText() === 'methods'
      ? [node.initializer]
      : [];
  });
}

describe('a method proof past a destructuring declaration', () => {
  it.each(METHODS)('$id', ({ source, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'binding-pattern-effects.ts', source);
    const reads = nodesOf(parsed.sourceFile).filter((node): node is Expression => {
      return (
        isPropertyAccessExpression(node) &&
        node.getText() === 'methods.join' &&
        !(isBinaryExpression(node.parent) && node.parent.left === node)
      );
    });
    const [taken] = reads.toSorted((a, b) => b.pos - a.pos);

    expect(taken).toBeDefined();
    expect(taken === undefined ? undefined : sourceArrayFunction(taken)).toBe(custom);
  });

  it.each(PATTERNS)('$id', ({ source, path, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'binding-pattern-receivers.ts', source);
    const receivers = patternReceivers(parsed.sourceFile);

    expect(receivers).toHaveLength(1);
    expect(receivers.map((each) => sourceArrayMethod(each, path))).toStrictEqual([custom]);
  });
});
