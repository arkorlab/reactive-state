import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";

/**
 * Destructuring bindings introduce distinct local targets rather than aliasing the outer container
 * initializer: spreads, prototype links, and member assignments through destructured object
 * bindings resolve the selected inner object literal, array destructuring resolves inner array
 * literals, and sibling defaults within one pattern do not collide in cycle tracking.
 */
const CASES = [
  {
    id: 'destructured-object-spread-method-this-write-invalidates-destination',
    reason: NAME_REASON,
    source:
      'function named() {} const outer = { base: { swap() { this.pick = named; } } }; const { base } = outer; const helpers = { ...base, pick() {} }; helpers.swap(); export const out = helpers.pick.name;',
  },
  {
    id: 'destructured-alias-member-callable-write-propagates-to-inner-literal',
    reason: NAME_REASON,
    source:
      'function named() {} const innerObj: { swap?: () => void } = {}; const outer = { inner: innerObj }; const { inner } = outer; inner.swap = function () { (this as { pick?: () => void }).pick = named; }; const helpers = { ...innerObj, pick() {} }; (helpers as { swap?: () => void }).swap?.(); export const out = helpers.pick.name;',
  },
  {
    id: 'destructured-alias-member-callable-write-does-not-pollute-outer-literal',
    reason: undefined,
    source:
      'function named() {} const innerObj: { swap?: () => void } = {}; const outer = { inner: innerObj, pick() {} }; const { inner } = outer; inner.swap = function () { (this as { pick?: () => void }).pick = named; }; export const out = outer.pick.name;',
  },
  {
    id: 'nested-destructured-object-spread-method-this-write',
    reason: NAME_REASON,
    source:
      'function named() {} const root = { nested: { base: { swap() { this.pick = named; } } } }; const { nested: { base } } = root; const helpers = { ...base, pick() {} }; helpers.swap(); export const out = helpers.pick.name;',
  },
  {
    id: 'destructured-default-object-spread-method-this-write',
    reason: NAME_REASON,
    source:
      'function named() {} const fallback = { swap() { this.pick = named; } }; const outer: { base?: typeof fallback } = {}; const { base = fallback } = outer; const helpers = { ...base, pick() {} }; helpers.swap(); export const out = helpers.pick.name;',
  },
  {
    id: 'property-projected-spread-source-method-this-write',
    reason: NAME_REASON,
    source:
      'function named() {} const outer = { base: { swap() { this.pick = named; } } }; const helpers = { ...outer.base, pick() {} }; helpers.swap(); export const out = helpers.pick.name;',
  },
  {
    id: 'destructured-prototype-source-method-this-write',
    reason: NAME_REASON,
    source:
      'function named() {} const outer = { proto: { swap() { this.pick = named; } } }; const { proto } = outer; const helpers = { __proto__: proto, pick() {} }; (helpers as { swap?: () => void }).swap?.(); export const out = helpers.pick.name;',
  },
  {
    id: 'sibling-variable-destructuring-default-referencing-prior-binding',
    reason: NAME_REASON,
    source:
      'function named() {} const empty = {}; const { first = named, second = first } = empty as { first?: () => void; second?: () => void }; export const out = second.name;',
  },
  {
    id: 'sibling-parameter-destructuring-default-referencing-prior-binding',
    reason: NAME_REASON,
    source:
      'function named() {} export function out({ first = named, second = first }: { first?: () => void; second?: () => void } = {}) { return second.name; }',
  },
  {
    id: 'destructured-array-holder-selects-inner-array-literal',
    reason: NAME_REASON,
    source:
      'function named() {} const [, items] = [0, [named]] as const; const [pick] = items; export const out = pick.name;',
  },
  {
    id: 'destructured-harmless-spread-keeps-destination-method-entry-pin',
    reason: undefined,
    source:
      'const outer = { base: { keep() {} } }; const { base } = outer; const helpers = { ...base, pick() {} }; export const out = helpers.pick.name;',
  },
  {
    id: 'destructured-this-writer-overwritten-on-destination-keeps-entry-pin',
    reason: undefined,
    source:
      'function named() {} const outer = { base: { swap() { this.pick = named; } } }; const { base } = outer; const helpers = { ...base, swap() {}, pick() {} }; helpers.swap(); export const out = helpers.pick.name;',
  },
  {
    id: 'destructured-entry-method-keeps-entry-name-pin',
    reason: undefined,
    source:
      'const methods = { pick() {} }; const { pick } = methods; export const out = pick.name;',
  },
  {
    id: 'destructured-non-function-nested-array-stays-accepted-pin',
    reason: undefined,
    source:
      'const [items] = [[0]] as const; const [count] = items; export const out = String(count);',
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

describe('destructured object and array holders in function entry analysis', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-destructured-holders.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
