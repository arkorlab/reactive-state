import { type Expression, isCallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedKeyNames } from '../src/compiler/framed-keys.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A `var` can be declared again, in the same scope, in a block, a `for` head, a `switch` case or a
 * `catch` block, and each declaration of it that has a value writes it: `var key = 'sta'; var key =
 * 'stack';` reads `'stack'` (in Node the hook saw it). The key's names are then not those of its
 * first initializer and of the assignments to it alone: the names its declared type allows are
 * possible too, beside what the declarations write. So are they for a redeclaration in a loop head
 * (`for (var key of …)`, `for (var key in …)`) or a pattern (`var { key } = …`), which write what
 * no expression of the key's own does; the coarse rule keeps them for a redeclaration without a
 * value as well. A `var` of another function, a `let` of a block, a parameter that a `var` names
 * again (its declared names are kept as it is) and a key declared once leave the names as before.
 */
const GET = 'Reflect.get(new Error(), key);';
const KEY = "var key: 'sta' | 'stack' = 'sta';";

const CASES = [
  {
    id: 'reviewed-var-declared-twice',
    source: `${KEY} var key: 'sta' | 'stack' = 'stack'; ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'var-declared-twice-the-other-way',
    source: `var key: 'sta' | 'stack' = 'stack'; var key: 'sta' | 'stack' = 'sta'; ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'var-declared-three-times',
    source: `var key: 'a' | 'b' | 'c' = 'a'; var key: 'a' | 'b' | 'c' = 'b'; var key: 'a' | 'b' | 'c' = 'c'; ${GET}`,
    names: ['a', 'b', 'c'],
  },
  {
    id: 'var-declared-in-a-block',
    source: `${KEY} { var key: 'sta' | 'stack' = 'stack'; } ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'var-declared-in-a-for-head',
    source: `${KEY} for (var key: 'sta' | 'stack' = 'stack'; false; ) {} ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'var-declared-in-a-for-of-head',
    source: `${KEY} for (var key of ['stack']) {} ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'var-declared-in-a-for-in-head',
    source: `declare const holder: object; ${KEY} for (var key in holder) {} ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'var-declared-in-a-catch-block',
    source: `${KEY} try { throw 0; } catch (error) { var key: 'sta' | 'stack' = 'stack'; } ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'var-declared-in-a-switch-case',
    source: `${KEY} switch (1) { case 1: var key: 'sta' | 'stack' = 'stack'; } ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'var-declared-by-a-pattern',
    source: `${KEY} var { key } = { key: 'stack' as 'sta' | 'stack' }; ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'var-declared-again-with-a-cast-the-annotation-lacks',
    source: `var key: 'sta' = 'sta'; var key: 'sta' = 'stack' as 'sta'; ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'var-declared-again-without-a-value',
    source: `${KEY} var key: 'sta' | 'stack'; ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'var-declared-again-after-the-read',
    source: `${KEY} ${GET} var key: 'sta' | 'stack' = 'stack';`,
    names: ['sta', 'stack'],
  },
  {
    id: 'var-of-another-function-pin',
    source: `${KEY} function other() { var key: 'sta' | 'stack' = 'stack'; void key; } other(); ${GET}`,
    names: ['sta'],
  },
  {
    id: 'let-of-a-block-pin',
    source: `${KEY} { let key: 'sta' | 'stack' = 'stack'; void key; } ${GET}`,
    names: ['sta'],
  },
  {
    id: 'parameter-named-again-by-a-var-pin',
    source: `function pick(key: 'sta' | 'stack' = 'sta') { var key: 'sta' | 'stack' = 'stack'; ${GET} } void pick;`,
    names: ['sta', 'stack'],
  },
  {
    id: 'var-declared-once-pin',
    source: `${KEY} ${GET}`,
    names: ['sta'],
  },
  {
    id: 'var-declared-once-and-assigned-pin',
    source: `${KEY} key = 'stack'; ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'var-of-no-declared-names-declared-twice-pin',
    source: `var key = 'sta'; var key = 'stack'; ${GET}`,
    names: undefined,
  },
  {
    id: 'constant-pin',
    source: `const key = 'stack'; ${GET}`,
    names: ['stack'],
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

describe('the names of a key that a var declared again may hold', () => {
  it.each(CASES)('$id', ({ source, names }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'redeclared-key-sources.ts', source);
    const found = framedKeyNames(keyArgument(parsed.sourceFile));

    expect(found?.toSorted(compare)).toStrictEqual(names?.toSorted(compare));
  });
});
