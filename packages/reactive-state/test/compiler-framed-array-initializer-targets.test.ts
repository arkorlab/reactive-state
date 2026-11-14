import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A native mutator written in the initializer of an array (`const list = Object.assign([], { 0: error })`)
 * writes the array the binding then holds: the literal it is given is the binding's own, and what the
 * call installs there, and the methods it defines, are followed as for a mutator that names the binding.
 */
const CASES = [
  {
    id: 'assign-in-the-initializer',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const list = Object.assign([], { 0: error }); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-in-the-initializer-with-a-number-key',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const list = Object.assign(['safe', 'x'], { 1: error }); return String(list); }`,
    converts: true,
  },
  {
    id: 'define-property-in-the-initializer',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const list = Object.defineProperty(['safe'], 1, { value: error }); return String(list); }`,
    converts: true,
  },
  {
    id: 'define-properties-in-the-initializer',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const list = Object.defineProperties(['safe'], { 1: { value: error } }); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-in-the-initializer-through-a-cast',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const list = Object.assign([] as unknown[], { 0: error }); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-in-the-initializer-through-a-bound-call',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const list = Object.assign.call(null, [], { 0: error }); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-in-the-initializer-twice',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const list = Object.assign(Object.assign([], {}), { 0: error }); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-in-the-initializer-through-an-alias',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const list = Object.assign([], { 0: error }); const same = list; return String(same); }`,
    converts: true,
  },
  {
    id: 'assign-in-the-initializer-with-an-opaque-source',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const list = Object.assign([], opaque()); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-in-the-initializer-with-a-written-source-refused',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const list = Object.assign([], { 0: 'safe' }); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-to-a-named-array-pin',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const list: unknown[] = []; Object.assign(list, { 0: error }); return String(list); }`,
    converts: true,
  },
  {
    id: 'assign-in-the-initializer-to-another-array-refused',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const other: unknown[] = []; Object.assign(other, { 0: error }); const list = Object.assign([], { 0: 'safe' }); return String(list); }`,
    converts: true,
  },
  {
    id: 'fill-in-the-initializer',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const list = ['safe'].fill(error); return String(list); }`,
    converts: true,
  },
  {
    id: 'setter-swallowed-assignment-after-an-initializer-definition',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const values = Object.defineProperty([], 'join', { get() { return Array.prototype.join; }, set(_: unknown) {} }); values.join = () => 'safe'; values[0] = error; return String(values); }`,
    converts: true,
  },
  {
    id: 'setter-swallowed-assignment-after-an-initializer-define-properties',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const values = Object.defineProperties([], { join: { get() { return Array.prototype.join; }, set(_: unknown) {} } }); values.join = () => 'safe'; values[0] = error; return String(values); }`,
    converts: true,
  },
  {
    id: 'setter-swallowed-assignment-after-an-initializer-definition-through-a-cast',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const values = Object.defineProperty([] as unknown[], 'join', { get() { return Array.prototype.join; }, set(_: unknown) {} }); values.join = () => 'safe'; values[0] = error; return String(values); }`,
    converts: true,
  },
  {
    id: 'assignment-after-an-initializer-definition-of-a-plain-method',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const values = Object.defineProperty([], 'join', { value: () => 'x', writable: true }); values.join = () => 'safe'; values[0] = error; return String(values); }`,
    converts: true,
  },
  {
    id: 'custom-method-given-in-the-initializer',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const values = Object.assign([], { join: () => 'safe' }); values[0] = error; return String(values); }`,
    converts: true,
  },
  {
    id: 'custom-method-given-in-the-initializer-then-restored',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const values = Object.assign([], { join: () => 'safe' }); values.join = Array.prototype.join; values[0] = error; return String(values); }`,
    converts: true,
  },
  {
    id: 'custom-method-given-in-the-initializer-then-deleted',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const values = Object.assign([], { join: () => 'safe' }); delete (values as any).join; values[0] = error; return String(values); }`,
    converts: true,
  },
  {
    id: 'custom-method-given-in-the-initializer-then-an-opaque-write',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const values = Object.assign([], { join: () => 'safe' }); Object.assign(values, opaque()); values[0] = error; return String(values); }`,
    converts: true,
  },
  {
    id: 'native-method-given-in-the-initializer-then-custom-refused',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const values = Object.assign([], { join: Array.prototype.join }); values.join = () => 'safe'; values[0] = error; return String(values); }`,
    converts: true,
  },
  {
    id: 'definition-in-the-initializer-of-another-array-refused',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const other = Object.defineProperty([], 'join', { get() { return Array.prototype.join; }, set(_: unknown) {} }); const values: unknown[] = []; values.join = () => 'safe'; values[0] = error; void other; return String(values); }`,
    converts: true,
  },
  {
    id: 'custom-method-given-in-the-initializer-through-a-bound-call',
    source: `function frames(error: Error, flag: boolean, opaque: () => object) { const values = Object.assign.call(null, [], { join: () => 'safe' }); values.join = Array.prototype.join; values[0] = error; return String(values); }`,
    converts: true,
  },
] as const;

describe('a mutator written in the initializer of the array it writes', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** Whether the source's `String(array)` converts the `error` element. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'initializer-targets.ts', source);
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
