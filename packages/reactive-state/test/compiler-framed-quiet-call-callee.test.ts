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
 * A call that runs a written body doing nothing leaves a method's holder as it found it, but only
 * that body is quiet: a callee that selects the method from an object literal written in place
 * evaluates that literal's other members first, and those can replace the method read afterwards.
 * A literal of nothing but data and methods, and a method of a holder declared apart, leave the
 * proof as it was.
 */
const HOLDER = "const methods = { join() { return 'fixed'; } };";
const TAKEN = 'const taken = methods.join;';
const REPLACED = 'methods.join = Array.prototype.join';

const METHODS = [
  {
    id: 'reviewed-initializer-in-callee-literal',
    source: `${HOLDER} ({ change: (${REPLACED}), quiet() { return 0; } }).quiet(); ${TAKEN}`,
    custom: false,
  },
  {
    id: 'initializer-in-callee-element-access',
    source: `${HOLDER} ({ change: (${REPLACED}), quiet() { return 0; } })['quiet'](); ${TAKEN}`,
    custom: false,
  },
  {
    id: 'initializer-in-nested-callee-literal',
    source: `${HOLDER} ({ inner: { quiet() { return 0; } }, change: (${REPLACED}) }).inner.quiet(); ${TAKEN}`,
    custom: false,
  },
  {
    id: 'initializer-in-inner-callee-literal',
    source: `${HOLDER} ({ inner: { change: (${REPLACED}), quiet() { return 0; } } }).inner.quiet(); ${TAKEN}`,
    custom: false,
  },
  {
    id: 'computed-key-in-callee-literal',
    source: `${HOLDER} ({ [(${REPLACED}, 'change')]: 1, quiet() { return 0; } }).quiet(); ${TAKEN}`,
    custom: false,
  },
  {
    id: 'spread-in-callee-literal',
    source: `${HOLDER} ({ ...(${REPLACED}, {}), quiet() { return 0; } }).quiet(); ${TAKEN}`,
    custom: false,
  },
  {
    id: 'call-in-callee-literal',
    source: `${HOLDER} function swap() { ${REPLACED}; } ({ change: swap(), quiet() { return 0; } }).quiet(); ${TAKEN}`,
    custom: false,
  },
  {
    id: 'callee-literal-method-only-pin',
    source: `${HOLDER} ({ quiet() { return 0; } }).quiet(); ${TAKEN}`,
    custom: true,
  },
  {
    id: 'callee-literal-data-pin',
    source: `${HOLDER} ({ label: 'x', size: 2, quiet() { return 0; } }).quiet(); ${TAKEN}`,
    custom: true,
  },
  {
    id: 'callee-literal-function-member-pin',
    source: `${HOLDER} ({ other: () => { ${REPLACED}; }, quiet() { return 0; } }).quiet(); ${TAKEN}`,
    custom: true,
  },
  {
    id: 'callee-literal-element-access-pin',
    source: `${HOLDER} ({ quiet() { return 0; } })['quiet'](); ${TAKEN}`,
    custom: true,
  },
  {
    id: 'callee-nested-literal-pin',
    source: `${HOLDER} ({ inner: { quiet() { return 0; } } }).inner.quiet(); ${TAKEN}`,
    custom: true,
  },
  {
    id: 'holder-declared-apart-pin',
    source: `${HOLDER} const quiet = { run() { return 0; } }; quiet.run(); ${TAKEN}`,
    custom: true,
  },
  {
    id: 'called-function-declaration-pin',
    source: `${HOLDER} function quiet() { return 0; } quiet(); ${TAKEN}`,
    custom: true,
  },
  {
    id: 'unused-setter-in-callee-literal',
    source: `${HOLDER} ({ set replace(value) { methods.join = value; }, quiet() { return 0; } }).quiet(); ${TAKEN}`,
    custom: true,
  },
  {
    id: 'unused-setter-of-another-object',
    source: `${HOLDER} const settings = { set replace(value) { methods.join = value; } }; void settings; ${TAKEN}`,
    custom: true,
  },
  {
    id: 'setter-computed-name-in-callee-literal-pin',
    source: `${HOLDER} ({ set [(${REPLACED}, 'x')](value) { void value; }, quiet() { return 0; } }).quiet(); ${TAKEN}`,
    custom: false,
  },
  {
    id: 'setter-called-by-an-assignment-pin',
    source: `${HOLDER} const settings = { set replace(value) { methods.join = value; } }; settings.replace = Array.prototype.join; ${TAKEN}`,
    custom: false,
  },
  {
    id: 'setter-called-through-a-call-pin',
    source: `${HOLDER} const settings = { set replace(value) { methods.join = value; } }; Object.assign(settings, { replace: Array.prototype.join }); ${TAKEN}`,
    custom: false,
  },
  {
    id: 'setter-called-by-a-loop-target-pin',
    source: `${HOLDER} const settings = { set replace(value) { methods.join = value; } }; for (settings.replace of [Array.prototype.join]) { void settings; } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'setter-of-a-method-read-in-another-function-pin',
    source: `${HOLDER} const settings = { set replace(value) { methods.join = value; } }; void settings; function read() { return methods.join; }`,
    custom: false,
  },
  {
    id: 'callee-literal-after-the-read-pin',
    source: `${HOLDER} ${TAKEN} ({ change: (${REPLACED}), quiet() { return 0; } }).quiet();`,
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

/** The reads of `methods.join` in `root`, but those a plain assignment writes. */
function methodReads(root: Node): readonly Expression[] {
  return nodesOf(root).filter((node): node is Expression => {
    return (
      isPropertyAccessExpression(node) && node.getText() === 'methods.join' && !isPlainTarget(node)
    );
  });
}

describe('a method proof past a quiet call', () => {
  it.each(METHODS)('$id', ({ source, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'quiet-call-callee.ts', source);
    const reads = methodReads(parsed.sourceFile);

    expect(reads).toHaveLength(1);
    expect(reads.map((each) => sourceArrayFunction(each))).toStrictEqual([custom]);
  });
});
