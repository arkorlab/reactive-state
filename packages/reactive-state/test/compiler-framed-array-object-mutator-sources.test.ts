import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isReturnStatement,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { writtenArrayElements } from '../src/compiler/framed-array-elements.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * What a native object mutator installs from a source the compile cannot read: at an unknown
 * position any element the source holds as an array or a tuple does, and a getter that answers
 * later installs a promise, which is no error.
 */
const VALUES = "const values: unknown[] = ['safe'];";

const ELEMENTS = [
  {
    id: 'assign-tuple-source',
    source: `function frames(pair: [string, Error]) { ${VALUES} Object.assign(values, pair); return values; }`,
    index: undefined,
    elements: ['pair:0', 'pair:array'],
  },
  {
    id: 'assign-spread-field-source',
    source: `function frames(pair: [string, Error]) { ${VALUES} Object.assign(values, { ...pair }); return values; }`,
    index: undefined,
    elements: ['pair:0', 'pair:array'],
  },
  {
    id: 'assign-tuple-source-at-index-pin',
    source: `function frames(pair: [string, Error]) { ${VALUES} Object.assign(values, pair); return values; }`,
    index: 1,
    elements: ['pair:1'],
  },
  {
    id: 'define-async-getter',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { async get() { return error; } }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-generator-getter-pin',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { *get() { yield error; } }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'assign-getter-constant-local',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { get 0() { const held = error; return held; } }); return values; }`,
    index: undefined,
    elements: ['held:'],
  },
  {
    id: 'define-getter-constant-local',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { get() { const held = error; return held; } }); return values; }`,
    index: undefined,
    elements: ['held:'],
  },
  {
    id: 'define-getter-pin',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { get() { return error; } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
] as const;

describe('elements native object mutators install from unread sources', () => {
  it.each(ELEMENTS)('$id', ({ source, index, elements }) => {
    expect(writtenElements(source, index)).toStrictEqual(elements);
  });
});

const CONVERSIONS = [
  {
    id: 'reviewed-assign-index-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { 0: error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-property-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(a, 0, { value: error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'tuple-source',
    source: `function frames(pair: [string, Error]) { const a = ['safe']; Object.assign(a, pair); return String(a); }`,
    converts: true,
  },
  {
    id: 'named-key-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { label: error }); return String(a); }`,
    converts: false,
  },
  {
    id: 'later-statement-pin',
    source: `function frames(error: Error) { const a = ['safe']; const text = String(a); Object.assign(a, { 0: error }); return text; }`,
    converts: false,
  },
] as const;

describe('text conversion of an array a native object mutator wrote an error to', () => {
  it.each(CONVERSIONS)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** The written elements of the returned array at the index, with their paths. */
function writtenElements(source: string, index: number | undefined): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(api, 'object-mutator-sources.ts', source);
  const read = returned(parsed.sourceFile);
  return writtenArrayElements(read, read, index).map((each) => {
    const path = each.array === true ? 'array' : each.keys.join('.');
    return `${each.value.getText()}:${path}`;
  });
}

function returned(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isReturnStatement(node) && node.expression !== undefined && isIdentifier(node.expression))
      return node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no returned name');
}

/** Whether the source's `String(array)` converts the `error` element or a tuple of `pair`. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'object-mutator-conversions.ts', source);
  const words = {
    error: (value: Expression, keys?: readonly string[]) => {
      const each = unwrapped(value);
      return (
        (keys === undefined || keys.length === 0) && isIdentifier(each) && each.text === 'error'
      );
    },
    typed: (value: Expression) => {
      const each = unwrapped(value);
      return isIdentifier(each) && each.text === 'pair';
    },
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
