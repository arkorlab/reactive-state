import { type Expression, isCallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedKeyNames } from '../src/compiler/framed-keys.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The names a parameter's key may have are those its declared type allows, and an optional
 * parameter, written `key?: 'a' | 'b'`, is `undefined` too when the argument is left out: a read
 * by that key reads the member named `undefined`. A parameter that is required, one with a default,
 * which stands for the missing argument, and one declared with no type are as they were.
 */
const CASES = [
  {
    id: 'reviewed-optional-parameter',
    source: "function f(key?: 'sta' | 'stack') { return Reflect.get(new Error(), key); }",
    names: ['sta', 'stack', 'undefined'],
  },
  {
    id: 'optional-parameter-of-an-arrow',
    source: "const f = (key?: 'a' | 'b') => Reflect.get(new Error(), key); void f;",
    names: ['a', 'b', 'undefined'],
  },
  {
    id: 'optional-parameter-of-a-method',
    source: "class C { f(key?: 'a' | 'b') { return Reflect.get(new Error(), key); } } void C;",
    names: ['a', 'b', 'undefined'],
  },
  {
    id: 'optional-parameter-through-a-constant',
    source:
      "function f(key?: 'a' | 'b') { const picked = key; return Reflect.get(new Error(), picked); }",
    names: ['a', 'b', 'undefined'],
  },
  {
    id: 'optional-parameter-in-a-branch',
    source:
      "declare const flag: boolean; function f(key?: 'a' | 'b') { return Reflect.get(new Error(), flag ? key : 'c'); }",
    names: ['a', 'b', 'c', 'undefined'],
  },
  {
    id: 'required-parameter-pin',
    source: "function f(key: 'sta' | 'stack') { return Reflect.get(new Error(), key); }",
    names: ['sta', 'stack'],
  },
  {
    id: 'parameter-with-a-default-pin',
    source: "function f(key: 'sta' | 'stack' = 'sta') { return Reflect.get(new Error(), key); }",
    names: ['sta', 'stack'],
  },
  {
    id: 'parameter-of-no-type-pin',
    source: 'function f(key?) { return Reflect.get(new Error(), key); }',
    names: undefined,
  },
  {
    id: 'optional-parameter-of-a-type-with-undefined-pin',
    source: "function f(key?: 'a' | undefined) { return Reflect.get(new Error(), key); }",
    names: undefined,
  },
];

/** Orders names, so that the order the sources give them is no part of the answer. */
function compare(a: string, b: string): number {
  return a.localeCompare(b);
}

/** The key argument of the one `Reflect.get` call of `root`, by a walk of its tree. */
function keyArgument(root: Node): Expression {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isCallExpression(node) && node.expression.getText() === 'Reflect.get') {
      const [, key] = node.arguments;
      if (key !== undefined) return key;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no key');
}

describe('the names of a key that an optional parameter holds', () => {
  it.each(CASES)('$id', ({ source, names }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'optional-key-parameter.ts', source);
    const found = framedKeyNames(keyArgument(parsed.sourceFile));

    expect(found?.toSorted(compare)).toStrictEqual(names?.toSorted(compare));
  });
});
