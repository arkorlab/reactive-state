import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";
const TOSTRING_REASON = "reads `toString` of a function, which each side's bundle writes otherwise";

/**
 * Destructuring bindings combine the selected source slot with any default initializer along the
 * binding pattern: a function or unproven default withholds a `'non-function'` proof (and propagates
 * `'renamed'` or `'entry'`), whereas bindings whose source slot and default both prove non-callable
 * still clear earlier function entries across spreads.
 */
const CASES = [
  {
    id: 'defaulted-destructured-function-spread-does-not-clear-renamed-entry',
    reason: NAME_REASON,
    source:
      'function named() {} const source = { pick: void 0 }; const { pick = named } = source; const methods = { pick: named }; const data = { pick }; const helpers = { ...methods, ...data }; export const out = helpers.pick.name;',
  },
  {
    id: 'defaulted-destructured-function-spread-degrades-earlier-method-entry',
    reason: NAME_REASON,
    source:
      'function named() {} const source = { pick: void 0 }; const { pick = named } = source; const methods = { pick() {} }; const data = { pick }; const helpers = { ...methods, ...data }; export const out = helpers.pick.name;',
  },
  {
    id: 'direct-name-read-on-destructured-binding-with-declared-default',
    reason: NAME_REASON,
    source:
      'function named() {} const source = { pick: void 0 }; const { pick = named } = source; export const out = pick.name;',
  },
  {
    id: 'direct-name-read-on-destructured-binding-with-arrow-default',
    reason: NAME_REASON,
    source:
      'const source = { pick: void 0 }; const { pick = () => {} } = source; export const out = pick.name;',
  },
  {
    id: 'unproven-destructured-default-withholds-non-function-overwrite',
    reason: NAME_REASON,
    source:
      'function named() {} export function out(fallback: unknown) { const source = { pick: void 0 }; const { pick = fallback } = source; const methods = { pick: named }; const data = { pick }; const helpers = { ...methods, ...data }; return (helpers.pick as () => void).name; }',
  },
  {
    id: 'nested-object-destructuring-inner-function-default',
    reason: NAME_REASON,
    source:
      'function named() {} const source = { inner: { pick: void 0 } }; const { inner: { pick = named } } = source; const data = { pick }; export const out = data.pick.name;',
  },
  {
    id: 'nested-object-destructuring-outer-pattern-function-default',
    reason: NAME_REASON,
    source:
      'function named() {} const source: { inner?: { pick: () => void } } = {}; const { inner: { pick } = { pick: named } } = source; export const out = pick.name;',
  },
  {
    id: 'array-destructuring-function-default-shorthand-entry',
    reason: NAME_REASON,
    source:
      'function named() {} const [pick = named] = [void 0]; const data = { pick }; export const out = data.pick.name;',
  },
  {
    id: 'parameter-destructuring-function-default-name-read',
    reason: NAME_REASON,
    source:
      'function named() {} export function out({ pick = named }: { pick?: () => void }) { return pick.name; }',
  },
  {
    id: 'parameter-whole-object-default-with-renamed-entry-name-read',
    reason: NAME_REASON,
    source:
      'function named() {} export function out({ pick }: { pick: () => void } = { pick: named }) { return pick.name; }',
  },
  {
    id: 'entry-method-default-over-undefined-slot-still-refuses-tostring',
    reason: TOSTRING_REASON,
    source:
      'const fallback = { pick() {} }; const source = { pick: void 0 }; const { pick = fallback.pick } = source; export const out = pick.toString();',
  },
  {
    id: 'entry-method-default-over-undefined-slot-preserves-entry-name-pin',
    reason: undefined,
    source:
      'const fallback = { pick() {} }; const source = { pick: void 0 }; const { pick = fallback.pick } = source; export const out = pick.name;',
  },
  {
    id: 'non-function-source-and-non-function-default-clears-renamed-spread-pin',
    reason: undefined,
    source:
      "function named() {} const source = { pick: void 0 }; const { pick = { name: 'fixed' } } = source; const methods = { pick: named }; const data = { pick }; const helpers = { ...methods, ...data }; export const out = helpers.pick.name;",
  },
  {
    id: 'omitted-clean-key-and-non-function-default-clears-renamed-spread-pin',
    reason: undefined,
    source:
      "function named() {} const source: { pick?: { name: string } } = {}; const { pick = { name: 'fixed' } } = source; const methods = { pick: named }; const data = { pick }; const helpers = { ...methods, ...data }; export const out = helpers.pick.name;",
  },
  {
    id: 'plain-destructured-non-function-without-default-clears-spread-pin',
    reason: undefined,
    source:
      "function named() {} const source = { pick: { name: 'fixed' } }; const { pick } = source; const methods = { pick: named }; const data = { pick }; const helpers = { ...methods, ...data }; export const out = helpers.pick.name;",
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

describe('function classification across destructuring defaults and nested patterns', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-destructuring-defaults.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
