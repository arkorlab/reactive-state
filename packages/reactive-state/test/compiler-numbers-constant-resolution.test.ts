import {
  type Expression,
  type Identifier,
  isIdentifier,
  isVariableDeclaration,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { constantValue } from '../src/compiler/numbers.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A constant that other constants read, several times each, is read once: the work of a reading
 * grows with the constants, not with the ways to reach them (a chain whose every constant reads the
 * one before twice is 2^n ways). What a name cut short (a constant that reads itself) holds is no
 * constant, and is not kept for another way to it; and a reading takes no more than a bounded number
 * of constants, past which it takes the rest for none.
 */
const CHAIN = 16;

/** The constants `c0 = first`, `c1 = step(c0)`, up to `c<length>`, as source. */
function chain(first: string, step: (before: string) => string, length: number): string {
  const parts = [`const c0 = ${first};`];
  for (let at = 1; at <= length; at++) {
    const before = `c${at - 1}`;
    parts.push(`const c${at} = ${step(before)};`);
  }
  return parts.join(' ');
}

/** The constants `chain` writes, but that `c0` reads the last of: a cycle through all of them. */
function cycle(step: (before: string) => string, length: number): string {
  return `const c0 = c${length}; ${chain('0', step, length).replace('const c0 = 0; ', '')}`;
}

const CASES = [
  {
    id: 'sum-of-the-constant-before-twice',
    source: chain('1', (before) => `${before} + ${before}`, CHAIN),
    last: `c${CHAIN}`,
    value: 2 ** CHAIN,
    reads: 40,
  },
  {
    id: 'product-of-the-constant-before-three-times-in-all',
    source: chain('1', (before) => `${before} * 2 + ${before} - ${before}`, 10),
    last: 'c10',
    value: 2 ** 10,
    reads: 60,
  },
  {
    id: 'maximum-of-the-constant-before-twice',
    source: chain('1', (before) => `Math.max(${before}, ${before})`, CHAIN),
    last: `c${CHAIN}`,
    value: 1,
    reads: 40,
  },
  {
    id: 'text-made-a-number-twice',
    source: chain('1', (before) => `Number(${before}) + Number(${before})`, CHAIN),
    last: `c${CHAIN}`,
    value: 2 ** CHAIN,
    reads: 40,
  },
  {
    id: 'squares-reach-infinity-pin',
    source: chain('2', (before) => `${before} * ${before}`, 11),
    last: 'c11',
    value: Infinity,
    reads: 40,
  },
  {
    id: 'constant-read-by-two-ways-pin',
    source: 'const x = 3; const a = x + 1; const b = x + a;',
    last: 'b',
    value: 7,
    reads: 10,
  },
  {
    id: 'constants-that-read-each-other-are-none-pin',
    source: 'const a = b + 1; const b = a + 1;',
    last: 'a',
    value: undefined,
    reads: 10,
  },
  {
    id: 'constant-that-reads-itself-is-none-pin',
    source: 'const a = a + 1;',
    last: 'a',
    value: undefined,
    reads: 10,
  },
  {
    id: 'cut-in-one-way-is-not-kept-for-another-pin',
    source: 'const x = 1; const a = x + b; const b = x + a; const d = x + 4;',
    last: 'd',
    value: 5,
    reads: 10,
  },
  {
    id: 'chain-that-reads-itself-at-its-start-is-none',
    source: cycle((before) => `Math.max(${before}, ${before})`, CHAIN),
    last: `c${CHAIN}`,
    value: undefined,
    reads: 20_000,
  },
] as const;

describe('constants that other constants read many times', () => {
  it.each(CASES)('$id', ({ source, last, value, reads }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'constant-resolution.ts', source);
    const held = constantsOf(parsed.sourceFile);
    let calls = 0;
    const resolve = (name: Identifier): Expression | undefined => {
      calls += 1;
      return held.get(name.text);
    };

    expect(constantValue(startOf(held, last), resolve)).toBe(value);
    expect(calls).toBeLessThanOrEqual(reads);
  });
});

/** The initializer of each constant the source declares, by its name. */
function constantsOf(root: Node): ReadonlyMap<string, Expression> {
  const held = new Map<string, Expression>();
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isVariableDeclaration(node) && isIdentifier(node.name) && node.initializer !== undefined)
      held.set(node.name.text, node.initializer);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return held;
}

function startOf(held: ReadonlyMap<string, Expression>, name: string): Expression {
  const start = held.get(name);
  if (start === undefined) throw new Error(`no constant ${name}`);
  return start;
}
