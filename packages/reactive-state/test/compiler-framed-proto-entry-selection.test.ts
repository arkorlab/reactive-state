import { type Expression, isVariableDeclaration, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { sourceArrayFunction } from '../src/compiler/framed-array-functions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * In an object literal, `__proto__: value` — written as a name or as text, not computed — sets the
 * object's prototype and defines no own property, so a read of `methods.__proto__` is the
 * prototype's accessor answering, which the prototype can change by an accessor of its own: it is
 * no member the literal holds, and a method selected through it is no source proof. A computed
 * `['__proto__']: value` and a method named `__proto__` are own members, and every other member of
 * a literal that has a `__proto__` entry is selected as before.
 */
const CASES = [
  {
    id: 'reviewed-prototype-with-an-accessor-of-its-own',
    source:
      "const methods = { __proto__: { join() { return 'custom'; }, get __proto__() { return Array.prototype; } } }; const taken = methods.__proto__.join;",
    custom: false,
  },
  {
    id: 'prototype-entry-selected-by-name',
    source:
      "const methods = { __proto__: { join() { return 'custom'; } } }; const taken = methods.__proto__.join;",
    custom: false,
  },
  {
    id: 'prototype-entry-written-as-text',
    source:
      "const methods = { '__proto__': { join() { return 'custom'; } } }; const taken = methods.__proto__.join;",
    custom: false,
  },
  {
    id: 'prototype-entry-of-a-nested-literal',
    source:
      "const methods = { inner: { __proto__: { join() { return 'custom'; } } } }; const taken = methods.inner.__proto__.join;",
    custom: false,
  },
  {
    id: 'prototype-entry-selected-by-an-element-access',
    source:
      "const methods = { __proto__: { join() { return 'custom'; } } }; const taken = methods['__proto__'].join;",
    custom: false,
  },
  {
    id: 'computed-prototype-member-pin',
    source:
      "const methods = { ['__proto__']: { join() { return 'custom'; } } }; const taken = methods.__proto__.join;",
    custom: true,
  },
  {
    id: 'method-named-prototype-pin',
    source:
      "const methods = { __proto__() { return 'custom'; } }; const taken = methods.__proto__;",
    custom: true,
  },
  {
    id: 'own-member-beside-a-prototype-entry-pin',
    source:
      "const base = { join() { return 'base'; } }; const methods = { __proto__: base, join() { return 'own'; } }; const taken = methods.join;",
    custom: true,
  },
  {
    id: 'shorthand-prototype-member-pin',
    source:
      "const __proto__ = { join() { return 'custom'; } }; const methods = { __proto__ }; const taken = methods.__proto__.join;",
    custom: false,
  },
  {
    id: 'plain-member-pin',
    source: "const methods = { join() { return 'fixed'; } }; const taken = methods.join;",
    custom: true,
  },
];

/** Every node of `root`'s tree. */
function nodesOf(root: Node): readonly Node[] {
  const nodes: Node[] = [];
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    nodes.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return nodes;
}

/** The initializer of `taken`, the read the proof is of. */
function takenRead(root: Node): Expression {
  for (const node of nodesOf(root))
    if (
      isVariableDeclaration(node) &&
      node.name.getText() === 'taken' &&
      node.initializer !== undefined
    )
      return node.initializer;
  throw new Error('no taken');
}

describe('a method selected through a `__proto__` entry of a literal', () => {
  it.each(CASES)('$id', ({ source, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'proto-entry-selection.ts', source);
    const read = takenRead(parsed.sourceFile);

    expect(sourceArrayFunction(read)).toBe(custom);
  });
});
