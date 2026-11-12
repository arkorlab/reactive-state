import {
  isCallExpression,
  isExpressionStatement,
  type Expression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedObjectSources } from '../src/compiler/framed-object-members.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A source's own `__proto__` entry becomes the empty assign target's prototype, and each source
 * copied after it is written with `Set`, which meets a setter of that prototype: the setter runs
 * with the copied value and may store it under any key. Where the prototype is not shown to have no
 * setter, the value of each entry copied after it is a possible value of any field.
 */
const SETTER = '{ set input(value: Error) { (this as { output?: Error }).output = value; } }';

const CASES = [
  {
    id: 'reviewed-setter-writes-another-field',
    source: `Object.assign({}, { ['__proto__']: ${SETTER} }, { input: error })`,
    sources: ['error:'],
  },
  {
    id: 'setter-in-prototype-of-prototype',
    source: `Object.assign({}, { ['__proto__']: { __proto__: ${SETTER} } }, { input: error })`,
    sources: ['error:'],
  },
  {
    id: 'unread-prototype',
    source: "Object.assign({}, { ['__proto__']: made }, { input: error })",
    sources: ['error:', 'made:output'],
  },
  {
    id: 'same-source-after-prototype',
    source: `Object.assign({}, { ['__proto__']: ${SETTER}, input: error })`,
    sources: ['error:'],
  },
  {
    id: 'every-later-entry',
    source: `Object.assign({}, { ['__proto__']: ${SETTER} }, { input: error, other, get third() { return error; } })`,
    sources: ['error:', 'error:', 'other:'],
  },
  {
    id: 'getter-only-prototype-pin',
    source: "Object.assign({}, { ['__proto__']: { get input() { return 1; } } }, { input: error })",
    sources: [],
  },
  {
    id: 'data-prototype-pin',
    source: "Object.assign({}, { ['__proto__']: { input: 1 } }, { input: error })",
    sources: [],
  },
  {
    id: 'source-before-prototype-pin',
    source: `Object.assign({}, { input: error }, { ['__proto__']: ${SETTER} })`,
    sources: [],
  },
  {
    id: 'no-prototype-pin',
    source: 'Object.assign({}, { input: error }, { other: error })',
    sources: [],
  },
] as const;

describe('values copied after an assigned prototype that may hold a setter', () => {
  it.each(CASES)('$id', ({ source, sources }) => {
    expect(selected(source)).toStrictEqual([...sources].toSorted(compare));
  });
});

/** The sources field `output` of the assignment may be read from, in text order. */
function selected(source: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(
    api,
    'assign-intercepted-copies.ts',
    `declare const error: Error; declare const other: Error; declare const made: object; ${source};`,
  );
  return framedObjectSources(statement(parsed.sourceFile), ['output'])
    ?.map((each) => `${each.value.getText()}:${each.keys.join('.')}`)
    .toSorted(compare);
}

function compare(left: string, right: string): number {
  return left.localeCompare(right);
}

function statement(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isExpressionStatement(node) && isCallExpression(node.expression)) return node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no assignment');
}
