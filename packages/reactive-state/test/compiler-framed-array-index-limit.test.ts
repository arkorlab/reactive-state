import { type Expression, isIdentifier, isReturnStatement, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { writtenArrayElements } from '../src/compiler/framed-array-elements.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A key that is an integer past the greatest array index, 4294967294, names an ordinary property of
 * the array and no element: what is written to it is not joined, whether the key is a number or a
 * text, and whatever writes it.
 */
const HEAD = "function frames(error: Error, at: number) { const a: unknown[] = ['safe'];";

const CASES = [
  {
    id: 'number-key-past-the-last-index',
    source: `${HEAD} a[4294967295] = error; return a; }`,
    elements: [],
  },
  {
    id: 'text-key-past-the-last-index',
    source: `${HEAD} a['4294967295'] = error; return a; }`,
    elements: [],
  },
  {
    id: 'number-key-far-past-the-last-index',
    source: `${HEAD} a[9007199254740991] = error; return a; }`,
    elements: [],
  },
  {
    id: 'pattern-element-past-the-last-index',
    source: `${HEAD} [a[4294967295]] = [error]; return a; }`,
    elements: [],
  },
  {
    id: 'pattern-entry-past-the-last-index',
    source: `${HEAD} ({ x: a[4294967295] } = { x: error }); return a; }`,
    elements: [],
  },
  {
    id: 'loop-head-past-the-last-index',
    source: `${HEAD} for (a[4294967295] of [error]) { } return a; }`,
    elements: [],
  },
  {
    id: 'logical-write-past-the-last-index',
    source: `${HEAD} a[4294967295] ||= error; return a; }`,
    elements: [],
  },
  {
    id: 'last-index-pin',
    source: `${HEAD} a[4294967294] = error; return a; }`,
    elements: ['error:', 'error:'],
  },
  {
    id: 'text-last-index-pin',
    source: `${HEAD} a['4294967294'] = error; return a; }`,
    elements: ['error:', 'error:'],
  },
  {
    id: 'index-pin',
    source: `${HEAD} a[1] = error; return a; }`,
    elements: ['error:', 'error:'],
  },
  {
    id: 'unknown-key-pin',
    source: `${HEAD} a[at] = error; return a; }`,
    elements: ['error:', 'error:'],
  },
  {
    id: 'negative-key-pin',
    source: `${HEAD} a[-1] = error; return a; }`,
    elements: [],
  },
  {
    id: 'fraction-key-pin',
    source: `${HEAD} a[1.5] = error; return a; }`,
    elements: [],
  },
  {
    id: 'leading-zero-key-pin',
    source: `${HEAD} a['01'] = error; return a; }`,
    elements: [],
  },
  {
    id: 'native-mutator-past-the-last-index-pin',
    source: `${HEAD} Object.assign(a, { 4294967295: error }); return a; }`,
    elements: [],
  },
] as const;

describe('the elements written to an array past its last index', () => {
  it.each(CASES)('$id', ({ source, elements }) => {
    expect(writtenElements(source)).toStrictEqual(elements);
  });
});

/** The elements written to the returned array at any index, with their paths. */
function writtenElements(source: string): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(api, 'array-index-limit.ts', source);
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
