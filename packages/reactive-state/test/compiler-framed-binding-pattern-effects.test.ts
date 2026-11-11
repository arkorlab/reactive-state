import {
  type Expression,
  isBinaryExpression,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { sourceArrayFunction } from '../src/compiler/framed-array-functions.ts';
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
});
