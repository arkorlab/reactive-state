import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString, framedArrayText } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A method written on an array belongs to that array: a name that is written as a whole, by an
 * assignment, a destructuring pattern or a loop head, may hold another array, and the proofs of
 * the first do not carry over. A name nothing writes as a whole keeps them.
 */
const SAFE = "a.join = () => 'safe';";

const CASES = [
  {
    id: 'reassigned-let',
    source: `function frames(error: Error) { let a = [error]; ${SAFE} a = [error]; return String(a); }`,
    converts: true,
  },
  {
    id: 'reassigned-by-pattern',
    source: `function frames(error: Error) { let a = [error]; ${SAFE} [a] = [[error]]; return String(a); }`,
    converts: true,
  },
  {
    id: 'reassigned-by-loop-head',
    source: `function frames(error: Error) { let a = [error]; ${SAFE} for (a of [[error]]); return String(a); }`,
    converts: true,
  },
  {
    id: 'reassigned-in-function',
    source: `function frames(error: Error) { let a = [error]; ${SAFE} const reset = () => { a = [error]; }; reset(); return String(a); }`,
    converts: true,
  },
  {
    id: 'alias-of-reassigned',
    source: `function frames(error: Error) { let a = [error]; const b = a; b.join = () => 'safe'; a = [error]; return String(b); }`,
    converts: true,
  },
  {
    id: 'never-reassigned-pin',
    source: `function frames(error: Error) { let a = [error]; ${SAFE} return String(a); }`,
    converts: false,
  },
  {
    id: 'constant-pin',
    source: `function frames(error: Error) { const a = [error]; ${SAFE} return String(a); }`,
    converts: false,
  },
  {
    id: 'other-name-reassigned-pin',
    source: `function frames(error: Error) { let a = [error]; let other = [1]; ${SAFE} other = [2]; return String(a); }`,
    converts: false,
  },
  {
    id: 'member-written-pin',
    source: `function frames(error: Error) { let a = [error]; ${SAFE} a.length = 1; return String(a); }`,
    converts: false,
  },
] as const;

describe('method proofs of an array whose name is written as a whole', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'reassigned-receivers.ts', source);

    expect(convertsError(parsed.sourceFile)).toBe(converts);
  });
});

/** Whether a native join, toString or String call in the source converts the `error` element. */
function convertsError(root: Node): boolean {
  const words = {
    error: (value: Expression, keys?: readonly string[]) => {
      const each = unwrapped(value);
      return (
        (keys === undefined || keys.length === 0) && isIdentifier(each) && each.text === 'error'
      );
    },
    typed: () => false,
  };
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedArrayText(node, words)) return true;
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'String' &&
      framedArrayString(node.arguments[0], words, node)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
