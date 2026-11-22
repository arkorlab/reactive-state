import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";

/**
 * Arrow functions inherit lexical `this` from their enclosing method, getter, setter or function
 * property rather than binding a separate receiver, so property assignments, whole-object mutators
 * and direct `this` escapes inside nested arrows still replace entries on the enclosing object.
 */
const CASES = [
  {
    id: 'arrow-inside-method-dot-replaces-entry',
    reason: NAME_REASON,
    source:
      'function named() {} const helpers = { pick() {}, swap() { const run = () => { this.pick = named; }; run(); } }; export const out = helpers.pick.name;',
  },
  {
    id: 'nested-arrow-callback-inside-method-bracket-replaces-entry',
    reason: NAME_REASON,
    source:
      "function named() {} const helpers = { pick() {}, swap() { [0].forEach(() => { this['pick'] = named; }); } }; export const out = helpers.pick.name;",
  },
  {
    id: 'arrow-inside-getter-assigns-object-entries',
    reason: NAME_REASON,
    source:
      'function named() {} const helpers = { pick() {}, get current() { return (() => Object.assign(this, { pick: named }))(); } }; export const out = helpers.pick.name;',
  },
  {
    id: 'arrow-inside-function-expression-property-replaces-entry',
    reason: NAME_REASON,
    source:
      'function named() {} const helpers = { pick() {}, swap: function () { (() => { this.pick = named; })(); } }; export const out = helpers.pick.name;',
  },
  {
    id: 'const-this-alias-inside-arrow-in-method-replaces-entry',
    reason: NAME_REASON,
    source:
      'function named() {} const helpers = { pick() {}, swap() { (() => { const self = this; self.pick = named; })(); } }; export const out = helpers.pick.name;',
  },
  {
    id: 'escaping-this-to-helper-inside-arrow-in-method',
    reason: NAME_REASON,
    source:
      'function named() {} function overwrite(target: { pick: () => void }) { target.pick = named; } const helpers = { pick() {}, swap() { (() => { overwrite(this); })(); } }; export const out = helpers.pick.name;',
  },
  {
    id: 'arrow-on-inner-object-writes-outer-method-this',
    reason: NAME_REASON,
    source:
      'function named() {} const helpers = { pick() {}, swap() { const inner = { run: () => { this.pick = named; } }; inner.run(); } }; export const out = helpers.pick.name;',
  },
  {
    id: 'arrow-inside-method-writing-unrelated-entry-keeps-pick-pin',
    reason: undefined,
    source:
      'function named() {} const helpers = { pick() {}, other() {}, swap() { (() => { this.other = named; })(); } }; export const out = helpers.pick.name;',
  },
  {
    id: 'nested-regular-function-inside-method-own-this-pin',
    reason: undefined,
    source:
      'function named() {} const helpers = { pick() {}, swap() { function inner(this: { pick: () => void }) { this.pick = named; } void inner; } }; export const out = helpers.pick.name;',
  },
  {
    id: 'nested-class-field-initializer-inside-method-own-this-pin',
    reason: undefined,
    source:
      'function named() {} const helpers = { pick() {}, make() { return class { pick: () => void = () => {}; reset = () => { this.pick = named; }; }; } }; export const out = helpers.pick.name;',
  },
  {
    id: 'arrow-inside-method-freezing-this-keeps-entry-pin',
    reason: undefined,
    source:
      'const helpers = { pick() {}, lock() { (() => Object.freeze(this))(); } }; export const out = helpers.pick.name;',
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

describe('lexical this entry writes through arrow functions inside object methods', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-arrow-this-writes.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
