import {
  type CallExpression,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isVariableDeclaration,
  type Node,
} from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { inputMetadata } from '../src/compiler/input-metadata.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const FROZEN_REASON =
  "calls `Object.isFrozen()` on what may be an input, whose flags differ between the browser's mutable value and the authority's frozen copy";

const LIMITS = {
  abortReads: 500,
  deepLevels: 30,
  maxAliasReads: 6,
  mediumLevels: 12,
} as const;

/** Builds `count` conditional alias declarations `a1`..`aN` starting from `seed`. */
function conditionalAliasDiamond(count: number, seed: string): string {
  const lines = [`const a0 = ${seed};`];
  for (let index = 1; index <= count; index += 1) {
    const previous = `a${String(index - 1)}`;
    lines.push(`const a${String(index)} = flag ? ${previous} : ${previous};`);
  }
  return lines.join(' ');
}

const DEEP_LAST = `a${String(LIMITS.deepLevels)}`;
const MEDIUM_LAST = `a${String(LIMITS.mediumLevels)}`;

const SCALING_CASES = [
  {
    body: `class Box { constructor(x = 0) { void x; } } ${conditionalAliasDiamond(LIMITS.mediumLevels, '1')} return Object.isFrozen(new Box(${MEDIUM_LAST}));`,
    expected: undefined,
    id: 'medium-12-level-defined-conditional-diamond-reuses-proof',
  },
  {
    body: `class Box { constructor(x = ++input.count) { void x; } } ${conditionalAliasDiamond(LIMITS.deepLevels, '1')} return Object.isFrozen(new Box(${DEEP_LAST}));`,
    expected: undefined,
    id: 'deep-30-level-defined-conditional-diamond-skips-default',
  },
  {
    body: `class Box { constructor(x = ++input.count) { void x; } } ${conditionalAliasDiamond(LIMITS.deepLevels, '1')} const maybe = flag ? ${DEEP_LAST} : maybeUndefined; return Object.isFrozen(new Box(maybe));`,
    expected: FROZEN_REASON,
    id: 'deep-30-level-unproven-conditional-diamond-memoizes-false',
  },
  {
    body: `class Inner { constructor(x = ++input.count) { void x; } } class Outer { value: Inner; constructor(seed: number) { ${conditionalAliasDiamond(LIMITS.deepLevels, 'seed')} this.value = new Inner(${DEEP_LAST}); } } return Object.isFrozen(new Outer(1));`,
    expected: undefined,
    id: 'deep-30-level-parameter-bound-conditional-diamond',
  },
  {
    body: `class Box { constructor({ value = ++input.count }: { value?: number } = {}) { void value; } } ${conditionalAliasDiamond(LIMITS.deepLevels, '1')} return Object.isFrozen(new Box({ value: ${DEEP_LAST} }));`,
    expected: undefined,
    id: 'deep-30-level-object-pattern-default-conditional-diamond',
  },
] as const;

const SEMANTIC_CASES = [
  {
    body: 'class Inner { constructor(x = ++input.count) { void x; } } class Outer { value: Inner; constructor(seed: number | undefined) { const a0 = seed; const a1 = flag ? a0 : a0; const a2 = flag ? a1 : a1; this.value = new Inner(a2); } } return Object.isFrozen(flag ? new Outer(1) : new Outer(maybeUndefined));',
    expected: FROZEN_REASON,
    id: 'defined-call-cache-does-not-mask-later-unproven-parameter-call',
  },
  {
    body: 'class Outer { constructor(seed: number | undefined, target: { count: number }) { class Inner { constructor(x = ++target.count) { void x; } } const a0 = seed; const a1 = flag ? a0 : a0; const a2 = flag ? a1 : a1; void new Inner(a2); } } const local = { count: 0 }; return Object.isFrozen(flag ? new Outer(maybeUndefined, local) : new Outer(1, input));',
    expected: undefined,
    id: 'unproven-call-cache-does-not-poison-later-defined-parameter-call',
  },
  {
    body: 'class Box { constructor(x = ++input.count) { void x; } } var a: number | undefined = flag ? b : 1; var b: number | undefined = flag ? a : 1; return Object.isFrozen(new Box(a));',
    expected: FROZEN_REASON,
    id: 'cyclic-var-conditional-aliases-stay-unproven-without-looping',
  },
] as const;

describe('memoized defined-argument proofs across conditional alias diamonds', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(SCALING_CASES)('$id', ({ body, expected }) => {
    const measured = measureDiamondReads(api, body);

    expect(measured.answer).toBe(expected);
    expect(measured.aliasReads).toBeLessThanOrEqual(LIMITS.maxAliasReads);
  });

  it.each(SEMANTIC_CASES)('$id', ({ body, expected }) => {
    expect(evaluateMetadata(api, body)).toBe(expected);
  });
});

/** Runs `inputMetadata` while counting initializer reads on `a1`'s declaration list. */
function measureDiamondReads(
  api: API,
  body: string,
): { readonly aliasReads: number; readonly answer: string | undefined } {
  using parsed = parseModule(
    api,
    'input-defined-argument-cache.ts',
    `export function check(input: { count: number }, flag: boolean, maybeUndefined?: number): boolean { ${body} }\n`,
  );
  const { aliasList, target } = locateTargets(parsed.sourceFile, body);
  const original = aliasList.getText.bind(aliasList);
  let aliasReads = 0;
  const spy = vi.spyOn(aliasList, 'getText').mockImplementation((file) => {
    aliasReads += 1;
    if (aliasReads > LIMITS.abortReads) {
      throw new Error(`Exceeded ${String(LIMITS.abortReads)} reads of a1 (${String(aliasReads)})`);
    }
    return original(file);
  });
  try {
    const answer = inputMetadata(target);
    return { aliasReads, answer };
  } finally {
    spy.mockRestore();
  }
}

/** Evaluates `inputMetadata` on the `Object.isFrozen(...)` call in `body`. */
function evaluateMetadata(api: API, body: string): string | undefined {
  using parsed = parseModule(
    api,
    'input-defined-argument-semantics.ts',
    `export function check(input: { count: number }, flag: boolean, maybeUndefined?: number): boolean { ${body} }\n`,
  );
  return inputMetadata(locateTargets(parsed.sourceFile, body).target);
}

/** Finds `a1`'s `VariableDeclarationList` (when present) and the `Object.isFrozen` call. */
function locateTargets(
  root: Node,
  body: string,
): { readonly aliasList: Node; readonly target: CallExpression } {
  let target: CallExpression | undefined;
  let aliasList: Node = root;
  const pending: Node[] = [root];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isVariableDeclaration(at) && isIdentifier(at.name) && at.name.text === 'a1') {
      aliasList = at.parent;
    }
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
  return { aliasList, target };
}
