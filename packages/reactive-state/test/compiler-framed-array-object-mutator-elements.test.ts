import { type Expression, isIdentifier, isReturnStatement, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { writtenArrayElements } from '../src/compiler/framed-array-elements.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * `Object.assign`, `Object.defineProperty` and `Object.defineProperties` install values on an
 * array's numeric keys as its elements: a written index carries its value, an opaque key or source
 * keeps its value possible, and another key installs no element.
 */
const VALUES = "const values: unknown[] = ['safe'];";

const CASES = [
  {
    id: 'reviewed-assign-index',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { 0: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-text-index',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { '1': error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-opaque-key',
    source: `function frames(error: Error, key: string) { ${VALUES} Object.assign(values, { [key]: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-getter',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { get 0() { return error; } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-opaque-source',
    source: `function frames(source: Record<number, Error>) { ${VALUES} Object.assign(values, source); return values; }`,
    index: 0,
    elements: ['source:0'],
  },
  {
    id: 'assign-array-source',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, [error]); return values; }`,
    index: undefined,
    elements: ['[error]:array'],
  },
  {
    id: 'define-index',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { value: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-getter',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, '0', { get() { return error; } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-many',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties(values, { 0: { value: error } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'other-index-pin',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { 0: error }); return values; }`,
    index: 1,
    elements: [],
  },
  {
    id: 'named-key-pin',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { label: error }); Object.defineProperty(values, 'label', { value: error }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'other-target-pin',
    source: `function frames(error: Error) { ${VALUES} const other: unknown[] = []; Object.assign(other, { 0: error }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'shadowed-object-pin',
    source: `function frames(error: Error, Object: { assign(...args: unknown[]): void }) { ${VALUES} Object.assign(values, { 0: error }); return values; }`,
    index: undefined,
    elements: [],
  },
] as const;

describe('array elements native object mutators install', () => {
  it.each(CASES)('$id', ({ source, index, elements }) => {
    expect(writtenElements(source, index)).toStrictEqual(elements);
  });
});

/** The written elements of the returned array at the index, with their paths. */
function writtenElements(source: string, index: number | undefined): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(api, 'object-mutator-elements.ts', source);
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
