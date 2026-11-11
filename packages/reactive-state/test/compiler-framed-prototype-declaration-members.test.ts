import { isExpressionStatement, type Expression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedObjectSources } from '../src/compiler/framed-object-members.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A literal's written `__proto__: value` sets its prototype and defines no own field, so a member
 * read of `__proto__` finds no own entry there: the read goes to the prototype's own `__proto__`
 * field, or else to `Object.prototype`'s getter, which returns the prototype itself. A computed,
 * shorthand or accessor `__proto__` defines an own field, which hides what it would inherit.
 */
const CASES = [
  {
    id: 'reviewed-prototype-own-field',
    source: "({ __proto__: { ['__proto__']: error } }).__proto__",
    sources: ['error:stack'],
  },
  {
    id: 'prototype-without-own-field',
    source: '({ __proto__: error }).__proto__',
    sources: ['error:__proto__.stack', 'error:stack'],
  },
  {
    id: 'string-spelled-declaration',
    source: "({ '__proto__': { ['__proto__']: error } }).__proto__",
    sources: ['error:stack'],
  },
  {
    id: 'computed-field-before-declaration',
    source: "({ ['__proto__']: other, __proto__: error }).__proto__",
    sources: ['other:stack'],
  },
  {
    id: 'nested-declaration',
    source: "({ __proto__: { __proto__: { ['__proto__']: error } } }).__proto__",
    sources: ['error:stack'],
  },
  {
    id: 'spread-declaration-is-no-entry',
    source: '({ ...{ __proto__: error } }).__proto__',
    sources: [],
  },
  {
    id: 'computed-own-field-pin',
    source: "({ ['__proto__']: error }).__proto__",
    sources: ['error:stack'],
  },
  {
    id: 'later-computed-field-pin',
    source: "({ __proto__: error, ['__proto__']: other }).__proto__",
    sources: ['other:stack'],
  },
  {
    id: 'shorthand-own-field-pin',
    source: '({ __proto__ }).__proto__',
    sources: ['__proto__:stack'],
  },
  {
    id: 'null-prototype-has-no-getter',
    source: '({ __proto__: null }).__proto__',
    sources: [],
  },
  {
    id: 'other-field-prototype-pin',
    source: '({ __proto__: { stack: error } }).stack',
    sources: ['error:'],
  },
] as const;

describe('member reads of a literal whose written prototype is no own field', () => {
  it.each(CASES)('$id', ({ id, source, sources }) => {
    expect(selected(id, source)).toStrictEqual(sources);
  });
});

/** The sources the statement's member read may select, `stack` still to read where it is not `.stack`. */
function selected(id: string, source: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(
    api,
    'prototype-declaration-members.ts',
    `declare const error: Error; declare const other: Error; ${source};`,
  );
  const node = statement(parsed.sourceFile);
  const keys = id === 'other-field-prototype-pin' ? [] : ['stack'];
  return framedObjectSources(node, keys)
    ?.map((each) => `${each.value.getText()}:${each.keys.join('.')}`)
    .toSorted((left, right) => left.localeCompare(right));
}

function statement(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isExpressionStatement(node) && !node.expression.getText().startsWith('declare'))
      return node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no statement');
}
