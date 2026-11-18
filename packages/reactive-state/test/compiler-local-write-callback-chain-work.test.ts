import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isJson } from '../src/authority/canonical.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { targetChanged } from './support/local-write-target.ts';

/**
 * Whether a callback writes into the element it is given is read by following the callbacks it
 * hands that element to. Where both branches of a callback hand it to the same earlier callback,
 * the branches converge, and each callback must be read once, however it is reached: a chain of
 * such callbacks grows the work with the source, not with the number of paths through it, which
 * doubles with each callback. A callback that calls itself, or a pair that call each other, still
 * end, and a write at the bottom of a chain is still found.
 */

/** Milliseconds a check may take: a chain of sixteen took seven seconds when each path was walked. */
const BUDGET = 1500;
const DEPTH = 16;
const POISONED = NaN;

interface Case {
  readonly id: string;
  readonly helpers: string;
  readonly changed: boolean;
  readonly run: () => unknown;
}

/** `function f1(row) { if (flag) f0(row); else f0(row); } …` of `depth` callbacks from `bottom`. */
function chain(depth: number, bottom: string): string {
  const lines = [`function f0(row: Item): void { ${bottom} }`];
  for (let each = 1; each <= depth; each += 1) {
    const earlier = `f${String(each - 1)}`;
    lines.push(
      `function f${String(each)}(row: Item): void { if (flag) ${earlier}(row); else ${earlier}(row); }`,
    );
  }
  return lines.join('\n');
}

function items(poisoned: boolean): { value: number }[] {
  return [{ value: poisoned ? POISONED : 0 }];
}

const CASES: readonly Case[] = [
  {
    changed: false,
    helpers: chain(DEPTH, ''),
    id: 'converging-chain-of-sixteen-callbacks',
    run: () => items(false),
  },
  {
    changed: false,
    helpers: chain(3, ''),
    id: 'converging-chain-of-three-callbacks',
    run: () => items(false),
  },
  {
    changed: true,
    helpers: chain(DEPTH, 'row.value = NaN;'),
    id: 'pin-converging-chain-of-sixteen-ending-in-a-write',
    run: () => items(true),
  },
  {
    changed: false,
    helpers: 'function f16(row: Item): void { f16(row); }',
    id: 'callback-calling-itself',
    run: () => items(false),
  },
  {
    changed: true,
    helpers:
      'function f16(row: Item): void { other(row); }\nfunction other(row: Item): void { f16(row); row.value = NaN; }',
    id: 'pin-two-callbacks-calling-each-other-and-writing',
    run: () => items(true),
  },
];

describe('the check of what a callback writes, through converging callbacks', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)(
    '$id',
    ({ changed, helpers, run }) => {
      using parsed = parseModule(
        api,
        'callback-chain-work.ts',
        `interface Item { value: number }\nexport function build(flag: boolean) { const target: Item[] = [{ value: 0 }]; target.forEach(f${String(DEPTH)}); return target; }\n${helpers}\n`,
      );
      const start = performance.now();
      const told = targetChanged(parsed.sourceFile);
      const elapsed = performance.now() - start;

      expect(isJson(run())).toBe(!changed);
      expect(told).toBe(changed);
      expect(elapsed).toBeLessThan(BUDGET);
    },
    120_000,
  );
});
