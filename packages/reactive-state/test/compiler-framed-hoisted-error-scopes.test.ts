import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Duplicate hoisted `var` declaration counts are scoped to their enclosing execution scope
 * (callable, accessor, constructor, static block, namespace, or module top level) so independent
 * functions declaring `var error: Error = new Error('fixed')` preserve their written-word proofs
 * while duplicate hoisted declarations within the same scope remain refused.
 */

const CASES = [
  {
    framed: false,
    id: 'two-sibling-functions-same-var-name-preserved',
    source: `function first() { var error: Error = new Error('one'); return error.message; } function second() { var error: Error = new Error('two'); return String(error); }`,
  },
  {
    framed: false,
    id: 'nested-function-shadowing-outer-var-name-preserved',
    source: `function outer() { var error: Error = new Error('outer'); function inner() { var error: Error = new TypeError('inner'); return error.message; } return error.message + inner(); }`,
  },
  {
    framed: false,
    id: 'two-arrow-functions-same-var-name-preserved',
    source: `const left = () => { var error: Error = new Error('left'); return String(error); }; const right = () => { var error: Error = new RangeError('right'); return error.message; };`,
  },
  {
    framed: false,
    id: 'class-methods-and-accessors-same-var-name-preserved',
    source: `class Formatter { get label() { var error: Error = new Error('getter'); return error.message; } read() { var error: Error = new Error('method'); return String(error); } }`,
  },
  {
    framed: false,
    id: 'two-class-static-blocks-same-var-name-preserved',
    source: `class Init { static a = ''; static b = ''; static { var error: Error = new Error('first'); Init.a = error.message; } static { var error: Error = new Error('second'); Init.b = String(error); } }`,
  },
  {
    framed: false,
    id: 'top-level-var-and-function-var-same-name-preserved',
    source: `var error: Error = new Error('module'); const top = error.message; function local() { var error: Error = new Error('local'); return error.message + top; }`,
  },
  {
    framed: false,
    id: 'two-namespaces-same-var-name-preserved',
    source: `namespace Alpha { var error: Error = new Error('alpha'); export const text = error.message; } namespace Beta { var error: Error = new Error('beta'); export const text = String(error); }`,
  },
  {
    framed: true,
    id: 'duplicate-var-same-function-scope-refused',
    source: `function text(external: Error) { var error: Error = new Error('fixed'); var error: Error = external; return error.message; }`,
  },
  {
    framed: true,
    id: 'duplicate-var-nested-if-block-same-function-refused',
    source: `function text(flag: boolean, external: Error) { var error: Error = new Error('fixed'); if (flag) { var error: Error = external; } return String(error); }`,
  },
  {
    framed: true,
    id: 'duplicate-var-top-level-module-scope-refused',
    source: `declare const external: Error; var error: Error = new Error('fixed'); { var error: Error = external; } export const label = error.message;`,
  },
  {
    framed: true,
    id: 'var-read-before-declaration-still-refused',
    source: `function text() { const early = String(error); var error: Error = new Error('fixed'); return early; }`,
  },
  {
    framed: true,
    id: 'var-reassigned-later-in-same-function-refused',
    source: `function text(external: Error) { var error: Error = new Error('fixed'); error = external; return error.message; }`,
  },
] as const;

describe('execution-scoped duplicate hoisted var tracking on annotated Error bindings', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'hoisted-error-scopes.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(framed);
  });
});

function readsFrames(root: Node): boolean {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isErased(node)) continue;
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
