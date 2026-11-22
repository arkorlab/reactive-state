import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";

/**
 * Storing an object literal holder (or its `this` receiver) inside an untracked local container,
 * returning it, selecting it through a branch or binding default, capturing `Object.seal`'s
 * still-writable return value, or exporting it lets subsequent code replace its entries without
 * writing directly through the original `const` identifier.
 */
const CASES = [
  {
    id: 'holder-stored-in-shorthand-object-container-then-mutated',
    reason: NAME_REASON,
    source:
      'export function out() { const helpers = { pick() {} }; const box = { helpers }; box.helpers.pick = function named() {}; const p = helpers.pick; return p.name; }',
  },
  {
    id: 'holder-stored-in-named-object-property-then-mutated',
    reason: NAME_REASON,
    source:
      'export function out() { const helpers = { pick() {} }; const box = { inner: helpers }; box.inner.pick = function named() {}; return helpers.pick.name; }',
  },
  {
    id: 'holder-stored-in-array-element-then-mutated',
    reason: NAME_REASON,
    source:
      'export function out() { const helpers = { pick() {} }; const list = [helpers]; list[0]!.pick = function named() {}; const { pick } = helpers; return pick.name; }',
  },
  {
    id: 'holder-returned-from-helper-then-mutated',
    reason: NAME_REASON,
    source:
      'export function out() { const helpers = { pick() {} }; const current = () => helpers; current().pick = function named() {}; const p = helpers.pick; return p.name; }',
  },
  {
    id: 'holder-used-as-destructuring-default-then-mutated',
    reason: NAME_REASON,
    source:
      'export function out() { const helpers = { pick() {} }; const { item = helpers } = {} as { item?: typeof helpers }; item.pick = function named() {}; return helpers.pick.name; }',
  },
  {
    id: 'holder-chosen-through-conditional-alias-then-mutated',
    reason: NAME_REASON,
    source:
      'export function out(flag: boolean) { const helpers = { pick() {} }; const chosen = flag ? helpers : helpers; chosen.pick = function named() {}; return helpers.pick.name; }',
  },
  {
    id: 'this-stored-in-object-container-inside-method-then-mutated',
    reason: NAME_REASON,
    source:
      'export function out() { const helpers = { pick() {}, wrap() { return { self: this }; } }; helpers.wrap().self.pick = function named() {}; return helpers.pick.name; }',
  },
  {
    id: 'holder-returned-by-non-discarded-object-seal-then-mutated',
    reason: NAME_REASON,
    source:
      'export function out() { const helpers = { pick() {} }; const sealed = Object.seal(helpers); sealed.pick = function named() {}; const p = helpers.pick; return p.name; }',
  },
  {
    id: 'exported-holder-read-by-exported-function',
    reason: NAME_REASON,
    source:
      'export const helpers = { pick() {} }; export function out() { return helpers.pick.name; }',
  },
  {
    id: 'const-alias-chain-without-container-escape-pin',
    reason: undefined,
    source:
      'const helpers = { pick() {} }; const alias = helpers; const p = alias.pick; export const out = p.name;',
  },
  {
    id: 'destructured-entry-without-container-escape-pin',
    reason: undefined,
    source:
      'const helpers = { pick() {} }; const { pick } = helpers; export const out = pick.name;',
  },
  {
    id: 'spread-copy-into-another-object-mutated-separately-pin',
    reason: undefined,
    source:
      'const helpers = { pick() {} }; const copy = { ...helpers }; copy.pick = function named() {}; const p = helpers.pick; export const out = p.name;',
  },
  {
    id: 'returned-object-freeze-cannot-replace-entries-pin',
    reason: undefined,
    source:
      'export function out() { const helpers = { pick() {} }; const frozen = Object.freeze(helpers); void frozen; return helpers.pick.name; }',
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

describe('function entry invalidation when holder references escape into containers', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-container-escapes.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
