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
 * A setter named `__proto__` that an installed prototype holds is called with the value of a later
 * own `__proto__` entry, a computed or shorthand one: a written `__proto__: value` declares a
 * prototype and is no entry to copy. The value of such an entry is passed to the setter only where
 * an earlier source's prototype answers `__proto__`, and the entry that installs a prototype is
 * never passed to that prototype's own setter.
 */
const SETTER =
  '{ set ["__proto__"](value: Error) { (this as { output?: Error }).output = value; } }';
const OTHER = '{ set input(value: Error) { (this as { output?: Error }).output = value; } }';

const CASES = [
  {
    id: 'reviewed-computed-prototype-entry',
    source: `Object.assign({}, { ['__proto__']: ${SETTER} }, { ['__proto__']: error })`,
    sources: ['error:', 'error:output'],
  },
  {
    id: 'shorthand-prototype-entry',
    source: `Object.assign({}, { ['__proto__']: ${SETTER} }, { __proto__ })`,
    sources: ['__proto__:', '__proto__:output'],
  },
  {
    id: 'getter-prototype-entry',
    source: `Object.assign({}, { ['__proto__']: ${SETTER} }, { get ['__proto__']() { return error; } })`,
    sources: ['error:', 'error:output'],
  },
  {
    id: 'setter-of-another-key-pin',
    source: `Object.assign({}, { ['__proto__']: ${OTHER} }, { ['__proto__']: error })`,
    sources: ['error:output'],
  },
  {
    id: 'written-declaration-pin',
    source: `Object.assign({}, { ['__proto__']: ${SETTER} }, { __proto__: error })`,
    sources: [],
  },
  {
    id: 'installing-entry-pin',
    source: `Object.assign({}, { ['__proto__']: ${SETTER} })`,
    sources: [],
  },
] as const;

describe('values of own __proto__ entries a setter named __proto__ is called with', () => {
  it.each(CASES)('$id', ({ source, sources }) => {
    expect(selected(source)).toStrictEqual([...sources].toSorted(compare));
  });
});

/** The sources field `output` of the assignment may be read from, in text order. */
function selected(source: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(
    api,
    'assign-proto-named-setters.ts',
    `declare const error: Error; declare const __proto__: Error; ${source};`,
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
