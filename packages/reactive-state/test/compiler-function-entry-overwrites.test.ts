import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";

/**
 * Overwriting an object entry clears an earlier `'entry'` or `'renamed'` function classification
 * only when the replacement is a proven unchanged non-function value (such as ordinary literal or
 * `const` data, directly or through an unchanged `const` spread), whereas getters, accessors,
 * unresolved calls, and mutated or deleted spread keys keep the entry uncertain.
 */
const CASES = [
  {
    id: 'later-getter-does-not-clear-renamed-spread-dynamic-lookup',
    reason: NAME_REASON,
    source:
      'function named() {} const extra = { pick: named }; const helpers = { ...extra, get pick() { return named; } }; export function out(key: keyof typeof helpers) { return helpers[key].name; }',
  },
  {
    id: 'later-getter-does-not-clear-renamed-entry-static-lookup',
    reason: NAME_REASON,
    source:
      'function named() {} const extra = { pick: named }; const helpers = { ...extra, get pick() { return named; } }; export const out = helpers.pick.name;',
  },
  {
    id: 'later-getter-degrades-entry-method-to-renamed-static-lookup',
    reason: NAME_REASON,
    source:
      'function named() {} const extra = { pick() {} }; const helpers = { ...extra, get pick() { return named; } }; export const out = helpers.pick.name;',
  },
  {
    id: 'later-getter-spread-does-not-clear-renamed-spread-dynamic-lookup',
    reason: NAME_REASON,
    source:
      'function named() {} const extra = { pick: named }; const getter = { get pick() { return named; } }; const helpers = { ...extra, ...getter }; export function out(key: keyof typeof helpers) { return helpers[key].name; }',
  },
  {
    id: 'later-unknown-call-does-not-clear-renamed-spread-dynamic-lookup',
    reason: NAME_REASON,
    source:
      "function named() {} export function out(choose: (fn: () => void) => () => void, key: 'pick') { const extra = { pick: named }; const helpers = { ...extra, pick: choose(named) }; return helpers[key].name; }",
  },
  {
    id: 'getter-sibling-beside-method-in-dynamic-lookup',
    reason: NAME_REASON,
    source:
      'function named() {} const helpers = { keep() {}, get pick() { return named; } }; export function out(key: keyof typeof helpers) { return helpers[key].name; }',
  },
  {
    id: 'constant-data-spread-clears-earlier-method-spread-static-lookup',
    reason: undefined,
    source:
      "const methods = { pick() {} }; const data = { pick: { name: 'fixed' } }; const helpers = { ...methods, ...data }; export const out = helpers.pick.name;",
  },
  {
    id: 'constant-data-spread-clears-earlier-renamed-spread-static-lookup',
    reason: undefined,
    source:
      "function named() {} const methods = { pick: named }; const data = { pick: { name: 'fixed' } }; const helpers = { ...methods, ...data }; export const out = helpers.pick.name;",
  },
  {
    id: 'constant-data-spread-clears-function-source-read-static-lookup',
    reason: undefined,
    source:
      "const methods = { pick() {} }; const data = { pick: 'fixed' }; const helpers = { ...methods, ...data }; export const out = String(helpers.pick);",
  },
  {
    id: 'constant-aliased-data-spread-clears-method-when-unrelated-key-mutated',
    reason: undefined,
    source:
      "const fixed = { name: 'fixed' }; const methods = { pick() {} }; const data = { pick: fixed, count: 0 }; data.count = 1; const helpers = { ...methods, ...data }; export const out = helpers.pick.name;",
  },
  {
    id: 'mutated-data-spread-entry-does-not-clear-earlier-method-pin',
    reason: NAME_REASON,
    source:
      "function named() {} const methods = { pick() {} }; const data: { pick: unknown } = { pick: { name: 'fixed' } }; data.pick = named; const helpers = { ...methods, ...data }; export const out = (helpers.pick as () => void).name;",
  },
  {
    id: 'deleted-data-spread-entry-does-not-clear-earlier-renamed-entry-pin',
    reason: NAME_REASON,
    source:
      "function named() {} const methods = { pick: named }; const data: { pick?: { name: string } } = { pick: { name: 'fixed' } }; delete data.pick; const helpers = { ...methods, ...data }; export const out = (helpers.pick as () => void).name;",
  },
  {
    id: 'later-method-overwriting-earlier-getter-restores-entry-pin',
    reason: undefined,
    source:
      'function named() {} const helpers = { get pick() { return named; }, pick() {} }; export function out(key: keyof typeof helpers) { return helpers[key].name; }',
  },
  {
    id: 'non-function-getter-table-without-functions-stays-accepted-pin',
    reason: undefined,
    source:
      "const items = { get pick() { return { name: 'fixed' }; } }; export function out(key: keyof typeof items) { return items[key].name; }",
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

describe('proven non-function overwrites versus unknown getters across object entries', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-entry-overwrites.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
