import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";
const TEXT_REASON = "writes a function as text, which each side's bundle writes otherwise";
const TOSTRING_REASON = "reads `toString` of a function, which each side's bundle writes otherwise";

/**
 * Post-declaration property assignments, `Object.defineProperty`, `Object.assign`, and `this`
 * receiver writes retain function evidence on object table entries even when the property started
 * non-callable or omitted.
 */
const CASES = [
  {
    id: 'assigned-function-overwriting-string-entry-string',
    reason: TEXT_REASON,
    source:
      "function named() {} const helpers: { pick: string | (() => void) } = { pick: 'pending' }; helpers.pick = named; export const out = String(helpers.pick);",
  },
  {
    id: 'assigned-function-overwriting-string-entry-name',
    reason: NAME_REASON,
    source:
      "function named() {} const helpers: { pick: string | (() => void) } = { pick: 'pending' }; helpers.pick = named; export const out = helpers.pick.name;",
  },
  {
    id: 'assigned-arrow-on-initially-empty-object-name',
    reason: NAME_REASON,
    source:
      'const helpers: { pick?: () => void } = {}; helpers.pick = () => {}; export const out = helpers.pick.name;',
  },
  {
    id: 'assigned-function-static-bracket-on-string-entry',
    reason: TOSTRING_REASON,
    source:
      "function named() {} const helpers: { pick: string | (() => void) } = { pick: 'pending' }; helpers['pick'] = named; export const out = helpers['pick'].toString();",
  },
  {
    id: 'assigned-function-logical-nullish-assignment',
    reason: NAME_REASON,
    source:
      'function named() {} const helpers: { pick: undefined | (() => void) } = { pick: undefined }; helpers.pick ??= named; export const out = helpers.pick?.name;',
  },
  {
    id: 'assigned-function-dynamic-bracket-write-static-read',
    reason: TEXT_REASON,
    source:
      "function named() {} export function out(key: string) { const helpers: Record<string, string | (() => void)> = { pick: 'pending' }; helpers[key] = named; return String(helpers.pick); }",
  },
  {
    id: 'define-property-value-function-overwriting-string-entry',
    reason: TEXT_REASON,
    source:
      "function named() {} const helpers: { pick: string | (() => void) } = { pick: 'pending' }; Object.defineProperty(helpers, 'pick', { value: named }); export const out = String(helpers.pick);",
  },
  {
    id: 'define-property-method-descriptor-overwriting-string-entry',
    reason: TEXT_REASON,
    source:
      "const helpers: { pick: string | (() => void) } = { pick: 'pending' }; Object.defineProperty(helpers, 'pick', { value() {} }); export const out = String(helpers.pick);",
  },
  {
    id: 'object-assign-source-with-function-overwriting-string-entry',
    reason: TEXT_REASON,
    source:
      "function named() {} const helpers: { pick: string | (() => void) } = { pick: 'pending' }; Object.assign(helpers, { pick: named }); export const out = String(helpers.pick);",
  },
  {
    id: 'method-this-write-function-overwriting-string-entry',
    reason: TEXT_REASON,
    source:
      "function named() {} const helpers: { pick: string | (() => void); swap(): void } = { pick: 'pending', swap() { this.pick = named; } }; helpers.swap(); export const out = String(helpers.pick);",
  },
  {
    id: 'spread-of-post-assigned-object-retains-function-entry',
    reason: TEXT_REASON,
    source:
      "function named() {} const helpers: { pick: string | (() => void) } = { pick: 'pending' }; helpers.pick = named; const copy = { ...helpers }; export const out = String(copy.pick);",
  },
  {
    id: 'destructured-from-post-assigned-object-retains-function-entry',
    reason: NAME_REASON,
    source:
      "function named() {} const helpers: { pick: string | (() => void) } = { pick: 'pending' }; helpers.pick = named; const { pick } = helpers; export const out = pick.name;",
  },
  {
    id: 'assigned-non-function-overwriting-string-entry-stays-accepted-pin',
    reason: undefined,
    source:
      "const helpers: { pick: string } = { pick: 'pending' }; helpers.pick = 'ready'; export const out = String(helpers.pick);",
  },
  {
    id: 'assigned-function-leaves-clean-sibling-string-entry-accepted-pin',
    reason: undefined,
    source:
      "function named() {} const helpers: { label: string; pick: string | (() => void) } = { label: 'pending', pick: 'pending' }; helpers.pick = named; export const out = String(helpers.label);",
  },
  {
    id: 'dynamic-non-function-bracket-write-stays-accepted-pin',
    reason: undefined,
    source:
      'export function out(key: string) { const index: Record<string, boolean> = {}; index[key] = true; return String(index[key]); }',
  },
  {
    id: 'mutual-post-declaration-property-copy-cycle-terminates-pin',
    reason: undefined,
    source:
      'const a: { pick?: string } = {}; const b: { pick?: string } = {}; a.pick = b.pick; b.pick = a.pick; export const out = String(a.pick);',
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

describe('function evidence retained from post-declaration object entry writes', () => {
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
