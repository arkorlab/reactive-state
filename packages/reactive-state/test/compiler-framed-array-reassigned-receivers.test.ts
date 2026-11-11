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
  {
    id: 'alias-write-then-reassigned',
    source: `function frames(error: Error) { const a = [error]; ${SAFE} let b = a; b.join = Array.prototype.join; b = []; return String(a); }`,
    converts: true,
  },
  {
    id: 'alias-definition-then-reassigned',
    source: `function frames(error: Error) { const a = [error]; ${SAFE} let b = a; Object.defineProperty(b, 'join', { value: Array.prototype.join }); b = []; return String(a); }`,
    converts: true,
  },
  {
    id: 'alias-assignment-then-reassigned',
    source: `function frames(error: Error) { const a = [error]; ${SAFE} let b = a; Object.assign(b, { join: Array.prototype.join }); b = []; return String(a); }`,
    converts: true,
  },
  {
    id: 'alias-deletion-then-reassigned',
    source: `function frames(error: Error) { const a = [error]; ${SAFE} let b = a; delete b.join; b = []; return String(a); }`,
    converts: true,
  },
  {
    id: 'alias-pattern-target-then-reassigned',
    source: `function frames(error: Error) { const a = [error]; ${SAFE} let b = a; [b.join] = [Array.prototype.join]; b = []; return String(a); }`,
    converts: true,
  },
  {
    id: 'alias-assigned-later',
    source: `function frames(error: Error) { const a = [error]; ${SAFE} let b: any[] = []; b = a; b.join = Array.prototype.join; return String(a); }`,
    converts: true,
  },
  {
    id: 'alias-of-reassigned-writes',
    source: `function frames(error: Error) { let a = [error]; ${SAFE} const b = a; b.join = Array.prototype.join; a = []; return String(b); }`,
    converts: true,
  },
  {
    id: 'unrelated-reassigned-name-write-refused',
    source: `function frames(error: Error) { const a = [error]; ${SAFE} let other = [1]; other.join = Array.prototype.join; other = [2]; return String(a); }`,
    converts: true,
  },
  {
    id: 'alias-redefinition-keeps-accessor-held',
    source: `function frames(error: Error) { const a = [error]; Object.defineProperty(a, 'join', { get() { return Array.prototype.join; }, configurable: true }); let b = [1]; Object.defineProperty(b, 'join', { value: () => 'x' }); b = []; ${SAFE} return String(a); }`,
    converts: true,
  },
  {
    id: 'alias-deletion-keeps-accessor-held',
    source: `function frames(error: Error) { const a = [error]; Object.defineProperty(a, 'join', { get() { return Array.prototype.join; }, configurable: true }); let b = [1]; delete b.join; b = []; ${SAFE} return String(a); }`,
    converts: true,
  },
  {
    id: 'redefinition-releases-accessor-pin',
    source: `function frames(error: Error) { const a = [error]; Object.defineProperty(a, 'join', { get() { return Array.prototype.join; }, configurable: true }); Object.defineProperty(a, 'join', { value: Array.prototype.join, writable: true }); ${SAFE} return String(a); }`,
    converts: false,
  },
  {
    id: 'var-redeclared-by-loop-head',
    source: `function frames(error: Error) { var a = [error]; ${SAFE} for (var a of [[error]]); return String(a); }`,
    converts: true,
  },
  {
    id: 'var-redeclared-with-initializer',
    source: `function frames(error: Error) { var a = [error]; ${SAFE} var a = [error]; return String(a); }`,
    converts: true,
  },
  {
    id: 'var-redeclared-by-pattern',
    source: `function frames(error: Error) { var a = [error]; ${SAFE} var [a] = [[error]]; return String(a); }`,
    converts: true,
  },
  {
    id: 'var-redeclared-by-for-initializer',
    source: `function frames(error: Error) { var a = [error]; ${SAFE} for (var a = [error]; false; ); return String(a); }`,
    converts: true,
  },
  {
    id: 'var-redeclared-in-nested-block',
    source: `function frames(error: Error) { var a = [error]; ${SAFE} if (error) { var a = [error]; } return String(a); }`,
    converts: true,
  },
  {
    id: 'var-redeclared-without-initializer-pin',
    source: `function frames(error: Error) { var a = [error]; ${SAFE} var a; return String(a); }`,
    converts: false,
  },
  {
    id: 'block-scoped-loop-head-pin',
    source: `function frames(error: Error) { const a = [error]; ${SAFE} for (const a of [[error]]); return String(a); }`,
    converts: false,
  },
  {
    id: 'block-scoped-shadow-pin',
    source: `function frames(error: Error) { const a = [error]; ${SAFE} { const a = [error]; } return String(a); }`,
    converts: false,
  },
  {
    id: 'alias-never-reassigned-pin',
    source: `function frames(error: Error) { const a = [error]; ${SAFE} const b = a; b.join = Array.prototype.join; return String(a); }`,
    converts: true,
  },
  {
    id: 'unrelated-stable-name-write-pin',
    source: `function frames(error: Error) { const a = [error]; ${SAFE} const other = [1]; other.join = Array.prototype.join; return String(a); }`,
    converts: false,
  },
  {
    id: 'whole-write-only-pin',
    source: `function frames(error: Error) { const a = [error]; ${SAFE} let b = a; b = []; return String(a); }`,
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
