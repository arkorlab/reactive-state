import { type Expression, isIdentifier, isReturnStatement, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { writtenArrayElements } from '../src/compiler/framed-array-elements.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A method that inserts into an array writes the array it is called on, and the expression that names
 * it may stand for any of several: a condition, a comma, a logical operand, an assignment, a call that
 * returns what it was called on. What it inserts is an element of each of them.
 */
const HEAD =
  "function frames(error: Error, flag: boolean) { const values: unknown[] = ['safe']; const other: unknown[] = [];";

const CASES = [
  {
    id: 'push-through-a-condition',
    source: `${HEAD} (flag ? values : other).push(error); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'push-through-a-condition-with-the-array-last',
    source: `${HEAD} (flag ? other : values).push(error); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'push-through-a-comma',
    source: `${HEAD} (0, values).push(error); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'push-through-a-logical-operand',
    source: `${HEAD} (flag && values).push(error); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'push-through-a-fallback',
    source: `${HEAD} (other || values).push(error); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'push-through-an-assignment',
    source: `${HEAD} let held: unknown[]; (held = values).push(error); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'push-through-the-result-of-a-fill',
    source: `${HEAD} values.fill(0).push(error); return values; }`,
    elements: ['0:', 'error:'],
  },
  {
    id: 'unshift-through-a-condition',
    source: `${HEAD} (flag ? values : other).unshift(error); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'splice-through-a-condition',
    source: `${HEAD} (flag ? values : other).splice(1, 0, error); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'fill-through-a-condition',
    source: `${HEAD} (flag ? values : other).fill(error); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'borrowed-push-through-a-condition',
    source: `${HEAD} Array.prototype.push.call(flag ? values : other, error); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'borrowed-push-through-a-comma',
    source: `${HEAD} Array.prototype.push.call((0, values), error); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'push-directly-pin',
    source: `${HEAD} values.push(error); return values; }`,
    elements: ['error:'],
  },
  {
    id: 'push-to-another-array-pin',
    source: `${HEAD} other.push(error); return values; }`,
    elements: [],
  },
  {
    id: 'push-through-a-condition-of-others-pin',
    source: `${HEAD} (flag ? other : []).push(error); return values; }`,
    elements: [],
  },
] as const;

describe('the elements a method inserts through an expression that may be the array', () => {
  it.each(CASES)('$id', ({ source, elements }) => {
    expect(writtenElements(source)).toStrictEqual(elements);
  });
});

/** The elements written to the returned array at any index, with their paths. */
function writtenElements(source: string): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(api, 'receiver-targets.ts', source);
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
