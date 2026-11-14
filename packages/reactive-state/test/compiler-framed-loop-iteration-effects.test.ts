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
 * Iteration runs the application's code where it stands, though nothing is called there: a `for…of`
 * takes the iterator of its source, and an object that inherits an array's (`__proto__: []`, with a
 * `length` and an indexed getter) runs the getter, which can replace a method before it is read
 * (`taken` is the native `join` in Node, and the getter ran). So does the spread of a JSX child; a
 * JSX attribute's spread reads the getters of its object. All of them are work that the tuple proofs
 * name (`APPLICATION_WORK`), and a method proof does not survive it. A loop that stands after the
 * read, in a function nothing has called, or whose body holds the read (the loop's own passes are
 * checked as any other loop's) leave it. The coarse rule refuses every `for…of` and `for…in` before
 * the read, whatever it iterates.
 */
const HOLDER = "const methods = { join() { return 'fixed'; } };";
const ITERABLE =
  'const source = { __proto__: [], length: 1, get 0() { methods.join = Array.prototype.join; return 0; } };';
const GETTER = 'const source = { get x() { methods.join = Array.prototype.join; return 0; } };';
const TAKEN = 'const taken = methods.join;';

const METHODS = [
  {
    id: 'reviewed-for-of-of-an-array-like',
    source: `${ITERABLE} ${HOLDER} for (const x of source) {} ${TAKEN}`,
    custom: false,
  },
  {
    id: 'for-of-with-a-body',
    source: `${ITERABLE} ${HOLDER} for (const x of source) { void x; } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'for-of-into-a-name-declared-before',
    source: `${ITERABLE} ${HOLDER} let x: unknown; for (x of source) {} void x; ${TAKEN}`,
    custom: false,
  },
  {
    id: 'for-of-into-a-member',
    source: `${ITERABLE} ${HOLDER} const box = { item: 0 }; for (box.item of source) {} ${TAKEN}`,
    custom: false,
  },
  {
    id: 'for-of-of-a-pattern',
    source: `${ITERABLE} ${HOLDER} for (const [x] of [source]) { void x; } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'for-of-in-a-block',
    source: `${ITERABLE} ${HOLDER} { for (const x of source) {} } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'for-of-in-a-for-of',
    source: `${ITERABLE} ${HOLDER} for (const y of [1]) { for (const x of source) {} } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'for-await-of-in-an-async-function',
    source: `async function run() { ${ITERABLE} ${HOLDER} for await (const x of source) {} ${TAKEN} } void run;`,
    custom: false,
  },
  {
    id: 'for-of-of-a-plain-array',
    source: `${HOLDER} for (const x of [1]) { void x; } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'for-in-of-the-source',
    source: `${ITERABLE} ${HOLDER} for (const key in source) { void key; } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'spread-in-an-array-pin',
    source: `${ITERABLE} ${HOLDER} const copy = [...source]; void copy; ${TAKEN}`,
    custom: false,
  },
  {
    id: 'array-pattern-pin',
    source: `${ITERABLE} ${HOLDER} const [first] = source; void first; ${TAKEN}`,
    custom: false,
  },
  {
    id: 'jsx-attribute-spread',
    file: 'loop-iteration-effects.tsx',
    source: `${GETTER} ${HOLDER} const element = <div {...source} />; void element; ${TAKEN}`,
    custom: false,
  },
  {
    id: 'jsx-child-spread',
    file: 'loop-iteration-effects.tsx',
    source: `${ITERABLE} ${HOLDER} const element = <div>{...source}</div>; void element; ${TAKEN}`,
    custom: false,
  },
  {
    id: 'for-of-after-the-read-pin',
    source: `${ITERABLE} ${HOLDER} ${TAKEN} for (const x of source) {}`,
    custom: true,
  },
  {
    id: 'for-of-in-a-function-nothing-called-pin',
    source: `${ITERABLE} ${HOLDER} function unused() { for (const x of source) {} } void unused; ${TAKEN}`,
    custom: true,
  },
  {
    id: 'for-of-whose-iterable-holds-the-read-pin',
    source: `${HOLDER} for (const x of [methods.join]) { void x; }`,
    custom: true,
  },
  {
    id: 'for-of-whose-body-holds-the-read',
    source: `${ITERABLE} ${HOLDER} for (const x of source) { const taken = methods.join; void taken; }`,
    custom: false,
  },
  {
    id: 'jsx-element-without-a-spread-pin',
    file: 'loop-iteration-effects.tsx',
    source: `${HOLDER} const element = <div id="x" />; void element; ${TAKEN}`,
    custom: true,
  },
  {
    id: 'no-loop-pin',
    source: `${ITERABLE} ${HOLDER} ${TAKEN}`,
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

describe('a method proof past iteration that nothing calls', () => {
  it.each(METHODS)('$id', ({ source, custom, file = 'loop-iteration-effects.ts' }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, file, source);
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
