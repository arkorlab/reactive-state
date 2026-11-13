import { type Expression, isIdentifier, isReturnStatement, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { writtenArrayElements } from '../src/compiler/framed-array-elements.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The arguments of `Object.defineProperty` after the target are the key and the descriptor, and a
 * spread of them may be empty: the descriptor may be the second place of a later spread as well as
 * of the first, and the first place of a later one where those before it hold the key alone.
 */
const VALUES = "const values: unknown[] = ['safe'];";

const CASES = [
  {
    id: 'two-spreads',
    source: `function frames(a: number[], b: [PropertyKey, PropertyDescriptor]) { ${VALUES} Object.defineProperty(values, ...a, ...b); return values; }`,
    elements: ['a:1.value', 'b:0.value', 'b:1.value'],
  },
  {
    id: 'three-spreads',
    source: `function frames(a: number[], b: number[], c: [PropertyKey, PropertyDescriptor]) { ${VALUES} Object.defineProperty(values, ...a, ...b, ...c); return values; }`,
    elements: ['a:1.value', 'b:0.value', 'b:1.value', 'c:0.value', 'c:1.value'],
  },
  {
    id: 'two-spreads-then-a-descriptor',
    source: `function frames(error: Error, keys: [number], more: PropertyDescriptor[]) { ${VALUES} Object.defineProperty(values, ...keys, ...more, { value: error }); return values; }`,
    elements: ['keys:1.value', 'more:0.value', 'more:1.value', 'error:'],
  },
  {
    id: 'one-spread-pin',
    source: `function frames(a: [PropertyKey, PropertyDescriptor]) { ${VALUES} Object.defineProperty(values, ...a); return values; }`,
    elements: ['a:1.value'],
  },
  {
    id: 'spread-after-a-written-key-pin',
    source: `function frames(b: PropertyDescriptor[]) { ${VALUES} Object.defineProperty(values, 0, ...b); return values; }`,
    elements: ['b:0.value'],
  },
  {
    id: 'spread-after-a-written-argument-and-a-spread-pin',
    source: `function frames(a: number[], b: PropertyDescriptor[]) { ${VALUES} Object.defineProperty(values, ...a, 0, ...b); return values; }`,
    elements: ['a:1.value', '0:value', 'b:0.value'],
  },
] as const;

describe('the descriptor of a definition among spread arguments', () => {
  it.each(CASES)('$id', ({ source, elements }) => {
    expect(writtenElements(source)).toStrictEqual(elements);
  });
});

/** The written elements of the returned array at any index, with their paths. */
function writtenElements(source: string): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(api, 'object-mutator-spread-slots.ts', source);
  const read = returned(parsed.sourceFile);
  return writtenArrayElements(read, read).map((each) => {
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
