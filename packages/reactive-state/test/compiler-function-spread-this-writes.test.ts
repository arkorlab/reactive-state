import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";

/**
 * When a method or function property is copied onto another object literal via spread (or member
 * reference) and mutates or escapes `this`, calling it on the destination receiver writes to the
 * destination object at runtime even when the destination literal overrode the mutated entry key.
 */
const CASES = [
  {
    id: 'spread-method-this-dot-write-invalidates-overridden-entry-alias',
    reason: NAME_REASON,
    source:
      'export function out() { const base = { pick() {}, swap() { this.pick = function named() {}; } }; const helpers = { ...base, pick() {} }; helpers.swap(); const p = helpers.pick; return p.name; }',
  },
  {
    id: 'spread-method-this-dot-write-invalidates-overridden-entry-direct',
    reason: NAME_REASON,
    source:
      'function named() {} const base = { pick() {}, swap() { this.pick = named; } }; const helpers = { ...base, pick() {} }; helpers.swap(); export const out = helpers.pick.name;',
  },
  {
    id: 'transitive-spread-method-this-write-invalidates-overridden-entry',
    reason: NAME_REASON,
    source:
      'function named() {} const base = { swap() { this.pick = named; } }; const middle = { ...base, keep() {} }; const helpers = { ...middle, pick() {} }; helpers.swap(); export const out = helpers.pick.name;',
  },
  {
    id: 'spread-method-object-assign-this-invalidates-overridden-entry',
    reason: NAME_REASON,
    source:
      'function named() {} const base = { swap() { Object.assign(this, { pick: named }); } }; const helpers = { ...base, pick() {} }; helpers.swap(); export const out = helpers.pick.name;',
  },
  {
    id: 'spread-method-define-property-this-invalidates-overridden-entry',
    reason: NAME_REASON,
    source:
      "function named() {} const base = { swap() { Object.defineProperty(this, 'pick', { value: named }); } }; const helpers = { ...base, pick() {} }; helpers.swap(); export const out = helpers.pick.name;",
  },
  {
    id: 'spread-method-dynamic-bracket-this-write-invalidates-overridden-entry',
    reason: NAME_REASON,
    source:
      "function named() {} export function out(key: 'pick') { const base: Record<string, () => void> = { swap() { this[key] = named; } }; const helpers = { ...base, pick() {} }; helpers.swap!(); return helpers.pick.name; }",
  },
  {
    id: 'spread-function-property-arrow-and-const-this-alias-write',
    reason: NAME_REASON,
    source:
      'function named() {} const base = { pick() {}, swap: function () { const self = this; (() => { self.pick = named; })(); } }; const helpers = { ...base, pick() {} }; helpers.swap(); export const out = helpers.pick.name;',
  },
  {
    id: 'spread-method-escaping-this-to-helper-invalidates-destination',
    reason: NAME_REASON,
    source:
      'function named() {} function overwrite(target: { pick: () => void }) { target.pick = named; } const base = { pick() {}, swap() { overwrite(this); } }; const helpers = { ...base, pick() {} }; helpers.swap(); export const out = helpers.pick.name;',
  },
  {
    id: 'conditional-spread-carrying-this-writing-method-invalidates-destination',
    reason: NAME_REASON,
    source:
      'function named() {} export function out(flag: boolean) { const base = { swap() { this.pick = named; } }; const helpers = { ...(flag ? base : {}), pick() {} }; helpers.swap?.(); return helpers.pick.name; }',
  },
  {
    id: 'property-copied-this-writing-method-invalidates-destination-entry',
    reason: NAME_REASON,
    source:
      'function named() {} const base = { swap() { this.pick = named; } }; const helpers = { pick() {}, run: base.swap }; helpers.run(); export const out = helpers.pick.name;',
  },
  {
    id: 'spread-method-writing-unrelated-this-key-keeps-overridden-pick-pin',
    reason: undefined,
    source:
      'function named() {} const base = { pick() {}, other() {}, swap() { this.other = named; } }; const helpers = { ...base, pick() {} }; helpers.swap(); export const out = helpers.pick.name;',
  },
  {
    id: 'destination-overwriting-this-writing-method-keeps-pick-entry-pin',
    reason: undefined,
    source:
      'function named() {} const base = { pick() {}, swap() { this.pick = named; } }; const helpers = { ...base, swap() {}, pick() {} }; helpers.swap(); export const out = helpers.pick.name;',
  },
  {
    id: 'external-base-mutation-without-this-writer-overridden-by-destination-pin',
    reason: undefined,
    source:
      'function named() {} const base = { pick() {} }; base.pick = named; const helpers = { ...base, pick() {} }; export const out = helpers.pick.name;',
  },
  {
    id: 'spread-method-freezing-this-keeps-destination-entry-pin',
    reason: undefined,
    source:
      'const base = { pick() {}, lock() { Object.freeze(this); } }; const helpers = { ...base, pick() {} }; helpers.lock(); export const out = helpers.pick.name;',
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

describe('receiver writes through spread-copied and aliased object methods', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-spread-this-writes.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
