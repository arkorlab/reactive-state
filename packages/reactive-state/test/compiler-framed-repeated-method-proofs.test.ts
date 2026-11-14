import {
  type Expression,
  isBinaryExpression,
  isFunctionDeclaration,
  isIdentifier,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { sourceArrayFunction, sourceArrayMethod } from '../src/compiler/framed-array-functions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A method read in a loop that passes again is read once more after the loop's later work: what
 * that work, or a function it may run, writes into the object the method is taken from — or hands
 * that object to — replaces it for the next pass. A holder the loop's body declares anew each pass,
 * a write after the loop, a read in the loop's initializer, a loop that passes once and a local
 * function nothing refers to leave the proof as it was.
 */
const HOLDER = "const methods = { join() { return 'fixed'; } };";
const TAKEN = 'const values = [error]; values.join = methods.join;';
const REPLACED = 'methods.join = Array.prototype.join;';
const ALONE = "function custom() { return 'fixed'; }";

/** A function of the parameters `error` and `more`, whose body is `body`. */
function framed(body: string): string {
  return `function frames(error: Error, more: boolean) { ${body} }`;
}

/** The reads of `methods.join`, taken as `sourceArrayFunction` takes them. */
const METHODS = [
  {
    id: 'reviewed-loop-later-replacement',
    source: framed(`${HOLDER} for (const each of [1, 2]) { void each; ${TAKEN} ${REPLACED} }`),
    custom: false,
  },
  {
    id: 'while-later-replacement',
    source: framed(`${HOLDER} while (more) { ${TAKEN} ${REPLACED} }`),
    custom: false,
  },
  {
    id: 'do-while-later-replacement',
    source: framed(`${HOLDER} do { ${TAKEN} ${REPLACED} } while (more);`),
    custom: false,
  },
  {
    id: 'outer-loop-later-replacement',
    source: framed(
      `${HOLDER} for (const a of [1, 2]) { void a; for (const b of [1, 2]) { void b; ${TAKEN} } ${REPLACED} }`,
    ),
    custom: false,
  },
  {
    id: 'inner-loop-later-replacement',
    source: framed(
      `for (const a of [1, 2]) { void a; ${HOLDER} for (const b of [1, 2]) { void b; ${TAKEN} ${REPLACED} } }`,
    ),
    custom: false,
  },
  {
    id: 'loop-runs-hoisted-writer',
    source: framed(
      `${HOLDER} for (const each of [1, 2]) { void each; ${TAKEN} replace(); } function replace() { ${REPLACED} }`,
    ),
    custom: false,
  },
  {
    id: 'loop-hands-the-holder-away',
    source: framed(
      `${HOLDER} for (const each of [1, 2]) { void each; ${TAKEN} keep(methods); } function keep(held: object) { return held; }`,
    ),
    custom: false,
  },
  {
    id: 'loop-writes-the-method-it-reads',
    source: framed(
      `${HOLDER} for (const each of [1, 2]) { void each; methods.join &&= Array.prototype.join; }`,
    ),
    custom: false,
  },
  {
    id: 'loop-calls-a-method-that-replaces-itself',
    source: framed(
      "const methods = { join() { (this as { join: unknown }).join = Array.prototype.join; return 'fixed'; } }; let text = ''; for (const each of [1, 2]) { void each; text = methods.join(','); } return text;",
    ),
    custom: false,
  },
  {
    id: 'loop-calls-its-own-method-pin',
    source: framed(
      `${HOLDER} let text = ''; for (const each of [1, 2]) { void each; ${TAKEN} text = values.join(','); } return text;`,
    ),
    custom: true,
  },
  {
    id: 'loop-calls-a-quiet-method-pin',
    source: framed(
      `${HOLDER} let text = ''; for (const each of [1, 2]) { void each; text = methods.join(); } return text;`,
    ),
    custom: true,
  },
  {
    id: 'holder-declared-each-pass-pin',
    source: framed(`for (const each of [1, 2]) { void each; ${HOLDER} ${TAKEN} ${REPLACED} }`),
    custom: true,
  },
  {
    id: 'holder-declared-each-outer-pass-pin',
    source: framed(
      `for (const a of [1, 2]) { void a; ${HOLDER} for (const b of [1, 2]) { void b; ${TAKEN} } }`,
    ),
    custom: true,
  },
  {
    id: 'replaced-after-loop-pin',
    source: framed(`${HOLDER} for (const each of [1, 2]) { void each; ${TAKEN} } ${REPLACED}`),
    custom: true,
  },
  {
    id: 'single-pass-pin',
    source: framed(`${HOLDER} for (const each of [1]) { void each; ${TAKEN} ${REPLACED} }`),
    custom: true,
  },
  {
    id: 'read-in-for-initializer-pin',
    source: framed(
      `${HOLDER} const values = [error]; for (let ok = (values.join = methods.join, true); ok; ok = false) { ${REPLACED} }`,
    ),
    custom: true,
  },
  {
    id: 'unreferenced-writer-after-loop-pin',
    source: framed(
      `${HOLDER} for (const each of [1, 2]) { void each; ${TAKEN} } function unused() { ${REPLACED} }`,
    ),
    custom: true,
  },
  {
    id: 'unreferenced-writer-before-loop-pin',
    source: framed(
      `${HOLDER} function unused() { ${REPLACED} } for (const each of [1, 2]) { void each; ${TAKEN} }`,
    ),
    custom: true,
  },
];

/** The reads of the function `custom`, a declaration the loop assigns or leaves. */
const FUNCTIONS = [
  {
    id: 'function-assigned-in-loop',
    source: framed(
      `${ALONE} for (const each of [1, 2]) { void each; const values = [error]; values.join = custom; custom = Array.prototype.join as never; }`,
    ),
    custom: false,
  },
  {
    id: 'function-assigned-by-hoisted-writer',
    source: framed(
      `${ALONE} for (const each of [1, 2]) { void each; const values = [error]; values.join = custom; swap(); } function swap() { custom = Array.prototype.join as never; }`,
    ),
    custom: false,
  },
  {
    id: 'function-left-in-loop-pin',
    source: framed(
      `${ALONE} for (const each of [1, 2]) { void each; const values = [error]; values.join = custom; }`,
    ),
    custom: true,
  },
  {
    id: 'function-assigned-after-loop-pin',
    source: framed(
      `${ALONE} for (const each of [1, 2]) { void each; const values = [error]; values.join = custom; } custom = Array.prototype.join as never;`,
    ),
    custom: true,
  },
];

/** The receivers of the patterns that take `join` of `methods`, as `sourceArrayMethod` takes them. */
const PATTERNS = [
  {
    id: 'pattern-in-loop-later-replacement',
    source: framed(
      `${HOLDER} for (const each of [1, 2]) { void each; const { join } = methods; void join; ${REPLACED} }`,
    ),
    custom: false,
  },
  {
    id: 'pattern-in-loop-then-called-by-the-holder',
    source: framed(
      "const methods = { join() { (this as { join: unknown }).join = Array.prototype.join; return 'fixed'; } }; let text = ''; for (const each of [1, 2]) { void each; const { join } = methods; void join; text = methods.join(','); } return text;",
    ),
    custom: false,
  },
  {
    id: 'pattern-in-loop-pin',
    source: framed(
      `${HOLDER} for (const each of [1, 2]) { void each; const { join } = methods; void join; }`,
    ),
    custom: true,
  },
  {
    id: 'pattern-outside-loop-pin',
    source: framed(`${HOLDER} const { join } = methods; void join;`),
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

/**
 * The reads of `method` in `root`, a member's or a function's name, but those a plain assignment
 * writes and the name a function declaration declares.
 */
function methodReads(root: Node, method: string): readonly Expression[] {
  return nodesOf(root).filter((node): node is Expression => {
    return (
      (isPropertyAccessExpression(node) || isIdentifier(node)) &&
      node.getText() === method &&
      !isPlainTarget(node) &&
      !isFunctionDeclaration(node.parent)
    );
  });
}

/** What each object pattern in `root` takes apart, where it is a variable's initializer. */
function patternReceivers(root: Node): readonly Expression[] {
  return nodesOf(root).flatMap((node) => {
    return isVariableDeclaration(node) &&
      isObjectBindingPattern(node.name) &&
      node.initializer !== undefined
      ? [node.initializer]
      : [];
  });
}

describe('a method proof a loop reads again', () => {
  it.each(METHODS)('$id', ({ source, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'repeated-method-proofs.ts', source);
    const reads = methodReads(parsed.sourceFile, 'methods.join');

    expect(reads).toHaveLength(1);
    expect(reads.map((each) => sourceArrayFunction(each))).toStrictEqual([custom]);
  });

  it.each(FUNCTIONS)('$id', ({ source, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'repeated-function-proofs.ts', source);
    const reads = methodReads(parsed.sourceFile, 'custom');

    expect(reads).toHaveLength(1);
    expect(reads.map((each) => sourceArrayFunction(each))).toStrictEqual([custom]);
  });

  it.each(PATTERNS)('$id', ({ source, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'repeated-pattern-proofs.ts', source);
    const receivers = patternReceivers(parsed.sourceFile);

    expect(receivers).toHaveLength(1);
    expect(receivers.map((each) => sourceArrayMethod(each, ['join']))).toStrictEqual([custom]);
  });
});
