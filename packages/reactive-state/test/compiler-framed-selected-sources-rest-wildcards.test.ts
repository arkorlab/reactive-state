import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A key for any field of a rest copy asks the fields the copy has, and the pattern that made it left
 * some out: a field read by a name the code computes is not one of those either, as one read by its
 * name is not. The names are for the first step only; a field of a field is no copy.
 */
const HEAD =
  "function frames(error: Error, name: string) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; const holder: any = {}; let y: unknown;";

const CASES = [
  {
    id: 'wildcard-read-of-a-copy-without-the-getter-field',
    source: `${HEAD} ({ get: y, ...holder.m } = { get: { get: () => error }, other: { value: 'safe' } }); ({ m: { [name]: maps[0] } } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'wildcard-read-of-a-copy-of-a-copy-without-the-getter-field',
    source: `${HEAD} const inner: any = {}; ({ get: y, ...inner.m } = { get: { get: () => error }, other: { value: 'safe' } }); ({ ...holder.m } = inner.m); ({ m: { [name]: maps[0] } } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'wildcard-read-of-a-copy-without-the-getter-field-through-a-spread',
    source: `${HEAD} ({ get: y, ...holder.m } = { ...{ get: { get: () => error } }, other: { value: 'safe' } }); ({ m: { [name]: maps[0] } } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'wildcard-read-of-a-copy-without-the-getter-field-in-two-writes',
    source: `${HEAD} ({ get: y, ...holder.m } = { other: { value: 'safe' } }); ({ get: y, ...holder.m } = { get: { get: () => error } }); ({ m: { [name]: maps[0] } } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'wildcard-read-of-a-copy-without-another-field-pin',
    source: `${HEAD} ({ other: y, ...holder.m } = { get: { get: () => error }, other: { value: 'safe' } }); ({ m: { [name]: maps[0] } } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'wildcard-read-of-a-copy-finds-no-getter-in-the-field-below',
    source: `${HEAD} ({ other: y, ...holder.m } = { get: { other: { get: () => error } } }); ({ m: { [name]: maps[0] } } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'wildcard-read-below-the-excluded-name-pin',
    source: `${HEAD} ({ get: y, ...holder.m } = { other: { get: { get: () => error } } }); ({ m: { [name]: { [name]: maps[0] } } } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'named-read-of-the-excluded-field-pin',
    source: `${HEAD} ({ get: y, ...holder.m } = { get: { get: () => error }, other: { value: 'safe' } }); ({ m: { get: maps[0] } } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'wildcard-read-of-a-source-that-is-no-copy-pin',
    source: `${HEAD} ({ m: holder.m } = { m: { get: { get: () => error }, other: { value: 'safe' } } }); ({ m: { [name]: maps[0] } } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
] as const;

describe('a field a computed key reads of a rest copy', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** Whether the source's `String(array)` converts the `error` element. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'rest-wildcards.ts', source);
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
