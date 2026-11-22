import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";

/**
 * In dynamic bracket lookups (`helpers[key].name`), a spread entry bringing minifiable or unknown
 * function names remains reachable under its own keys regardless of whether safe object methods
 * appear before or after the spread.
 */
const CASES = [
  {
    id: 'spread-between-methods-dynamic-lookup-name',
    reason: NAME_REASON,
    source:
      'function named() {} const extra = { renamed: named }; const helpers = { first() {}, ...extra, last() {} }; export function out(key: keyof typeof helpers) { return helpers[key].name; }',
  },
  {
    id: 'spread-before-method-dynamic-lookup-name',
    reason: NAME_REASON,
    source:
      'function named() {} const extra = { renamed: named }; const helpers = { ...extra, last() {} }; export function out(key: keyof typeof helpers) { return helpers[key].name; }',
  },
  {
    id: 'unknown-spread-between-methods-dynamic-lookup-name',
    reason: NAME_REASON,
    source:
      'export function out(extra: Record<string, () => void>, key: string) { const helpers = { first() {}, ...extra, last() {} }; return helpers[key].name; }',
  },
  {
    id: 'unknown-spread-before-method-dynamic-lookup-name',
    reason: NAME_REASON,
    source:
      'export function out(extra: Record<string, () => void>, key: string) { const helpers = { ...extra, last() {} }; return helpers[key].name; }',
  },
  {
    id: 'spread-only-table-dynamic-lookup-name',
    reason: NAME_REASON,
    source:
      'function named() {} const extra = { renamed: named }; const helpers = { ...extra }; export function out(key: keyof typeof helpers) { return helpers[key].name; }',
  },
  {
    id: 'spread-before-unrelated-method-static-lookup-name',
    reason: NAME_REASON,
    source:
      'function named() {} const extra = { pick: named }; const helpers = { ...extra, last() {} }; export const out = helpers.pick.name;',
  },
  {
    id: 'later-method-overriding-spread-static-lookup-name-pin',
    reason: undefined,
    source:
      'function named() {} const extra = { pick: named }; const helpers = { ...extra, pick() {} }; export const out = helpers.pick.name;',
  },
  {
    id: 'constant-method-spread-with-method-dynamic-lookup-name-pin',
    reason: undefined,
    source:
      'const extra = { first() {} }; const helpers = { ...extra, last() {} }; export function out(key: keyof typeof helpers) { return helpers[key].name; }',
  },
  {
    id: 'unknown-spread-in-non-function-record-dynamic-lookup-pin',
    reason: undefined,
    source:
      "export function out(extra: Record<string, { readonly name: string }>, key: string) { const items = { ...extra, fallback: { name: 'none' } }; return items[key].name; }",
  },
] as const;

/** The first `functionRead` diagnostic encountered in `root`. */
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

describe('function entry name classification across object spreads', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-spread-order.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
