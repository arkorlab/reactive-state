import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";

/**
 * A `const` object binding keeps the variable reference fixed, not its own properties: replacing
 * an entry via member assignment, dynamic key write, `Object.assign` or an escaping helper call
 * can overwrite an object method with a minifiable function whose `.name` differs across bundles.
 */
const CASES = [
  {
    id: 'replaced-method-via-dot-then-const-alias-name',
    reason: NAME_REASON,
    source:
      'const helpers = { pick() {} }; helpers.pick = function named() {}; const p = helpers.pick; export const out = p.name;',
  },
  {
    id: 'replaced-method-via-dot-direct-name',
    reason: NAME_REASON,
    source:
      'const helpers = { pick() {} }; helpers.pick = function named() {}; export const out = helpers.pick.name;',
  },
  {
    id: 'replaced-method-via-static-bracket-then-destructured-name',
    reason: NAME_REASON,
    source:
      "const helpers = { pick() {} }; helpers['pick'] = function named() {}; const { pick } = helpers; export const out = pick.name;",
  },
  {
    id: 'replaced-method-via-dynamic-bracket-then-alias-name',
    reason: NAME_REASON,
    source:
      "export function out(key: 'pick') { const helpers = { pick() {} }; helpers[key] = function named() {}; const p = helpers.pick; return p.name; }",
  },
  {
    id: 'replaced-method-via-object-assign-then-alias-name',
    reason: NAME_REASON,
    source:
      'function named() {} const helpers = { pick() {} }; Object.assign(helpers, { pick: named }); const p = helpers.pick; export const out = p.name;',
  },
  {
    id: 'replaced-method-via-helper-call-then-alias-name',
    reason: NAME_REASON,
    source:
      'function replace(target: { pick: () => void }) { target.pick = function named() {}; } const helpers = { pick() {} }; replace(helpers); const p = helpers.pick; export const out = p.name;',
  },
  {
    id: 'replaced-sibling-entry-in-dynamic-table-lookup-name',
    reason: NAME_REASON,
    source:
      "export function out(key: 'pick' | 'keep') { const helpers = { pick() {}, keep() {} }; helpers.pick = function named() {}; return helpers[key].name; }",
  },
  {
    id: 'unreplaced-sibling-method-const-alias-name-pin',
    reason: undefined,
    source:
      'const helpers = { pick() {}, keep() {} }; helpers.pick = function named() {}; const k = helpers.keep; export const out = k.name;',
  },
  {
    id: 'frozen-object-method-const-alias-name-pin',
    reason: undefined,
    source:
      'const helpers = { pick() {} }; Object.freeze(helpers); const p = helpers.pick; export const out = p.name;',
  },
  {
    id: 'unchanged-object-method-passed-entry-name-to-call-pin',
    reason: undefined,
    source:
      'function id(text: string) { return text; } const helpers = { pick() {} }; const seen = id(helpers.pick.name); const p = helpers.pick; export const out = seen + p.name;',
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

describe('function entry name checks after post-declaration object writes', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-replaced-entries.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
