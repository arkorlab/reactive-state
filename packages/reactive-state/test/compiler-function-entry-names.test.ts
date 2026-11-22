import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";
const TOSTRING_REASON = "reads `toString` of a function, which each side's bundle writes otherwise";

/**
 * Whether `fn.name` is invariant across server and client bundles depends on where the function
 * received its runtime `.name`, not on whether the `.name` read sits on a member expression:
 * methods and anonymous functions assigned directly to static object entries receive the unchanged
 * property key, whereas declared functions, shorthand bindings, variable arrows and named function
 * or class expressions carry minifiable names even when placed in an object literal.
 */
const CASES = [
  {
    id: 'object-entry-referencing-declared-function',
    reason: NAME_REASON,
    source:
      'function named() {} const helpers = { pick: named }; export const out = helpers.pick.name;',
  },
  {
    id: 'object-shorthand-referencing-declared-function',
    reason: NAME_REASON,
    source: 'function pick() {} const helpers = { pick }; export const out = helpers.pick.name;',
  },
  {
    id: 'object-entry-referencing-variable-arrow',
    reason: NAME_REASON,
    source:
      'const named = () => {}; const helpers = { pick: named }; export const out = helpers.pick.name;',
  },
  {
    id: 'object-entry-with-named-function-expression',
    reason: NAME_REASON,
    source: 'const helpers = { pick: function named() {} }; export const out = helpers.pick.name;',
  },
  {
    id: 'object-entry-with-named-class-expression',
    reason: NAME_REASON,
    source: 'const helpers = { pick: class Named {} }; export const out = helpers.pick.name;',
  },
  {
    id: 'bracket-entry-referencing-declared-function',
    reason: NAME_REASON,
    source:
      "function named() {} const helpers = { pick: named }; export const out = helpers['pick'].name;",
  },
  {
    id: 'const-destructured-entry-referencing-declared-function',
    reason: NAME_REASON,
    source:
      'function named() {} const helpers = { pick: named }; const { pick } = helpers; export const out = pick.name;',
  },
  {
    id: 'const-destructured-object-method-tostring',
    reason: TOSTRING_REASON,
    source:
      'const helpers = { pick() {} }; const { pick } = helpers; export const out = pick.toString();',
  },
  {
    id: 'const-alias-of-object-method-name',
    reason: undefined,
    source: 'const helpers = { pick() {} }; const p = helpers.pick; export const out = p.name;',
  },
  {
    id: 'const-destructured-object-method-name',
    reason: undefined,
    source:
      'const helpers = { pick() {} }; const { pick } = helpers; export const out = pick.name;',
  },
  {
    id: 'mutable-let-alias-of-object-method-name-refused-pin',
    reason: NAME_REASON,
    source: 'const helpers = { pick() {} }; let p = helpers.pick; export const out = p.name;',
  },
  {
    id: 'direct-object-method-name-pin',
    reason: undefined,
    source: 'const helpers = { pick() {} }; export const out = helpers.pick.name;',
  },
  {
    id: 'direct-anonymous-arrow-entry-name-pin',
    reason: undefined,
    source: 'const helpers = { pick: () => {} }; export const out = helpers.pick.name;',
  },
  {
    id: 'const-alias-of-object-method-tostring-still-refused-pin',
    reason: TOSTRING_REASON,
    source:
      'const helpers = { pick() {} }; const p = helpers.pick; export const out = p.toString();',
  },
  {
    id: 'constructor-name-on-unknown-value-pin',
    reason: undefined,
    source: 'export function kind(value: string) { return value.constructor.name; }',
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

describe('function name classification across object entries and aliases', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-entry-names.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
