import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A rest copy given whole to another reader keeps the names the pattern left out of it: the
 * descriptor map entry a member holds is the copy, and the fields it lists are not in it.
 */
const HEAD =
  "function frames(error: Error) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; const holder: any = {}; let x: unknown; let y: unknown;";

const CASES = [
  {
    id: 'map-entry-copy-without-the-getter',
    source: `${HEAD} ({ '': x, get: y, ...holder.m } = { get: () => error }); ({ m: maps[0] } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'map-entry-copy-with-the-getter-pin',
    source: `${HEAD} ({ '': x, ...holder.m } = { get: () => error }); ({ m: maps[0] } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'map-entry-copy-without-another-field-pin',
    source: `${HEAD} ({ other: y, ...holder.m } = { get: () => error }); ({ m: maps[0] } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'map-entry-copy-without-the-value',
    source: `${HEAD} ({ value: y, ...holder.m } = { value: error }); ({ m: maps[0] } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'map-entry-copy-without-the-value-keeps-the-getter-pin',
    source: `${HEAD} ({ value: y, ...holder.m } = { value: 'safe', get: () => error }); ({ m: maps[0] } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'map-entry-copy-of-a-copy-without-the-getter',
    source: `${HEAD} const inner: any = {}; ({ get: y, ...inner.m } = { get: () => error }); ({ ...holder.m } = inner.m); ({ m: maps[0] } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
] as const;

describe('a rest copy a descriptor map entry is', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** Whether the source's `String(array)` converts the `error` element. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'selected-sources-rest-whole.ts', source);
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
