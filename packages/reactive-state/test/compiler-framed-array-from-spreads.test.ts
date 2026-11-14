import { isElementAccessExpression, type Expression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedArrayFromResult } from '../src/compiler/framed-array-from-results.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A spread in the source of a native `Array.from` shifts every position written after it by a
 * length the compile does not know, and leaves the length itself unknown: an element written after
 * a spread may be the one a selector names, and a selector past the written elements may name a
 * mapped one. Positions before the first spread stay exact. A spread that may supply the selected
 * input is taken for an error, as the written elements after it are, where the program might read
 * an error out of it: that refuses more, never less.
 */
const CASES = [
  {
    id: 'spread-leading-error',
    source: 'Array.from([...[new Error()], 0], (value) => value)[0]',
    error: true,
  },
  {
    id: 'spread-pair-before-error',
    source: 'Array.from([...[0, 0], new Error()], (value) => value)[2]',
    error: true,
  },
  {
    id: 'empty-spread-before-error',
    source: 'Array.from([...[], new Error()], (value) => value)[0]',
    error: true,
  },
  {
    id: 'spread-then-element-past-written',
    source: 'Array.from([0, ...[1, 2], new Error()], (value) => value)[3]',
    error: true,
  },
  {
    id: 'spread-mapped-error-past-written',
    source: 'Array.from([...[1, 2, 3]], () => new Error())[2]',
    error: true,
  },
  {
    id: 'spread-over-refuses-the-reviewed-example',
    source: 'Array.from([...[0, 0], new Error()], (value) => value)[1]',
    error: true,
  },
  {
    id: 'exact-slot-before-spread-error',
    source: 'Array.from([new Error(), ...[0]], (value) => value)[0]',
    error: true,
  },
  {
    id: 'exact-slot-before-spread-not-error',
    source: 'Array.from([0, ...[1], new Error()], (value) => value)[0]',
    error: false,
  },
  {
    id: 'spread-mapper-ignores-input',
    source: "Array.from([0, ...[1]], () => 'safe')[1]",
    error: false,
  },
  {
    id: 'no-spread-error-slot',
    source: 'Array.from([0, new Error()], (value) => value)[1]',
    error: true,
  },
  {
    id: 'no-spread-other-slot',
    source: 'Array.from([0, new Error()], (value) => value)[0]',
    error: false,
  },
  {
    id: 'no-spread-past-written',
    source: 'Array.from([0, new Error()], (value) => value)[2]',
    error: false,
  },
  {
    id: 'no-spread-mapped-past-written',
    source: 'Array.from([0, 1], () => new Error())[2]',
    error: false,
  },
] as const;

describe('native Array.from selections past a spread', () => {
  it.each(CASES)('$id', ({ source, error }) => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'array-from-spreads.ts',
      `function frames() { return ${source}; }`,
    );
    const access = elementAccess(parsed.sourceFile);
    const found = framedArrayFromResult(access, [], (value) => isNewError(value));

    expect(found).toBe(error);
  });
});

/** The stand-in for the reader's error check: a written `new Error()`. */
function isNewError(value: Expression): boolean {
  return value.getText().startsWith('new Error(');
}

function elementAccess(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isElementAccessExpression(node)) return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no element access');
}
