import { isExpressionStatement } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { flatMappedSourceIndex } from '../src/compiler/framed-array-flatten.ts';

/**
 * A native flatMap skips the holes of its receiver, so the element it makes at a position, counted
 * from the start or from the end, comes of the receiver's element at that position among those
 * the receiver holds: `[10, , 30]` has two, at 0 and 2, so the last of what it makes comes of the
 * one at 2. A position past those it holds comes of none, `Infinity`. The rows marked a pin answer
 * the same before the change as after it.
 */

const CASES = [
  { index: 0, receiver: '[10, , 30]', source: 0, what: 'the first' },
  { index: 1, receiver: '[10, , 30]', source: 2, what: 'the second, past a hole (pin)' },
  { index: 2, receiver: '[10, , 30]', source: Infinity, what: 'one past the last (pin)' },
  { index: -1, receiver: '[10, , 30]', source: 2, what: 'the last' },
  { index: -2, receiver: '[10, , 30]', source: 0, what: 'the one before the last' },
  { index: -3, receiver: '[10, , 30]', source: Infinity, what: 'one before the first' },
  { index: -1, receiver: '[10, 20]', source: 1, what: 'the last of no holes' },
  { index: -1, receiver: '[, 20]', source: 1, what: 'the last after a hole' },
  { index: -2, receiver: '[, 20]', source: Infinity, what: 'one before the first after a hole' },
  { index: -1, receiver: '[, ,]', source: Infinity, what: 'the last of holes alone (pin)' },
  { index: undefined, receiver: '[10, , 30]', source: undefined, what: 'none selected (pin)' },
  { index: -1, receiver: '[10, ...rest]', source: undefined, what: 'a spread (pin)' },
  { index: -1, receiver: 'items', source: 2, what: 'a constant that holds it' },
] as const;

describe('the receiver element a native flatMap’s element comes of', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The position `flatMappedSourceIndex` answers of `index` of `receiver`, after a constant `items`. */
  function sourceOf(receiver: string, index: number | undefined): number | undefined {
    using parsed = api.createSourceFile(
      'framed-array-flatten.ts',
      `declare const rest: number[]; const items = [10, , 30]; ${receiver};`,
    );
    const last = parsed.sourceFile.statements.at(-1);
    if (last === undefined || !isExpressionStatement(last)) {
      throw new Error(`No receiver ends ${receiver}.`);
    }
    return flatMappedSourceIndex(last.expression, index);
  }

  it.each(CASES)('$what', ({ index, receiver, source }) => {
    expect(sourceOf(receiver, index)).toBe(source);
  });
});
