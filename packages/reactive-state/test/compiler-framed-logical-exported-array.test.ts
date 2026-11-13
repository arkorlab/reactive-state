import {
  type BinaryExpression,
  type Expression,
  isBinaryExpression,
  isElementAccessExpression,
  isIdentifier,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedLogicalElementSkipped } from '../src/compiler/framed-array-logical-writes.ts';
import { type FrameBinding, frameBindingOf } from '../src/compiler/framed-bindings.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A logical assignment tests the slot it reads, and skips its right side only while that slot is
 * the one the array was written with. An array exported where it is declared (`export const arr =
 * [1]`) is one an importing module can write to before it calls a function that tests it: an
 * assignment in a function, or in any body that runs later, does not skip. One that runs where the
 * module is evaluated, one in a body called where it is written, and an array that is not exported,
 * leave the slot as written.
 */
const DECLARATION = 'declare function g(): number;';

const CASES = [
  {
    id: 'reviewed-or-assignment-in-an-exported-function',
    source: `${DECLARATION} export const arr = [1]; export function update() { arr[0] ||= g(); }`,
    skipped: false,
  },
  {
    id: 'or-assignment-in-an-unexported-function-of-an-exported-array',
    source: `${DECLARATION} export const arr = [1]; function update() { arr[0] ||= g(); } void update;`,
    skipped: false,
  },
  {
    id: 'and-assignment-in-an-exported-function',
    source: `${DECLARATION} export const arr = [0]; export function update() { arr[0] &&= g(); }`,
    skipped: false,
  },
  {
    id: 'nullish-assignment-in-an-exported-function',
    source: `${DECLARATION} export const arr = [1]; export function update() { arr[0] ??= g(); }`,
    skipped: false,
  },
  {
    id: 'assignment-in-an-arrow',
    source: `${DECLARATION} export const arr = [1]; export const update = () => { arr[0] ||= g(); };`,
    skipped: false,
  },
  {
    id: 'assignment-in-a-method',
    source: `${DECLARATION} export const arr = [1]; export const holder = { update() { arr[0] ||= g(); } };`,
    skipped: false,
  },
  {
    id: 'assignment-in-a-class-method',
    source: `${DECLARATION} export const arr = [1]; export class Updater { update() { arr[0] ||= g(); } }`,
    skipped: false,
  },
  {
    id: 'assignment-where-the-module-is-evaluated-pin',
    source: `${DECLARATION} export const arr = [1]; arr[0] ||= g();`,
    skipped: true,
  },
  {
    id: 'assignment-in-a-function-called-where-it-is-written-pin',
    source: `${DECLARATION} export const arr = [1]; (() => { arr[0] ||= g(); })();`,
    skipped: true,
  },
  {
    id: 'assignment-in-a-function-of-an-array-that-is-not-exported-pin',
    source: `${DECLARATION} const arr = [1]; export function update() { arr[0] ||= g(); }`,
    skipped: true,
  },
  {
    id: 'assignment-in-a-function-of-an-array-in-an-export-clause-pin',
    source: `${DECLARATION} const arr = [1]; export { arr }; export function update() { arr[0] ||= g(); }`,
    skipped: false,
  },
];

const LOGICAL: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

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

/** The logical assignment of an element of `root`, the one such. */
function logicalWrite(root: Node): BinaryExpression {
  const writes = nodesOf(root).filter((node): node is BinaryExpression => {
    return (
      isBinaryExpression(node) &&
      LOGICAL.has(node.operatorToken.kind) &&
      isElementAccessExpression(unwrapped(node.left))
    );
  });
  const [write] = writes;
  if (write === undefined || writes.length !== 1) throw new Error('no single logical write');
  return write;
}

/** The binding `arr` the source declares. */
function arrayBinding(root: Node): FrameBinding {
  for (const node of nodesOf(root))
    if (isVariableDeclaration(node) && isIdentifier(node.name) && node.name.text === 'arr')
      return node;
  throw new Error('no arr');
}

describe('whether a logical assignment can skip its right side in an array that the module exports', () => {
  it.each(CASES)('$id', ({ source, skipped }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'logical-exported-array.ts', source);
    const write = logicalWrite(parsed.sourceFile);
    const root = arrayBinding(parsed.sourceFile);
    const same = (value: Expression): boolean => {
      const name = unwrapped(value);
      return isIdentifier(name) && frameBindingOf(name)?.binding === root;
    };

    expect(framedLogicalElementSkipped(write, root, same)).toBe(skipped);
  });
});
