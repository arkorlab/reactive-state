import {
  type BinaryExpression,
  type Expression,
  isArrayLiteralExpression,
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
 * A whole constant alias of the array (`const alias = arr`) reads and replaces no entry, so the
 * declaration that makes it is no use of the array that loses the initial slot. That holds only
 * where nothing outside can write through the alias: an alias the module exports is one an
 * importing module writes through before it calls a function that tests the slot (`alias[0] = 0;
 * update()` runs `g()` in Node). The declaration is read as a use then, wherever the assignment
 * is; so is the declaration of an alias that a `for` statement holds.
 */
const DECLARATION = 'declare function g(): number;';

const CASES = [
  {
    id: 'exported-alias-in-an-exported-function',
    root: 'arr',
    source: `${DECLARATION} const arr = [1]; export const alias = arr; export function update() { arr[0] ||= g(); }`,
    skipped: false,
  },
  {
    id: 'exported-alias-of-an-and-assignment',
    root: 'arr',
    source: `${DECLARATION} const arr = [0]; export const alias = arr; export function update() { arr[0] &&= g(); }`,
    skipped: false,
  },
  {
    id: 'exported-alias-of-a-nullish-assignment',
    root: 'arr',
    source: `${DECLARATION} const arr = [{}]; export const alias = arr; export function update() { arr[0] ??= g(); }`,
    skipped: false,
  },
  {
    id: 'exported-alias-in-an-exported-arrow',
    root: 'arr',
    source: `${DECLARATION} const arr = [1]; export const alias = arr; export const update = () => { arr[0] ||= g(); };`,
    skipped: false,
  },
  {
    id: 'exported-alias-with-a-cast',
    root: 'arr',
    source: `${DECLARATION} const arr = [1]; export const alias = arr as number[]; export function update() { arr[0] ||= g(); }`,
    skipped: false,
  },
  {
    id: 'exported-alias-of-an-alias',
    root: 'arr',
    source: `${DECLARATION} const arr = [1]; const first = arr; export const second = first; export function update() { arr[0] ||= g(); }`,
    skipped: false,
  },
  {
    id: 'exported-alias-in-a-namespace',
    root: 'arr',
    source: `${DECLARATION} const arr = [1]; export namespace N { export const alias = arr; } export function update() { arr[0] ||= g(); }`,
    skipped: false,
  },
  {
    id: 'exported-alias-and-an-assignment-where-the-module-is-evaluated',
    root: 'arr',
    source: `${DECLARATION} const arr = [1]; export const alias = arr; arr[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'alias-held-by-a-for-statement',
    root: 'arr',
    source: `${DECLARATION} const arr = [1]; for (const alias = arr; ; ) { break; } arr[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'alias-in-an-export-clause-pin',
    root: 'arr',
    source: `${DECLARATION} const arr = [1]; const alias = arr; export { alias }; export function update() { arr[0] ||= g(); }`,
    skipped: false,
  },
  {
    id: 'exported-alias-of-a-let-pin',
    root: 'arr',
    source: `${DECLARATION} const arr = [1]; export let alias = arr; export function update() { arr[0] ||= g(); }`,
    skipped: false,
  },
  {
    id: 'exported-default-pin',
    root: 'arr',
    source: `${DECLARATION} const arr = [1]; export default arr; export function update() { arr[0] ||= g(); }`,
    skipped: false,
  },
  {
    id: 'exported-pattern-of-the-array-pin',
    root: 'arr',
    source: `${DECLARATION} const arr = [1]; export const [alias] = [arr]; export function update() { arr[0] ||= g(); }`,
    skipped: false,
  },
  {
    id: 'unexported-alias-pin',
    root: 'arr',
    source: `${DECLARATION} const arr = [1]; const alias = arr; export function update() { arr[0] ||= g(); }`,
    skipped: true,
  },
  {
    id: 'unexported-alias-of-an-alias-pin',
    root: 'arr',
    source: `${DECLARATION} const arr = [1]; const first = arr; const second = first; export function update() { arr[0] ||= g(); }`,
    skipped: true,
  },
  {
    id: 'alias-in-the-function-pin',
    root: 'arr',
    source: `${DECLARATION} const arr = [1]; export function update() { const alias = arr; arr[0] ||= g(); }`,
    skipped: true,
  },
  {
    id: 'alias-in-the-module-pin',
    root: 'arr',
    source: `${DECLARATION} const arr = [1]; const alias = arr; arr[0] ||= g();`,
    skipped: true,
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

/** The variable `name` the source declares. */
function variableNamed(root: Node, name: string): FrameBinding {
  for (const node of nodesOf(root))
    if (isVariableDeclaration(node) && isIdentifier(node.name) && node.name.text === name)
      return node;
  throw new Error(`no ${name}`);
}

/** The variable a name comes to by constant aliases, as the caller of the analysis follows it. */
function arrayVariable(node: Expression): FrameBinding | undefined {
  let value = unwrapped(node);
  let root: FrameBinding | undefined;
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || seen.has(selected.binding))
      return undefined;
    root = selected.binding;
    seen.add(root);
    if (root.initializer === undefined) return undefined;
    value = unwrapped(root.initializer);
  }
  return isArrayLiteralExpression(value) ? root : undefined;
}

describe('whether a logical assignment can skip its right side past the constant aliases of the array', () => {
  it.each(CASES)('$id', ({ source, root: name, skipped }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'logical-constant-aliases.ts', source);
    const write = logicalWrite(parsed.sourceFile);
    const root = variableNamed(parsed.sourceFile, name);

    expect(framedLogicalElementSkipped(write, root, (value) => arrayVariable(value) === root)).toBe(
      skipped,
    );
  });
});
