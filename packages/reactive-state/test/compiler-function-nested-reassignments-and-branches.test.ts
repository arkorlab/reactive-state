import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";
const SOURCE_REASON = "writes a function as text, which each side's bundle writes otherwise";
const TOSTRING_REASON = "reads `toString` of a function, which each side's bundle writes otherwise";

/**
 * Nested object/array destructuring assignments record full selection paths for inner mutable
 * bindings, conditional/logical/reassigned candidate-object branches isolate `seen` per active
 * path, and post-declaration copies of proven entry-named methods preserve `'entry'` `.name`
 * invariance unless joined with minifiable or uncertain writes.
 */
const CASES = [
  {
    id: 'nested-object-destructuring-reassignment-name',
    reason: NAME_REASON,
    source:
      'function named() {} let pick: unknown; ({ nested: { pick } } = { nested: { pick: named } }); export const out = (pick as Function).name;',
  },
  {
    id: 'nested-array-in-object-destructuring-reassignment-tostring',
    reason: TOSTRING_REASON,
    source:
      'function named() {} export function out() { let pick: unknown = null; ({ items: [pick] } = { items: [named] }); return (pick as () => void).toString(); }',
  },
  {
    id: 'nested-object-in-array-destructuring-reassignment-source',
    reason: SOURCE_REASON,
    source:
      'function named() {} export function out() { let pick: unknown; ([{ pick }] = [{ pick: named }]); return String(pick); }',
  },
  {
    id: 'nested-two-dimensional-array-destructuring-reassignment-name',
    reason: NAME_REASON,
    source:
      "function named() {} export function out() { let pick: unknown; ([[, pick]] = [['skip', named]]); return (pick as () => void).name; }",
  },
  {
    id: 'nested-object-intermediate-default-destructuring-reassignment',
    reason: NAME_REASON,
    source:
      'function named() {} export function out(holder: { outer?: { nested: { pick: () => void } } }) { let pick: unknown; ({ outer: { nested: { pick } } = { nested: { pick: named } } } = holder); return (pick as () => void).name; }',
  },
  {
    id: 'nested-object-leaf-default-destructuring-reassignment',
    reason: NAME_REASON,
    source:
      'function named() {} export function out(holder: { nested: { pick?: () => void } }) { let pick: unknown; ({ nested: { pick = named } } = holder); return (pick as () => void).name; }',
  },
  {
    id: 'array-destructuring-reassignment-before-rest-element',
    reason: NAME_REASON,
    source:
      "function named() {} export function out() { let pick: unknown; let rest: unknown[]; [pick, ...rest] = [named, 'extra']; void rest; return (pick as () => void).name; }",
  },
  {
    id: 'array-destructuring-reassignment-nested-inside-rest-pattern',
    reason: NAME_REASON,
    source:
      "function named() {} export function out() { let first: unknown; let pick: unknown; [first, ...[pick]] = ['skip', named]; void first; return (pick as () => void).name; }",
  },
  {
    id: 'conditional-member-branches-sharing-outer-holder-this-write',
    reason: NAME_REASON,
    source:
      'function named() {} export function out(flag: boolean) { const outer = { a: { swap() {} }, b: { swap() { this.pick = named; } } }; const base = flag ? outer.a : outer.b; const helpers = { ...base, pick() {} }; helpers.swap(); return helpers.pick.name; }',
  },
  {
    id: 'logical-or-member-branches-sharing-outer-holder-this-write',
    reason: NAME_REASON,
    source:
      'function named() {} export function out(first: { swap(): void } | undefined) { const outer = { a: first, b: { swap() { this.pick = named; } } }; const base = outer.a || outer.b; const helpers = { ...base, pick() {} }; helpers.swap(); return helpers.pick.name; }',
  },
  {
    id: 'nullish-coalescing-member-branches-sharing-outer-holder-this-write',
    reason: NAME_REASON,
    source:
      'function named() {} export function out(first: { swap(): void } | null) { const outer = { a: first, b: { swap() { this.pick = named; } } }; const base = outer.a ?? outer.b; const helpers = { ...base, pick() {} }; helpers.swap(); return helpers.pick.name; }',
  },
  {
    id: 'mutable-let-reassigned-from-sibling-outer-member-this-write',
    reason: NAME_REASON,
    source:
      'function named() {} export function out(flag: boolean) { const outer = { a: { swap() {} }, b: { swap() { this.pick = named; } } }; let base = outer.a; if (flag) base = outer.b; const helpers = { ...base, pick() {} }; helpers.swap(); return helpers.pick.name; }',
  },
  {
    id: 'copied-entry-method-on-empty-object-preserves-entry-name',
    reason: undefined,
    source:
      'const source = { pick() {} }; const target: { pick?: () => void } = {}; target.pick = source.pick; export const out = target.pick!.name;',
  },
  {
    id: 'copied-anonymous-arrow-entry-via-const-alias-preserves-entry-name',
    reason: undefined,
    source:
      'const source = { pick: () => {} }; const fn = source.pick; const target: { pick?: () => void } = {}; target.pick = fn; export const out = target.pick!.name;',
  },
  {
    id: 'copied-entry-method-still-refuses-tostring-pin',
    reason: TOSTRING_REASON,
    source:
      'const source = { pick() {} }; const target: { pick?: () => void } = {}; target.pick = source.pick; export const out = target.pick!.toString();',
  },
  {
    id: 'copied-entry-method-joined-with-renamed-write-still-refuses-name-pin',
    reason: NAME_REASON,
    source:
      'function named() {} const source = { pick() {} }; export function out(flag: boolean) { const target: { pick?: () => void } = {}; if (flag) target.pick = named; else target.pick = source.pick; return target.pick.name; }',
  },
  {
    id: 'copied-entry-method-spread-over-renamed-entry-still-refuses-name-pin',
    reason: NAME_REASON,
    source:
      'function named() {} const source = { pick() {} }; export function out(flag: boolean) { const target: { pick?: () => void } = {}; if (flag) target.pick = source.pick; const merged = { pick: named, ...target }; return merged.pick.name; }',
  },
  {
    id: 'nested-destructuring-reassignment-of-strings-stays-accepted-pin',
    reason: undefined,
    source:
      "export function out() { let pick = 'initial'; ({ nested: { pick } } = { nested: { pick: 'next' } }); return String(pick); }",
  },
  {
    id: 'conditional-harmless-branches-sharing-outer-holder-stays-accepted-pin',
    reason: undefined,
    source:
      'export function out(flag: boolean) { const outer = { a: { swap() {} }, b: { swap() {} } }; const base = flag ? outer.a : outer.b; const helpers = { ...base, pick() {} }; helpers.swap(); return helpers.pick.name; }',
  },
] as const;

/** First `functionRead` diagnostic encountered in pre-order across `root`. */
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

describe('nested destructuring reassignments, branch-local candidates, and entry method copies', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'virtual.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
