import { type Expression, isIdentifier, isReturnStatement, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { writtenArrayElements } from '../src/compiler/framed-array-elements.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A source, a descriptor or a map of descriptors a native mutator reads is held by a constant whose
 * members may be assigned before the call: what the compile cannot read of it stays possible, and
 * what was assigned to its members is another value it may hold.
 */
const HEAD =
  "function frames(error: Error, make: () => any, flag: boolean, source: any) { const values: unknown[] = ['safe'];";

const CASES = [
  {
    id: 'assign-source-written-before',
    source: `${HEAD} const source: any = make(); source[1] = error; Object.assign(values, source); return values; }`,
    elements: ['error:', 'source:0', 'source:array'],
  },
  {
    id: 'assign-source-written-through-an-alias',
    source: `${HEAD} const source: any = make(); const same = source; same[1] = error; Object.assign(values, source); return values; }`,
    elements: ['error:', 'source:0', 'source:array'],
  },
  {
    id: 'assign-parameter-source-written-before',
    source: `${HEAD} source[1] = error; Object.assign(values, source); return values; }`,
    elements: ['error:', 'source:0', 'source:array'],
  },
  {
    id: 'assign-source-written-in-a-branch',
    source: `${HEAD} const source: any = make(); if (flag) source[1] = error; Object.assign(values, source); return values; }`,
    elements: ['error:', 'source:0', 'source:array'],
  },
  {
    id: 'assign-source-written-after-pin',
    source: `${HEAD} const source: any = make(); Object.assign(values, source); source[1] = error; return values; }`,
    elements: ['source:0', 'source:array'],
  },
  {
    id: 'assign-source-written-under-another-name-pin',
    source: `${HEAD} const source: any = make(); source.other = error; Object.assign(values, source); return values; }`,
    elements: ['source:0', 'source:array'],
  },
  {
    id: 'define-properties-map-written-before',
    source: `${HEAD} const map: any = make(); map[1] = { value: error }; Object.defineProperties(values, map); return values; }`,
    elements: ['error:', 'map:0.value'],
  },
  {
    id: 'define-property-descriptor-written-before',
    source: `${HEAD} const descriptor: any = make(); descriptor.value = error; Object.defineProperty(values, 1, descriptor); return values; }`,
    elements: ['descriptor:value', 'error:'],
  },
  {
    id: 'define-property-descriptor-getter-written-before',
    source: `${HEAD} const descriptor: any = make(); descriptor.get = () => error; Object.defineProperty(values, 1, descriptor); return values; }`,
    elements: ['descriptor:value', 'error:'],
  },
  {
    id: 'define-property-descriptor-written-after-pin',
    source: `${HEAD} const descriptor: any = make(); Object.defineProperty(values, 1, descriptor); descriptor.value = error; return values; }`,
    elements: ['descriptor:value'],
  },
] as const;

describe('the members assigned to what a native mutator reads', () => {
  it.each(CASES)('$id', ({ source, elements }) => {
    expect(writtenElements(source)).toStrictEqual(elements);
  });
});

/** The elements written to the returned array at any index, with their paths. */
function writtenElements(source: string): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(api, 'object-mutator-opaque-writes.ts', source);
  const read = returned(parsed.sourceFile);
  return writtenArrayElements(read, read)
    .map((each) => {
      const path = each.array === true ? 'array' : each.keys.join('.');
      return `${each.value.getText()}:${path}`;
    })
    .toSorted((left, right) => left.localeCompare(right));
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
