import {
  type CallExpression,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inputMetadata } from '../src/compiler/input-metadata.ts';

const FROZEN_REASON =
  "calls `Object.isFrozen()` on what may be an input, whose flags differ between the browser's mutable value and the authority's frozen copy";

const LIMITS = {
  budgetMs: 100,
  diamondLevels: 25,
} as const;

const LAST_DIAMOND = `a${String(LIMITS.diamondLevels)}`;

/** Builds `count` nested literal diamond declarations `a1`..`aN` starting from `seed`. */
function nestedContainerDiamond(count: number, seed: string): string {
  const lines = [seed];
  for (let index = 1; index <= count; index += 1) {
    const previous = `a${String(index - 1)}`;
    lines.push(`const a${String(index)} = { left: ${previous}, right: ${previous} };`);
  }
  return lines.join(' ');
}

/** Builds `count` conditional container alias declarations `a1`..`aN` starting from `seed`. */
function conditionalContainerDiamond(count: number, seed: string): string {
  const lines = [seed];
  for (let index = 1; index <= count; index += 1) {
    const previous = `a${String(index - 1)}`;
    lines.push(`const a${String(index)} = flag ? ${previous} : ${previous};`);
  }
  return lines.join(' ');
}

const CASES = [
  {
    body: `${nestedContainerDiamond(LIMITS.diamondLevels, 'const a0 = { nested: { count: 0 } };')} return Object.isFrozen(a0.nested);`,
    expected: undefined,
    id: 'nested-container-diamond-25-levels-fresh',
  },
  {
    body: `${nestedContainerDiamond(LIMITS.diamondLevels, 'const a0 = { nested: input };')} return Object.isFrozen(a0.nested);`,
    expected: FROZEN_REASON,
    id: 'nested-container-diamond-25-levels-holding-input',
  },
  {
    body: `${conditionalContainerDiamond(LIMITS.diamondLevels, 'const a0 = { nested: { count: 0 } };')} return Object.isFrozen(${LAST_DIAMOND}.nested);`,
    expected: undefined,
    id: 'conditional-holder-diamond-25-levels-fresh',
  },
  {
    body: 'var a: { nested: { count: number }; other?: unknown } = { nested: { count: 0 }, other: b }; var b: { other?: unknown } = { other: a }; void b; return Object.isFrozen(a.nested);',
    expected: FROZEN_REASON,
    id: 'cyclic-var-outer-containers-refused-without-stack-overflow',
  },
  {
    body: 'const holder = { value: {} }; const derived = { __proto__: { holder } }; (derived as unknown as { holder: { value: unknown } }).holder.value = input; return Object.isFrozen(holder.value);',
    expected: FROZEN_REASON,
    id: 'prototype-installation-exposing-nested-holder',
  },
  {
    body: "const holder = { inner: { value: {} } }; const derived = { '__proto__': holder }; (derived as unknown as { inner: { value: unknown } }).inner.value = input; return Object.isFrozen(holder.inner.value);",
    expected: FROZEN_REASON,
    id: 'quoted-prototype-installation-exposing-direct-holder',
  },
  {
    body: 'const holder = { value: {} }; const derived = Object.create({ holder }) as { holder: { value: unknown } }; derived.holder.value = input; return Object.isFrozen(holder.value);',
    expected: FROZEN_REASON,
    id: 'outer-container-escaped-to-object-create',
  },
  {
    body: 'function sneak(box: { holder: { value: unknown } }) { box.holder.value = input; } const holder = { value: {} }; const outer = { holder }; sneak(outer); return Object.isFrozen(holder.value);',
    expected: FROZEN_REASON,
    id: 'outer-container-escaped-to-helper-mutating-nested-slot',
  },
  {
    body: 'const holder = { slot: {}, set replace(value: unknown) { (this as unknown as { slot: unknown }).slot = value; } }; holder.replace = input; return Object.isFrozen(holder.slot);',
    expected: FROZEN_REASON,
    id: 'setter-backed-sibling-write-replaces-selected-slot',
  },
  {
    body: "const key = 'replace'; const holder = { set [key](value: unknown) { (this as unknown as { slot: unknown }).slot = value; }, slot: {} }; (holder as Record<string, unknown>).replace = input; return Object.isFrozen(holder.slot);",
    expected: FROZEN_REASON,
    id: 'computed-setter-on-container-with-sibling-write',
  },
  {
    body: 'const proto = { set replace(value: unknown) { (this as unknown as { slot: unknown }).slot = value; } }; const holder = { __proto__: proto, slot: {} }; (holder as unknown as { replace: unknown }).replace = input; return Object.isFrozen(holder.slot);',
    expected: FROZEN_REASON,
    id: 'prototype-setter-on-container-with-sibling-write',
  },
  {
    body: 'class Box { slot: { count: number } = { count: 0 }; set replace(value: { count: number }) { this.slot = value; } constructor(x: { count: number }) { this.replace = x; this.slot.count++; } } return Object.isFrozen(new Box(input));',
    expected: FROZEN_REASON,
    id: 'class-receiver-setter-backed-sibling-write-replaces-slot',
  },
  {
    body: 'const holder: { __proto__: null; slot: { count: number }; other?: unknown } = { __proto__: null, slot: { count: 0 } }; holder.other = input; return Object.isFrozen(holder.slot);',
    expected: undefined,
    id: 'null-prototype-container-with-sibling-write-stays-fresh',
  },
  {
    body: 'const holder = { slot: { count: 0 }, set replace(_value: unknown) {} }; return Object.isFrozen(holder.slot);',
    expected: undefined,
    id: 'inert-setter-without-member-writes-stays-fresh',
  },
] as const;

describe('metadata container diamonds, prototype installations, and setter-backed writes', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `inputMetadata` and elapsed milliseconds on the `Object.isFrozen` call in `body`. */
  function analyzed(body: string): { readonly answer: string | undefined; readonly took: number } {
    using parsed = api.createSourceFile(
      'input-container-diamonds.ts',
      `export function check(input: { count: number }, flag: boolean): boolean { ${body} }
`,
    );
    let target: CallExpression | undefined;
    const pending: Node[] = [parsed.sourceFile];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (
        isCallExpression(at) &&
        isPropertyAccessExpression(at.expression) &&
        isIdentifier(at.expression.expression) &&
        at.expression.expression.text === 'Object' &&
        at.expression.name.text === 'isFrozen'
      ) {
        target = at;
      }
      at.forEachChild((child) => {
        pending.push(child);
      });
    }
    if (target === undefined) {
      throw new Error(`No Object.isFrozen call found in ${body}.`);
    }
    const started = performance.now();
    const answer = inputMetadata(target);
    return { answer, took: performance.now() - started };
  }

  it.each(CASES)('$id', ({ body, expected }) => {
    const done = analyzed(body);
    expect(done.answer).toBe(expected);
    expect(done.took).toBeLessThan(LIMITS.budgetMs);
  });
});
