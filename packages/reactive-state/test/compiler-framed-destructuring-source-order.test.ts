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
 * A destructuring pattern evaluates what it destructures before its defaults and its computed
 * keys, though they are written first: what the source does — a write, a call — comes before a
 * method that a default reads, though it is written after the read. What the source does after the
 * pattern, and a source that does nothing, leave the method as it was.
 */
const HOLDER = "const methods = { join() { return 'fixed'; } };";
const REPLACED = 'methods.join = Array.prototype.join';
const SWAP = `function swap() { ${REPLACED}; }`;

const METHODS = [
  {
    id: 'reviewed-source-writes-the-method',
    source: `${HOLDER} const { x = methods.join } = (${REPLACED}, {}); void x;`,
    custom: false,
  },
  {
    id: 'source-writes-the-method-before-an-array-pattern',
    source: `${HOLDER} const [x = methods.join] = (${REPLACED}, []); void x;`,
    custom: false,
  },
  {
    id: 'source-writes-the-method-before-an-assignment-pattern',
    source: `${HOLDER} let x: unknown; ({ x = methods.join } = (${REPLACED}, {})); void x;`,
    custom: false,
  },
  {
    id: 'source-writes-the-method-before-an-array-assignment-pattern',
    source: `${HOLDER} let x: unknown; [x = methods.join] = (${REPLACED}, []); void x;`,
    custom: false,
  },
  {
    id: 'source-writes-the-method-before-a-loop-pattern',
    source: `${HOLDER} for (const { x = methods.join } of (${REPLACED}, [{}])) { void x; }`,
    custom: false,
  },
  {
    id: 'source-calls-a-function-that-writes-the-method',
    source: `${HOLDER} ${SWAP} const { x = methods.join } = (swap(), {}); void x;`,
    custom: false,
  },
  {
    id: 'source-writes-the-method-before-a-nested-pattern',
    source: `${HOLDER} const { a: { x = methods.join } } = { a: (${REPLACED}, {}) }; void x;`,
    custom: false,
  },
  {
    id: 'source-without-work-before-an-assignment-pattern-pin',
    source: `${HOLDER} let x: unknown; ({ x = methods.join } = {}); void x;`,
    custom: true,
  },
  {
    id: 'source-with-a-value-before-an-assignment-pattern-pin',
    source: `${HOLDER} let x: unknown; ({ x = methods.join } = { x: 1 }); void x;`,
    custom: true,
  },
  {
    id: 'uncalled-function-in-the-source-pin',
    source: `${HOLDER} let x: unknown; ({ x = methods.join } = { run: () => { ${REPLACED}; } }); void x;`,
    custom: true,
  },
  {
    id: 'quiet-call-in-the-source-replaces-the-method',
    source: `${HOLDER} let x: unknown; ({ x = methods.join } = ({ change: (${REPLACED}), quiet() { return 0; } }).quiet()); void x;`,
    custom: false,
  },
  {
    id: 'quiet-call-in-the-source-without-work-pin',
    source: `${HOLDER} let x: unknown; ({ x = methods.join } = ({ quiet() { return 0; } }).quiet()); void x;`,
    custom: true,
  },
  {
    id: 'write-after-the-pattern-pin',
    source: `${HOLDER} let x: unknown; ({ x = methods.join } = {}); void x; ${REPLACED};`,
    custom: true,
  },
  {
    id: 'write-before-the-pattern-pin',
    source: `${HOLDER} ${REPLACED}; let x: unknown; ({ x = methods.join } = {}); void x;`,
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

describe('a method proof read in a destructuring default', () => {
  it.each(METHODS)('$id', ({ source, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'destructuring-source-order.ts', source);
    const reads = nodesOf(parsed.sourceFile).filter((node): node is Expression => {
      return (
        isPropertyAccessExpression(node) &&
        node.getText() === 'methods.join' &&
        !(isBinaryExpression(node.parent) && node.parent.left === node)
      );
    });

    expect(reads).toHaveLength(1);
    expect(reads.map((each) => sourceArrayFunction(each))).toStrictEqual([custom]);
  });
});
