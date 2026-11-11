import { type Expression, isCallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedKeyNames } from '../src/compiler/framed-keys.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The names a mutable key may have are those of what it is declared with and what the code assigns
 * it. A compound assignment (`key += 'ck'`), an update (`key++`) and a `for…in` binding change it
 * to a value that no expression of the code writes, so the sources are not all of it: the names
 * its declared type allows are what it may be. A key written by `=`, `||=`, `&&=`, `??=` or a
 * `for…of`, one never written, a constant, and another variable's compound write leave the names
 * as the sources give them.
 */
const GET = 'Reflect.get(new Error(), key);';

const CASES = [
  {
    id: 'reviewed-compound-assignment',
    source: `let key: 'sta' | 'stack' = 'sta'; key += 'ck'; ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'increment',
    source: `let key: 0 | 1 = 0; key++; ${GET}`,
    names: ['0', '1'],
  },
  {
    id: 'prefix-decrement',
    source: `let key: 0 | 1 = 1; --key; ${GET}`,
    names: ['0', '1'],
  },
  {
    id: 'arithmetic-compound-assignment',
    source: `let key: 0 | 1 | 2 = 0; key += 2; ${GET}`,
    names: ['0', '1', '2'],
  },
  {
    id: 'compound-assignment-in-another-function',
    source: `let key: 'sta' | 'stack' = 'sta'; function bump() { key += 'ck'; } bump(); ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'compound-assignment-in-a-loop',
    source: `let key: 'sta' | 'stack' = 'sta'; for (let i = 0; i < 2; i += 1) { key += 'ck'; } ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'for-in-binding',
    source: `declare const holder: object; let key: 'a' | 'b' = 'a'; for (key in holder) { void key; } ${GET}`,
    names: ['a', 'b'],
  },
  {
    id: 'compound-assignment-keeps-a-source-the-annotation-lacks',
    source: `let key: 'name' = 'stack' as 'name'; key += ''; ${GET}`,
    names: ['name', 'stack'],
  },
  {
    id: 'compound-assignment-keeps-the-sources-and-the-declared-names',
    source: `let key: 'a' | 'b' = 'a'; key = 'c' as 'a'; key += 'x'; ${GET}`,
    names: ['a', 'b', 'c'],
  },
  {
    id: 'increment-keeps-a-source-the-annotation-lacks',
    source: `let key: 0 = 1 as 0; key++; ${GET}`,
    names: ['0', '1'],
  },
  {
    id: 'direct-assignment-pin',
    source: `let key: 'sta' | 'stack' = 'sta'; key = 'stack'; ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'logical-assignment-pin',
    source: `let key: 'sta' | 'stack' = 'sta'; key ||= 'stack'; ${GET}`,
    names: ['sta', 'stack'],
  },
  {
    id: 'key-never-written-pin',
    source: `let key: 'sta' | 'stack' = 'sta'; ${GET}`,
    names: ['sta'],
  },
  {
    id: 'compound-assignment-of-another-variable-pin',
    source: `let key: 'sta' | 'stack' = 'sta'; let other = ''; other += 'ck'; void other; ${GET}`,
    names: ['sta'],
  },
  {
    id: 'compound-assignment-of-an-unannotated-key-pin',
    source: `let key = 'sta'; key += 'ck'; ${GET}`,
    names: undefined,
  },
  {
    id: 'constant-key-pin',
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

describe('the names of a key a compound assignment or an update changes', () => {
  it.each(CASES)('$id', ({ source, names }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'compound-key-writes.ts', source);
    const found = framedKeyNames(keyArgument(parsed.sourceFile));

    expect(found?.toSorted(compare)).toStrictEqual(names?.toSorted(compare));
  });
});
