import { isCallExpression, isReturnStatement, type Expression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedObjectSources } from '../src/compiler/framed-object-members.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * `Object.assign` copies each own source entry with `Set`, and an empty target inherits
 * `Object.prototype`'s `__proto__` setter: an own `__proto__` entry of a source becomes the target's
 * prototype, which the target's other fields are then read from. A literal's written `__proto__`
 * sets that literal's own prototype and is no entry to copy.
 */
const CASES = [
  {
    id: 'reviewed-computed-prototype-entry',
    source:
      "function frames(error: Error) { return Object.assign({}, { ['__proto__']: { 0: error } }); }",
    sources: ['error:'],
  },
  {
    id: 'shorthand-prototype-entry',
    source:
      'function frames(error: Error) { const __proto__ = { 0: error }; return Object.assign({}, { __proto__ }); }',
    sources: ['__proto__:0'],
  },
  {
    id: 'opaque-key-entry',
    source:
      'function frames(error: Error, key: string) { return Object.assign({}, { [key]: { 0: error } }); }',
    sources: ['{ 0: error }:', 'error:'],
  },
  {
    id: 'later-field-kept-possible',
    source:
      "function frames(error: Error) { return Object.assign({}, { ['__proto__']: { 0: error } }, { 0: 'fixed' }); }",
    sources: ["'fixed':", 'error:'],
  },
  {
    id: 'written-literal-prototype-pin',
    source:
      'function frames(error: Error) { return Object.assign({}, { __proto__: { 0: error } }); }',
    sources: [],
  },
  {
    id: 'spread-literal-prototype-pin',
    source:
      'function frames(error: Error) { return Object.assign({}, { ...{ __proto__: { 0: error } } }); }',
    sources: [],
  },
  {
    id: 'own-field-pin',
    source: 'function frames(error: Error) { return Object.assign({}, { 0: error }); }',
    sources: ['error:'],
  },
] as const;

describe('assigned entries the empty target prototype setter takes', () => {
  it.each(CASES)('$id', ({ source, sources }) => {
    expect(firstField(source)).toStrictEqual(sources);
  });
});

/** The sources field `0` of the returned assignment may be read from, in text order. */
function firstField(source: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'assign-prototype-setter.ts', source);
  return framedObjectSources(returned(parsed.sourceFile), ['0'])
    ?.map((each) => `${each.value.getText()}:${each.keys.join('.')}`)
    .toSorted((left, right) => left.localeCompare(right));
}

function returned(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isReturnStatement(node) &&
      node.expression !== undefined &&
      isCallExpression(node.expression)
    )
      return node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no returned call');
}
