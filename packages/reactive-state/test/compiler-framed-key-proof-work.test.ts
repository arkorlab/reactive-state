import { type Expression, isCallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedKeyNames } from '../src/compiler/framed-keys.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The names of a key follow each constant alias to what it was written as, down a chain of
 * conditionals. Where both branches name the same earlier alias, the branches converge, and each
 * alias must be followed once, whichever way it is reached: a chain of such aliases grows the work
 * with the source, not with the number of paths through it, which doubles with each alias. A cycle
 * of aliases gives no names however it is reached, and the declared names of a parameter stay what
 * an unresolved branch falls back to.
 */
const FLAG = 'declare const flag: boolean;';

/** A chain of `length` constants, each of the earlier one in both branches, from `bottom`. */
function converging(length: number, bottom: string): string {
  const lines = [FLAG, `const k0 = ${bottom};`];
  for (let each = 1; each <= length; each += 1)
    lines.push(`const k${each} = flag ? k${each - 1} : k${each - 1};`);
  lines.push(`Reflect.get(new Error(), k${length});`);
  return lines.join(' ');
}

/** Milliseconds a key may take: a chain of twenty took twenty-five seconds when each path was walked. */
const BUDGET = 1500;

const CASES = [
  { id: 'converging-chain-of-three', source: converging(3, "'stack'"), names: ['stack'] },
  { id: 'converging-chain-of-twenty', source: converging(20, "'stack'"), names: ['stack'] },
  {
    id: 'converging-chain-of-twenty-from-a-union',
    source: converging(20, "(flag ? 'sta' : 'stack')"),
    names: ['sta', 'stack'],
  },
  {
    id: 'diamond-of-constants',
    source: `${FLAG} const a = 'x'; const b = 'y'; const c = flag ? a : b; const d = flag ? c : c; Reflect.get(new Error(), d);`,
    names: ['x', 'y'],
  },
  {
    id: 'ladder-of-constants',
    source: `${FLAG} const c = flag ? 'a' : 'b'; const d = flag ? c : 'c'; const e = flag ? d : 'd'; Reflect.get(new Error(), e);`,
    names: ['a', 'b', 'c', 'd'],
  },
  {
    id: 'converging-parameter-with-declared-names',
    source: `${FLAG} function frames(key: 'sta' | 'stack') { const k1 = flag ? key : key; const k2 = flag ? k1 : k1; return Reflect.get(new Error(), k2); }`,
    names: ['sta', 'stack'],
  },
  {
    id: 'alias-of-itself',
    source: `${FLAG} const x: string = flag ? x : 'a'; Reflect.get(new Error(), x);`,
    names: undefined,
  },
  {
    id: 'two-aliases-of-each-other',
    source: `${FLAG} const x: string = flag ? y : 'a'; const y: string = flag ? x : 'b'; Reflect.get(new Error(), x);`,
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

describe('the names of a key reached through converging aliases', () => {
  it.each(CASES)(
    '$id',
    ({ source, names }) => {
      using api = openTypeScript();
      using parsed = parseModule(api, 'key-proof-work.ts', source);
      const start = performance.now();
      const found = framedKeyNames(keyArgument(parsed.sourceFile));
      const elapsed = performance.now() - start;

      expect(found?.toSorted(compare)).toStrictEqual(names?.toSorted(compare));
      expect(elapsed).toBeLessThan(BUDGET);
    },
    120_000,
  );
});
