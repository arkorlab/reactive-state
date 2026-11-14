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
 * A `using` or an `await using` declaration runs its resource's disposal method where its scope is
 * left, whether by falling off the end, `break`, `return` or `throw`, and nothing is called there:
 * a resource that another module made, and that reaches an export of this one (`mutate`), can
 * replace a method before it is read after the scope (in Node the disposal ran, and `taken` was the
 * native `join`). A method proof does not survive such a declaration that stands before the read.
 * One that stands after it, in a function nothing has called, or a plain alias of the resource,
 * runs nothing before it. The coarse rule refuses a `using` before the read whatever it holds, a
 * `null` and a read inside its own block, where the disposal has not yet run, too.
 */
const HEAD =
  "import { resource } from './disposables'; const methods = { join() { return 'fixed'; } }; export function mutate() { methods.join = Array.prototype.join; } declare const flag: boolean;";
const LITERAL =
  "const methods = { join() { return 'fixed'; } }; const own = { [Symbol.dispose]() { methods.join = Array.prototype.join; } };";
const TAKEN = 'const taken = methods.join;';

const METHODS = [
  {
    id: 'reviewed-using-in-a-block',
    source: `${HEAD} { using held = resource; void held; } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'using-in-a-try',
    source: `${HEAD} try { using held = resource; void held; } finally {} ${TAKEN}`,
    custom: false,
  },
  {
    id: 'using-in-an-if',
    source: `${HEAD} if (flag) { using held = resource; void held; } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'using-in-a-switch-case',
    source: `${HEAD} switch (1) { case 1: { using held = resource; void held; } } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'using-in-a-while-left-by-a-break',
    source: `${HEAD} while (flag) { using held = resource; void held; break; } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'using-in-a-for-left-by-a-break',
    source: `${HEAD} for (;;) { using held = resource; void held; break; } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'using-in-a-function-called-first',
    source: `${HEAD} function scope() { using held = resource; void held; } scope(); ${TAKEN}`,
    custom: false,
  },
  {
    id: 'using-with-another-declaration-in-the-list',
    source: `${HEAD} { using held = resource, other = null; void held; void other; } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'await-using-at-the-top-level',
    source: `${HEAD} { await using held = resource; void held; } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'await-using-in-an-async-function-pin',
    source: `${HEAD} async function run() { { await using held = resource; void held; } ${TAKEN} void taken; } void run;`,
    custom: false,
  },
  {
    id: 'using-of-a-null',
    source: `${HEAD} { using held = null; void held; } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'using-before-a-read-inside-its-own-block',
    source: `${HEAD} { using held = resource; void held; ${TAKEN} void taken; }`,
    custom: false,
  },
  {
    id: 'using-of-a-literal-resource-pin',
    source: `${LITERAL} { using held = own; void held; } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'await-using-of-a-literal-resource-pin',
    source: `const methods = { join() { return 'fixed'; } }; const own = { [Symbol.asyncDispose]() { methods.join = Array.prototype.join; } }; { await using held = own; void held; } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'using-in-a-for-of-head-pin',
    source: `${HEAD} for (using held of [resource]) { void held; } ${TAKEN}`,
    custom: false,
  },
  {
    id: 'using-after-the-read-pin',
    source: `${HEAD} ${TAKEN} { using held = resource; void held; }`,
    custom: true,
  },
  {
    id: 'using-in-a-function-nothing-called-pin',
    source: `${HEAD} function unused() { using held = resource; void held; } void unused; ${TAKEN}`,
    custom: true,
  },
  {
    id: 'plain-alias-of-the-resource-pin',
    source: `${HEAD} const alias = resource; void alias; ${TAKEN}`,
    custom: true,
  },
  {
    id: 'no-declaration-pin',
    source: `${HEAD} ${TAKEN}`,
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

describe('a method proof past a declaration that disposes where its scope is left', () => {
  it.each(METHODS)('$id', ({ source, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'using-disposal-effects.ts', source);
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
