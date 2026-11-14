import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A selection reads each object once for each path it is asked at, and it is asked under the names the
 * rest copy it goes through was made without: two writes that leave out different fields of one
 * source are two selections of it, and what the first left out is what the second reads.
 */
const CASES = [
  {
    id: 'branch-without-the-safe-field-first',
    source: `function frames(error: Error, flag: boolean, name: string) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; const holder: any = {}; let ignored: unknown; const source = { bad: { get: () => error }, good: { value: 'safe' } }; if (flag) ({ good: ignored, ...holder.m } = source); else ({ bad: ignored, ...holder.m } = source); ({ m: { [name]: maps[0] } } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'branch-without-the-error-field-first',
    source: `function frames(error: Error, flag: boolean, name: string) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; const holder: any = {}; let ignored: unknown; const source = { bad: { get: () => error }, good: { value: 'safe' } }; if (flag) ({ bad: ignored, ...holder.m } = source); else ({ good: ignored, ...holder.m } = source); ({ m: { [name]: maps[0] } } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'branch-without-the-same-field-pin',
    source: `function frames(error: Error, flag: boolean, name: string) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; const holder: any = {}; let ignored: unknown; const source = { bad: { get: () => error }, good: { value: 'safe' } }; if (flag) ({ good: ignored, ...holder.m } = source); else ({ good: ignored, ...holder.m } = source); ({ m: { [name]: maps[0] } } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'branch-without-both-fields-pin',
    source: `function frames(error: Error, flag: boolean, name: string) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; const holder: any = {}; let ignored: unknown; const source = { bad: { get: () => error }, good: { value: 'safe' } }; if (flag) ({ good: ignored, bad: ignored, ...holder.m } = source); else ({ good: ignored, bad: ignored, ...holder.m } = source); ({ m: { [name]: maps[0] } } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'branch-without-nothing-and-the-error-field',
    source: `function frames(error: Error, flag: boolean, name: string) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; const holder: any = {}; let ignored: unknown; const source = { bad: { get: () => error }, good: { value: 'safe' } }; if (flag) ({ ...holder.m } = source); else ({ bad: ignored, ...holder.m } = source); ({ m: { [name]: maps[0] } } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'branch-without-the-error-field-and-nothing',
    source: `function frames(error: Error, flag: boolean, name: string) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; const holder: any = {}; let ignored: unknown; const source = { bad: { get: () => error }, good: { value: 'safe' } }; if (flag) ({ bad: ignored, ...holder.m } = source); else ({ ...holder.m } = source); ({ m: { [name]: maps[0] } } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
] as const;

describe('a rest copy of one source written in two branches', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** Whether the source's `String(array)` converts the `error` element. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'exclusion-coverage.ts', source);
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
