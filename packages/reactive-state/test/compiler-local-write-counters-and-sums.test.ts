import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isJson } from '../src/authority/canonical.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { targetChanged } from './support/local-write-target.ts';

/**
 * A counter or a sum the code builds in a loop, a callback or several statements is an ordinary
 * program, and no number a page's values make is finite or not where the compile can tell: the
 * authority refuses one that is not where it meets it. What the code shows — an operand that
 * overflows or divides by zero, a slot nothing initializes — the compile still refuses.
 */

interface Item {
  readonly price: number;
}

interface Inputs {
  readonly base: number;
  readonly items: readonly Item[];
}

interface Case {
  readonly id: string;
  readonly body: string;
  readonly changed: boolean;
  readonly run: (inputs: Inputs) => unknown;
}

const FEW = [{ price: 1 }, { price: 2 }, { price: 3 }, { price: 4 }];
const BASE = 5;
const HUGE = 1e100;
const NEAR_MAX = 1e308;
const INPUTS: Inputs = { base: BASE, items: FEW };

function box<T>(value: T): T {
  return value;
}

/** Runs `step` once for each of `items`. */
function each(items: readonly Item[], step: (item: Item) => void): void {
  for (const item of items) {
    step(item);
  }
}

const CASES: readonly Case[] = [
  {
    body: 'const target = { count: 0 }; for (const item of items) { target.count += 1; } return target;',
    changed: false,
    id: 'count-plus-equals-in-loop',
    run: ({ items }) => {
      const target = box({ count: 0 });
      each(items, () => {
        target.count += 1;
      });
      return target;
    },
  },
  {
    body: 'const target = { count: 0 }; for (const item of items) { target.count++; } return target;',
    changed: false,
    id: 'count-increment-in-loop',
    run: ({ items }) => {
      const target = box({ count: 0 });
      each(items, () => {
        target.count += 1;
      });
      return target;
    },
  },
  {
    body: 'const target = { count: 0 }; items.forEach(() => { target.count++; }); return target;',
    changed: false,
    id: 'count-increment-in-callback',
    run: ({ items }) => {
      const target = box({ count: 0 });
      each(items, () => {
        target.count += 1;
      });
      return target;
    },
  },
  {
    body: 'const target = { left: 9 }; for (const item of items) { --target.left; } return target;',
    changed: false,
    id: 'decrement-in-loop',
    run: ({ items }) => {
      const target = box({ left: BASE * 2 });
      each(items, () => {
        target.left -= 1;
      });
      return target;
    },
  },
  {
    body: 'const target = { sum: 0 }; for (const item of items) { target.sum += item.price; } return target;',
    changed: false,
    id: 'sum-of-page-values-in-loop',
    run: ({ items }) => {
      const target = box({ sum: 0 });
      for (const item of items) {
        target.sum += item.price;
      }
      return target;
    },
  },
  {
    body: 'const target = { sum: 0 }; target.sum += base; return target;',
    changed: false,
    id: 'sum-of-a-page-value-once',
    run: ({ base }) => {
      const target = box({ sum: 0 });
      target.sum += base;
      return target;
    },
  },
  {
    body: 'const target = { count: 0 }; target.count += 1; target.count += 2; return target;',
    changed: false,
    id: 'two-additive-writes',
    run: () => {
      const target = box({ count: 0 });
      target.count += 1;
      target.count += 2;
      return target;
    },
  },
  {
    body: 'const target = { count: base }; for (const item of items) { target.count += 1; } return target;',
    changed: false,
    id: 'counter-from-a-page-value-in-loop',
    run: ({ base, items }) => {
      const target = box({ count: base });
      each(items, () => {
        target.count += 1;
      });
      return target;
    },
  },
  {
    body: 'const target = { count: base }; target.count++; return target;',
    changed: false,
    id: 'increment-of-a-page-value',
    run: ({ base }) => {
      const target = box({ count: base });
      target.count += 1;
      return target;
    },
  },
  {
    body: 'const target = [0, 0]; for (const item of items) { target[0] += item.price; } return target;',
    changed: false,
    id: 'element-sum-in-loop',
    run: ({ items }) => {
      const target = box([0, 0]);
      for (const item of items) {
        target[0] = (target[0] ?? 0) + item.price;
      }
      return target;
    },
  },
  {
    body: "const target = { text: '' }; for (const item of items) { target.text += String(item.price); } return target;",
    changed: false,
    id: 'text-built-in-loop',
    run: ({ items }) => {
      const target = box({ text: '' });
      for (const item of items) {
        target.text += String(item.price);
      }
      return target;
    },
  },
  {
    body: 'const target = { n: 1 }; for (const item of items) { target.n *= 1e100; } return target;',
    changed: true,
    id: 'pin-multiplicative-loop-overflow',
    run: ({ items }) => {
      const target = box({ n: 1 });
      each(items, () => {
        target.n *= HUGE;
      });
      return target;
    },
  },
  {
    body: 'const zero = 0; const target = { n: 1 }; for (const item of items) { target.n /= zero; } return target;',
    changed: true,
    id: 'pin-divide-by-constant-zero-in-loop',
    run: ({ items }) => {
      const zero = 0;
      const target = box({ n: 1 });
      each(items, () => {
        target.n /= zero;
      });
      return target;
    },
  },
  {
    body: 'const target: { count?: number } = {}; for (const item of items) { (target.count as number)++; } return target;',
    changed: true,
    id: 'pin-uninitialized-counter-in-loop',
    run: ({ items }) => {
      const target = box<{ count: number }>({} as { count: number });
      each(items, () => {
        target.count += 1;
      });
      return target;
    },
  },
  {
    body: 'const target: { sum?: number } = {}; for (const item of items) { (target.sum as number) += item.price; } return target;',
    changed: true,
    id: 'pin-uninitialized-sum-in-loop',
    run: ({ items }) => {
      const target = box<{ sum: number }>({} as { sum: number });
      for (const item of items) {
        target.sum += item.price;
      }
      return target;
    },
  },
  {
    body: 'const target = { n: 1e308 }; target.n += 1e308; return target;',
    changed: true,
    id: 'pin-shown-addition-overflow',
    run: () => {
      const target = box({ n: NEAR_MAX });
      target.n += NEAR_MAX;
      return target;
    },
  },
  {
    body: "const target = { n: 'bad' as unknown as number }; for (const item of items) { target.n++; } return target;",
    changed: true,
    id: 'text-slot-incremented-in-loop',
    run: ({ items }) => {
      const target = box({ n: 'bad' as unknown as number });
      each(items, () => {
        target.n -= -1;
      });
      return target;
    },
  },
  {
    body: "const target = { n: 'bad' as unknown as number }; for (const item of items) { target.n -= 1; } return target;",
    changed: true,
    id: 'text-slot-subtracted-from-in-loop',
    run: ({ items }) => {
      const target = box({ n: 'bad' as unknown as number });
      each(items, () => {
        target.n -= 1;
      });
      return target;
    },
  },
  {
    body: "const target = { n: 'bad' as unknown as number }; items.forEach(() => { --target.n; }); return target;",
    changed: true,
    id: 'text-slot-decremented-in-callback',
    run: ({ items }) => {
      const target = box({ n: 'bad' as unknown as number });
      each(items, () => {
        target.n -= 1;
      });
      return target;
    },
  },
  {
    body: 'const target = { n: {} as unknown as number }; for (const item of items) { target.n++; } return target;',
    changed: true,
    id: 'object-slot-incremented-in-loop',
    run: ({ items }) => {
      const target = box({ n: {} as unknown as number });
      each(items, () => {
        target.n -= -1;
      });
      return target;
    },
  },
  {
    body: 'const target = { n: undefined as unknown as number }; target.n++; return target;',
    changed: true,
    id: 'undefined-slot-incremented',
    run: () => {
      const target = box({ n: undefined as unknown as number });
      target.n -= -1;
      return target;
    },
  },
  {
    body: 'const target = { n: undefined as unknown as number }; target.n -= 1; return target;',
    changed: true,
    id: 'undefined-slot-subtracted-from',
    run: () => {
      const target = box({ n: undefined as unknown as number });
      target.n -= 1;
      return target;
    },
  },
  {
    body: 'const target = { n: undefined as unknown as number }; for (const item of items) { target.n++; } return target;',
    changed: true,
    id: 'undefined-slot-incremented-in-loop',
    run: ({ items }) => {
      const target = box({ n: undefined as unknown as number });
      each(items, () => {
        target.n -= -1;
      });
      return target;
    },
  },
  {
    body: 'const target = { n: (() => 1) as unknown as number }; target.n++; return target;',
    changed: true,
    id: 'function-slot-incremented',
    run: () => {
      const target = box({ n: (() => 1) as unknown as number });
      target.n -= -1;
      return target;
    },
  },
  {
    body: 'const target = { n: null as unknown as number }; target.n++; return target;',
    changed: false,
    id: 'null-slot-incremented',
    run: () => {
      const target = box({ n: null as unknown as number });
      target.n += 1;
      return target;
    },
  },
  {
    body: 'const target = { n: undefined as unknown as number }; target.n += 1; return target;',
    changed: true,
    id: 'undefined-slot-added-to',
    run: () => {
      const target = box({ n: undefined as unknown as number });
      target.n += 1;
      return target;
    },
  },
  {
    body: 'const target = { n: undefined as unknown as number }; for (const item of items) { target.n += item.price; } return target;',
    changed: true,
    id: 'undefined-slot-summed-in-loop',
    run: ({ items }) => {
      const target = box({ n: undefined as unknown as number });
      for (const item of items) {
        target.n += item.price;
      }
      return target;
    },
  },
  {
    body: 'const target = { n: null as unknown as number }; target.n += 1; return target;',
    changed: false,
    id: 'null-slot-added-to',
    run: () => {
      const target = box({ n: null as unknown as number });
      target.n += 1;
      return target;
    },
  },
];

describe('local counters and sums of a page’s values', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ body, changed, run }) => {
    using parsed = parseModule(
      api,
      'counters-and-sums.ts',
      `export function build(items: readonly { price: number }[], base: number) { ${body} }\n`,
    );

    expect(isJson(run(INPUTS))).toBe(!changed);
    expect(targetChanged(parsed.sourceFile)).toBe(changed);
  });
});
