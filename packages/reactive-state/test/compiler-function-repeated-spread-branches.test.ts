import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";
const TEXT_REASON = "writes a function as text, which each side's bundle writes otherwise";

function buildEmptySpreadDiamond(): string {
  const depth = 18;
  const parts = ['const m0 = {};'];
  for (let index = 1; index <= depth; index += 1) {
    parts.push(`const m${index} = { ...m${index - 1}, ...m${index - 1} };`);
  }
  return parts.join(' ');
}

/**
 * Each spread branch inside `resolvePropertyValue` runs with an isolated cycle-detection branch
 * while memoizing acyclic `(object, key)` lookups, so repeated spreads of shared clean objects do
 * not shadow earlier spread sources.
 */
const CASES = [
  {
    id: 'repeated-empty-spread-nested-destructuring-string',
    reason: TEXT_REASON,
    source:
      'function named() {} const payload = { nested: { pick: named } }; const blank = {}; const holder = { ...payload, ...blank, ...blank }; const { nested: { pick } } = holder; export const out = String(pick);',
  },
  {
    id: 'repeated-empty-spread-nested-destructuring-name',
    reason: NAME_REASON,
    source:
      'function named() {} const payload = { nested: { pick: named } }; const blank = {}; const holder = { ...payload, ...blank, ...blank }; const { nested: { pick } } = holder; export const out = pick.name;',
  },
  {
    id: 'shared-diamond-leaf-across-sibling-spreads-nested-destructuring',
    reason: TEXT_REASON,
    source:
      'function named() {} const payload = { nested: { pick: named } }; const shared = {}; const left = { ...shared }; const right = { ...shared }; const holder = { ...payload, ...left, ...right }; const { nested: { pick } } = holder; export const out = String(pick);',
  },
  {
    id: 'repeated-unrelated-key-spread-nested-destructuring',
    reason: NAME_REASON,
    source:
      'function named() {} const payload = { nested: { pick: named } }; const meta = { version: 1 }; const holder = { ...payload, ...meta, ...meta }; const { nested: { pick } } = holder; export const out = pick.name;',
  },
  {
    id: 'deep-repeated-empty-spread-diamond-nested-destructuring',
    reason: TEXT_REASON,
    source: `function named() {} const payload = { nested: { pick: named } }; ${buildEmptySpreadDiamond()} const holder = { ...payload, ...m18 }; const { nested: { pick } } = holder; export const out = String(pick);`,
  },
  {
    id: 'repeated-spread-chained-member-projection-name',
    reason: NAME_REASON,
    source:
      'function named() {} const payload = { nested: { pick: named } }; const blank = {}; const holder = { ...payload, ...blank, ...blank }; export const out = holder.nested.pick.name;',
  },
  {
    id: 'repeated-spread-two-step-destructured-holder-string',
    reason: TEXT_REASON,
    source:
      'function named() {} const payload = { nested: { pick: named } }; const blank = {}; const holder = { ...payload, ...blank, ...blank }; const { nested } = holder; export const out = String(nested.pick);',
  },
  {
    id: 'repeated-empty-spread-nested-escaped-method-name',
    reason: NAME_REASON,
    source:
      'const payload = { nested: { pick() {} } }; const blank = {}; const holder = { ...payload, ...blank, ...blank }; const { nested: { pick } } = holder; export const out = pick.name;',
  },
  {
    id: 'repeated-empty-spread-top-level-entry-method-name-safe-pin',
    reason: undefined,
    source:
      'const payload = { pick() {} }; const blank = {}; const holder = { ...payload, ...blank, ...blank }; const { pick } = holder; export const out = pick.name;',
  },
  {
    id: 'later-spread-overriding-nested-with-non-function-safe-pin',
    reason: undefined,
    source:
      "function named() {} const payload = { nested: { pick: named } }; const override = { nested: { pick: 'ready' } }; const blank = {}; const holder = { ...payload, ...override, ...blank, ...blank }; const { nested: { pick } } = holder; export const out = String(pick);",
  },
  {
    id: 'genuine-mutual-spread-cycle-terminates-cleanly-pin',
    reason: undefined,
    source:
      "const a: Record<string, unknown> = { ...b }; const b: Record<string, unknown> = { ...a }; const { nested: { pick } = { pick: 'ok' } } = a as { nested?: { pick: string } }; export const out = String(pick);",
  },
] as const;

/** First `functionRead` diagnostic encountered in pre-order across `root`. */
function firstFunctionRead(root: Node): string | undefined {
  let found: string | undefined;
  const visit = (node: Node): void => {
    if (found !== undefined) {
      return;
    }
    found = functionRead(node);
    if (found === undefined) {
      node.forEachChild(visit);
    }
  };
  visit(root);
  return found;
}

describe('isolated spread branch cycle state during nested property resolution', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'virtual.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
