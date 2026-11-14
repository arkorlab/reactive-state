import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * An assignment of a function installs an own method only where no setter of the array's prototype
 * takes it: `a.join = fn` and `Object.assign(a, { join: fn })` set, and a setter the prototype has
 * runs in their place. Where the file may give the array another prototype (it names `__proto__` or
 * `setPrototypeOf`) the assignment is no proof; a definition creates the property whatever the
 * prototype has.
 */
const PROTO =
  '{ __proto__: Array.prototype, get join() { return Array.prototype.join; }, set join(_: unknown) {} }';

const CASES = [
  {
    id: 'direct-write-after-set-prototype-of',
    source: `function frames(error: Error) { const a: unknown[] = [error]; Object.setPrototypeOf(a, ${PROTO}); a.join = () => 'safe'; return String(a); }`,
    converts: true,
  },
  {
    id: 'direct-write-after-a-proto-assignment',
    source: `function frames(error: Error) { const a: unknown[] = [error]; (a as any).__proto__ = ${PROTO}; a.join = () => 'safe'; return String(a); }`,
    converts: true,
  },
  {
    id: 'direct-write-after-reflect-set-prototype-of',
    source: `function frames(error: Error) { const a: unknown[] = [error]; Reflect.setPrototypeOf(a, ${PROTO}); a.join = () => 'safe'; return String(a); }`,
    converts: true,
  },
  {
    id: 'direct-write-through-an-element-access',
    source: `function frames(error: Error) { const a: unknown[] = [error]; Object.setPrototypeOf(a, ${PROTO}); a['join'] = () => 'safe'; return String(a); }`,
    converts: true,
  },
  {
    id: 'direct-write-of-a-non-callable-value',
    source: `function frames(error: Error) { const a: unknown[] = [error]; Object.setPrototypeOf(a, ${PROTO}); a.join = 1; return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-after-set-prototype-of',
    source: `function frames(error: Error) { const a: unknown[] = [error]; Object.setPrototypeOf(a, ${PROTO}); Object.assign(a, { join: () => 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-of-a-method-after-set-prototype-of',
    source: `function frames(error: Error) { const a: unknown[] = [error]; Object.setPrototypeOf(a, ${PROTO}); Object.assign(a, { join() { return 'safe'; } }); return String(a); }`,
    converts: true,
  },
  {
    id: 'direct-write-before-set-prototype-of-is-no-proof-either',
    source: `function frames(error: Error) { const a: unknown[] = [error]; a.join = () => 'safe'; Object.setPrototypeOf(a, ${PROTO}); return String(a); }`,
    converts: true,
  },
  {
    id: 'direct-write-with-no-prototype-change-pin',
    source: `function frames(error: Error) { const a: unknown[] = [error]; a.join = () => 'safe'; return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-with-no-prototype-change-refused',
    source: `function frames(error: Error) { const a: unknown[] = [error]; Object.assign(a, { join: () => 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-of-a-method-with-no-prototype-change-refused',
    source: `function frames(error: Error) { const a: unknown[] = [error]; Object.assign(a, { join() { return 'safe'; } }); return String(a); }`,
    converts: true,
  },
  {
    id: 'definition-after-set-prototype-of-stays-refused-with-the-mention-pin',
    source: `function frames(error: Error) { const a: unknown[] = [error]; Object.setPrototypeOf(a, ${PROTO}); Object.defineProperty(a, 'join', { value: () => 'safe' }); return String(a); }`,
    converts: true,
  },
] as const;

describe('an own method an assignment installs', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** Whether the source's `String(array)` converts the `error` element. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'inherited-setters.ts', source);
  const words = {
    error: (value: Expression, keys?: readonly string[]) => {
      const each = unwrapped(value);
      return (
        (keys === undefined || keys.length === 0) && isIdentifier(each) && each.text === 'error'
      );
    },
    typed: () => false,
  };
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
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
