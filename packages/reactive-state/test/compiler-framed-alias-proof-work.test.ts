import { type Expression, isIdentifier, isVariableDeclaration, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { sourceArrayFunction } from '../src/compiler/framed-array-functions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The proof that a function is source-written follows each alias to what it was written as, down a
 * chain of conditionals. Where both branches of a conditional name the same earlier alias, the
 * branches converge, and each alias must be proved once, whichever way it is reached: a chain of
 * such aliases grows the work with the source, not with the number of paths through it, which
 * doubles with each alias. A cycle of aliases, and a native function at the bottom, give no proof
 * however they are reached.
 */
const FLAG = 'declare const flag: boolean;';

/** Milliseconds a proof may take: a chain of twenty took thirteen seconds when each path was walked. */
const BUDGET = 1500;

/** A chain of `length` aliases, each of the earlier one in both branches, from `bottom`. */
function converging(length: number, bottom: string): string {
  const lines = [FLAG, `const f0 = ${bottom};`];
  for (let each = 1; each <= length; each += 1)
    lines.push(`const f${each} = flag ? f${each - 1} : f${each - 1};`);
  lines.push(`const taken = f${length};`);
  return lines.join(' ');
}

const CASES = [
  {
    id: 'converging-chain-of-written-functions',
    source: converging(3, "() => 'fixed'"),
    custom: true,
  },
  {
    id: 'converging-chain-of-twenty-written-functions',
    source: converging(20, "() => 'fixed'"),
    custom: true,
  },
  {
    id: 'converging-chain-of-twenty-ending-in-the-native-function',
    source: converging(20, 'Array.prototype.join'),
    custom: false,
  },
  {
    id: 'diamond-of-written-functions',
    source: `${FLAG} const a = () => 1; const b = function () { return 2; }; const c = flag ? a : b; const d = flag ? c : c; const taken = d;`,
    custom: true,
  },
  {
    id: 'diamond-with-a-native-function-in-one-branch',
    source: `${FLAG} const a = () => 1; const c = flag ? a : Array.prototype.join; const d = flag ? c : c; const taken = d;`,
    custom: false,
  },
  {
    id: 'ladder-of-written-functions',
    source: `${FLAG} const a = () => 1; const b = () => 2; const c = flag ? a : b; const d = flag ? c : () => 3; const e = flag ? d : () => 4; const taken = e;`,
    custom: true,
  },
  {
    id: 'alias-of-itself',
    source: `${FLAG} const x: () => number = flag ? x : () => 1; const taken = x;`,
    custom: false,
  },
  {
    id: 'two-aliases-of-each-other',
    source: `${FLAG} const x: () => number = flag ? y : () => 1; const y: () => number = flag ? x : () => 2; const taken = x;`,
    custom: false,
  },
];

/** The initializer of `taken`, the read the proof is of. */
function takenRead(root: Node): Expression {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.name.text === 'taken' &&
      node.initializer !== undefined
    )
      return node.initializer;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no taken');
}

describe('the proof of a function reached through converging aliases', () => {
  it.each(CASES)(
    '$id',
    ({ source, custom }) => {
      using api = openTypeScript();
      using parsed = parseModule(api, 'alias-proof-work.ts', source);
      const read = takenRead(parsed.sourceFile);
      const start = performance.now();
      const proof = sourceArrayFunction(read);
      const elapsed = performance.now() - start;

      expect(proof).toBe(custom);

      expect(elapsed).toBeLessThan(BUDGET);
    },
    120_000,
  );
});
