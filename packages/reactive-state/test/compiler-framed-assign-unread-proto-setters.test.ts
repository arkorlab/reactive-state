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
 * An earlier source's prototype the compile cannot read may hold a setter named `__proto__`, which
 * a later own `__proto__` entry, a computed or shorthand one, is then given in place of
 * `Object.prototype`'s. Its value stays possible, as the values of the other entries copied after
 * such a prototype do; the entry that installs the prototype, and a written `__proto__: value`,
 * which declares one and is no entry, are not given to it.
 */
const CASES = [
  {
    id: 'reviewed-computed-prototype-entry',
    source: "Object.assign({}, { ['__proto__']: proto }, { ['__proto__']: error })",
    sources: ['error:', 'error:output', 'proto:output'],
  },
  {
    id: 'shorthand-prototype-entry',
    source: "Object.assign({}, { ['__proto__']: proto }, { __proto__ })",
    sources: ['__proto__:', '__proto__:output', 'proto:output'],
  },
  {
    id: 'getter-prototype-entry',
    source:
      "Object.assign({}, { ['__proto__']: proto }, { get ['__proto__']() { return error; } })",
    sources: ['error:', 'error:output', 'proto:output'],
  },
  {
    id: 'unread-setter-key',
    source:
      "Object.assign({}, { ['__proto__']: { set [name](value: Error) {} } }, { ['__proto__']: error })",
    sources: ['error:', 'error:output'],
  },
  {
    id: 'installing-entry-pin',
    source: "Object.assign({}, { ['__proto__']: proto })",
    sources: ['proto:output'],
  },
  {
    id: 'written-declaration-pin',
    source: "Object.assign({}, { ['__proto__']: proto }, { __proto__: error })",
    sources: ['proto:output'],
  },
  {
    id: 'readable-prototype-without-setters-pin',
    source: "Object.assign({}, { ['__proto__']: { other: 1 } }, { ['__proto__']: error })",
    sources: ['error:output'],
  },
] as const;

describe('values of own __proto__ entries after a prototype the compile cannot read', () => {
  it.each(CASES)('$id', ({ source, sources }) => {
    expect(selected(source)).toStrictEqual([...sources].toSorted(compare));
  });
});

/** The sources field `output` of the assignment may be read from, in text order. */
function selected(source: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(
    api,
    'assign-unread-proto-setters.ts',
    `declare const error: Error; declare const __proto__: Error; declare const proto: object; declare const name: string; ${source};`,
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
