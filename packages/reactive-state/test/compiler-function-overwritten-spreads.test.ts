import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";
const TOSTRING_REASON = "reads `toString` of a function, which each side's bundle writes otherwise";

/**
 * When every `'renamed'` static key contributed by an earlier property or an unchanged `const`
 * object spread is unconditionally overwritten by a later static `'entry'` (or non-function) key,
 * dynamic `.name` lookups on the surviving table read only invariant entry names — whereas
 * partially overwritten, mutable, mutated, computed-key or unknown spreads remain `'renamed'`.
 */
const CASES = [
  {
    id: 'later-method-overwrites-renamed-spread-dynamic-lookup',
    reason: undefined,
    source:
      'function named() {} const extra = { pick: named }; const helpers = { ...extra, pick() {} }; export function out(key: keyof typeof helpers) { return helpers[key].name; }',
  },
  {
    id: 'later-anonymous-arrow-overwrites-renamed-spread-dynamic-lookup',
    reason: undefined,
    source:
      'function named() {} const extra = { pick: named }; const helpers = { ...extra, pick: () => {} }; export function out(key: keyof typeof helpers) { return helpers[key].name; }',
  },
  {
    id: 'later-constant-spread-overwrites-earlier-renamed-spread-dynamic-lookup',
    reason: undefined,
    source:
      'function named() {} const base = { pick: named, keep() {} }; const override = { pick() {} }; const helpers = { ...base, ...override }; export function out(key: keyof typeof helpers) { return helpers[key].name; }',
  },
  {
    id: 'later-method-overwrites-earlier-duplicate-static-renamed-key',
    reason: undefined,
    source:
      'function named() {} const helpers = { pick: named, pick() {} }; export function out(key: keyof typeof helpers) { return helpers[key].name; }',
  },
  {
    id: 'later-non-function-overwrites-renamed-spread-beside-method',
    reason: undefined,
    source:
      "function named() {} const extra = { dropped: named }; const helpers = { ...extra, dropped: { name: 'none' }, keep() {} }; export function out(key: keyof typeof helpers) { return helpers[key].name; }",
  },
  {
    id: 'overwritten-spread-still-refuses-function-source-read-pin',
    reason: TOSTRING_REASON,
    source:
      'function named() {} const extra = { pick: named }; const helpers = { ...extra, pick() {} }; export function out(key: keyof typeof helpers) { return helpers[key].toString(); }',
  },
  {
    id: 'partially-overwritten-renamed-spread-still-refused-pin',
    reason: NAME_REASON,
    source:
      'function named() {} const extra = { pick: named, other: named }; const helpers = { ...extra, pick() {} }; export function out(key: keyof typeof helpers) { return helpers[key].name; }',
  },
  {
    id: 'mutable-let-spread-not-cleared-by-later-method-pin',
    reason: NAME_REASON,
    source:
      'function named() {} let extra: Record<string, () => void> = { pick: named }; extra = { other: named }; const helpers = { ...extra, pick() {} }; export function out(key: string) { return helpers[key]!.name; }',
  },
  {
    id: 'mutated-const-spread-not-cleared-by-later-method-pin',
    reason: NAME_REASON,
    source:
      'function named() {} const extra: Record<string, () => void> = { pick: named }; extra.other = named; const helpers = { ...extra, pick() {} }; export function out(key: string) { return helpers[key]!.name; }',
  },
  {
    id: 'computed-dynamic-renamed-key-in-spread-not-cleared-by-later-method-pin',
    reason: NAME_REASON,
    source:
      'function named() {} export function out(dynamicKey: string, key: string) { const extra: Record<string, () => void> = { [dynamicKey]: named }; const helpers = { ...extra, pick() {} }; return helpers[key]!.name; }',
  },
  {
    id: 'unknown-parameter-spread-before-later-method-still-refused-pin',
    reason: NAME_REASON,
    source:
      'export function out(extra: Record<string, () => void>, key: string) { const helpers = { ...extra, pick() {} }; return helpers[key]!.name; }',
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

describe('overwritten static keys across spreads in dynamic function table lookups', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-overwritten-spreads.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
