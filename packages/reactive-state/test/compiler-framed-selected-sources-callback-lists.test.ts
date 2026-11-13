import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isSpreadElement,
  type Node,
  type SpreadElement,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { writtenList } from '../src/compiler/framed-selected-sources.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A native method that takes a callback hands the list it was called on to the callback as its
 * third argument (its fourth, for a reduction): a callback that can take it may change the list, so
 * the positions of its entries are the literal's only where none can, or where the method takes none.
 */
const HEAD = "const list: any[] = ['safe'];";

const CASES = [
  {
    id: 'for-each-with-the-array-parameter',
    source: `function frames() { ${HEAD} list.forEach((value, at, array) => { void array; }); return [...list]; }`,
    written: false,
  },
  {
    id: 'map-with-the-array-parameter',
    source: `function frames() { ${HEAD} list.map((value, at, array) => array.length); return [...list]; }`,
    written: false,
  },
  {
    id: 'filter-with-the-array-parameter',
    source: `function frames() { ${HEAD} list.filter((value, at, array) => array.length > 0); return [...list]; }`,
    written: false,
  },
  {
    id: 'some-with-the-array-parameter',
    source: `function frames() { ${HEAD} list.some((value, at, array) => array.length > 0); return [...list]; }`,
    written: false,
  },
  {
    id: 'every-with-the-array-parameter',
    source: `function frames() { ${HEAD} list.every((value, at, array) => array.length > 0); return [...list]; }`,
    written: false,
  },
  {
    id: 'find-with-the-array-parameter',
    source: `function frames() { ${HEAD} list.find((value, at, array) => array.length > 0); return [...list]; }`,
    written: false,
  },
  {
    id: 'find-index-with-the-array-parameter',
    source: `function frames() { ${HEAD} list.findIndex((value, at, array) => array.length > 0); return [...list]; }`,
    written: false,
  },
  {
    id: 'find-last-with-the-array-parameter',
    source: `function frames() { ${HEAD} list.findLast((value, at, array) => array.length > 0); return [...list]; }`,
    written: false,
  },
  {
    id: 'find-last-index-with-the-array-parameter',
    source: `function frames() { ${HEAD} list.findLastIndex((value, at, array) => array.length > 0); return [...list]; }`,
    written: false,
  },
  {
    id: 'flat-map-with-the-array-parameter',
    source: `function frames() { ${HEAD} list.flatMap((value, at, array) => [array.length]); return [...list]; }`,
    written: false,
  },
  {
    id: 'reduce-with-the-array-parameter',
    source: `function frames() { ${HEAD} list.reduce((total, value, at, array) => total + array.length, 0); return [...list]; }`,
    written: false,
  },
  {
    id: 'reduce-right-with-the-array-parameter',
    source: `function frames() { ${HEAD} list.reduceRight((total, value, at, array) => total + array.length, 0); return [...list]; }`,
    written: false,
  },
  {
    id: 'function-expression-with-the-array-parameter',
    source: `function frames() { ${HEAD} list.forEach(function (value, at, array) { void array; }); return [...list]; }`,
    written: false,
  },
  {
    id: 'callback-with-a-rest-parameter',
    source: `function frames() { ${HEAD} list.forEach((...given) => { void given; }); return [...list]; }`,
    written: false,
  },
  {
    id: 'callback-reading-arguments',
    source: `function frames() { ${HEAD} list.forEach(function () { void arguments[2]; }); return [...list]; }`,
    written: false,
  },
  {
    id: 'callback-given-by-a-name',
    source: `function frames() { ${HEAD} const handler = (value: unknown) => value; list.forEach(handler); return [...list]; }`,
    written: false,
  },
  {
    id: 'callbacks-given-by-a-spread',
    source: `function frames() { ${HEAD} const handlers = [(value: unknown) => value]; list.forEach(...handlers); return [...list]; }`,
    written: false,
  },
  {
    id: 'optional-call-with-the-array-parameter',
    source: `function frames() { ${HEAD} list?.forEach((value, at, array) => { void array; }); return [...list]; }`,
    written: false,
  },
  {
    id: 'callback-changing-the-list-by-its-name',
    source: `function frames() { ${HEAD} list.forEach((value) => { list.reverse(); void value; }); return [...list]; }`,
    written: false,
  },
  {
    id: 'for-each-with-the-value-pin',
    source: `function frames() { ${HEAD} list.forEach((value) => { void value; }); return [...list]; }`,
    written: true,
  },
  {
    id: 'for-each-with-the-index-pin',
    source: `function frames() { ${HEAD} list.forEach((value, at) => { void value; void at; }); return [...list]; }`,
    written: true,
  },
  {
    id: 'map-with-the-index-pin',
    source: `function frames() { ${HEAD} list.map((value, at) => at); return [...list]; }`,
    written: true,
  },
  {
    id: 'reduce-with-three-parameters-pin',
    source: `function frames() { ${HEAD} list.reduce((total, value, at) => total + at, 0); return [...list]; }`,
    written: true,
  },
  {
    id: 'for-each-with-no-callback-pin',
    source: `function frames() { ${HEAD} list.forEach(); return [...list]; }`,
    written: true,
  },
  {
    id: 'slice-pin',
    source: `function frames() { ${HEAD} list.slice(); return [...list]; }`,
    written: true,
  },
  {
    id: 'join-pin',
    source: `function frames() { ${HEAD} list.join(); return [...list]; }`,
    written: true,
  },
  {
    id: 'includes-pin',
    source: `function frames() { ${HEAD} list.includes(1); return [...list]; }`,
    written: true,
  },
  {
    id: 'sort-with-a-comparator-changes-the-list',
    source: `function frames() { ${HEAD} list.sort((left, right) => 0); return [...list]; }`,
    written: false,
  },
] as const;

const ASSIGNED =
  "function frames(error: any) { const a: any[] = ['safe']; const maps: PropertyDescriptorMap = {}; const list: any[] = [{ value: 'safe' }, { value: error }];";

const CONVERSIONS = [
  {
    id: 'callback-reverses-the-list-through-its-array-parameter',
    source: `${ASSIGNED} list.forEach((value, at, array) => { if (at === 0) array.reverse(); }); ({ 0: maps[0] } = list); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'callback-of-a-reduction-reverses-the-list',
    source: `${ASSIGNED} list.reduce((total, value, at, array) => { if (at === 0) array.reverse(); return total; }, 0); ({ 0: maps[0] } = list); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'callback-that-takes-no-array-pin',
    source: `${ASSIGNED} list.forEach((value, at) => { void value; void at; }); ({ 0: maps[0] } = list); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
] as const;

describe('a list a callback-taking method is called on', () => {
  it.each(CASES)('$id', ({ source, written }) => {
    expect(isWritten(source)).toBe(written);
  });
});

describe('an entry a callback moves in the list it is given', () => {
  it.each(CONVERSIONS)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** Whether the list the source spreads is read as its literal wrote it. */
function isWritten(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'callback-lists.ts', source);
  return writtenList(spreadOf(parsed.sourceFile).expression) !== undefined;
}

function spreadOf(root: Node): SpreadElement & { readonly expression: Expression } {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isSpreadElement(node) && isIdentifier(node.expression)) return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no spread of a name');
}

/** Whether the source's `String(array)` converts the `error` element. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'callback-lists.ts', source);
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
