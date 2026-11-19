import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";
const SOURCE_REASON = "writes a function as text, which each side's bundle writes otherwise";
const TOSTRING_REASON = "reads `toString` of a function, which each side's bundle writes otherwise";

/**
 * Mutable bindings (`let`/`var`) whose initializers are non-callable (`undefined`, `null`, strings)
 * can still receive functions later, so explicit function type annotations and visible function
 * reassignments retain `'renamed'` classification; written function annotations also unwrap
 * parentheses, unions, intersections, and callable type literals.
 */
const CASES = [
  {
    id: 'mutable-let-function-union-initialized-undefined-name',
    reason: NAME_REASON,
    source:
      'export function out() { let pick: Function | undefined = undefined; pick = function named() {}; return pick.name; }',
  },
  {
    id: 'mutable-let-arrow-type-union-initialized-undefined-name',
    reason: NAME_REASON,
    source:
      'export function out() { let pick: (() => void) | undefined = undefined; pick = function named() {}; return pick.name; }',
  },
  {
    id: 'mutable-var-function-union-initialized-null-source',
    reason: SOURCE_REASON,
    source:
      "export function out(fn: (() => void) | null) { var pick: (() => void) | null = null; if (fn !== null) pick = fn; return pick === null ? '' : String(pick); }",
  },
  {
    id: 'mutable-let-unannotated-initialized-undefined-reassigned-function',
    reason: NAME_REASON,
    source:
      'export function out() { let pick = undefined; pick = function named() {}; return pick.name; }',
  },
  {
    id: 'mutable-let-destructured-initialized-undefined-reassigned-function',
    reason: NAME_REASON,
    source:
      'function named() {} export function out() { let { pick }: { pick: (() => void) | undefined } = { pick: undefined }; pick = named; return pick.name; }',
  },
  {
    id: 'mutable-let-reassigned-via-object-destructuring-assignment',
    reason: NAME_REASON,
    source:
      "function named() {} export function out() { let pick: unknown = 'pending'; ({ pick } = { pick: named }); return (pick as () => void).name; }",
  },
  {
    id: 'parameter-parenthesized-arrow-union-undefined-name',
    reason: NAME_REASON,
    source:
      "export function out(pick: (() => void) | undefined) { if (pick !== undefined) return pick.name; return ''; }",
  },
  {
    id: 'parameter-constructor-type-union-null-name',
    reason: NAME_REASON,
    source:
      "export function out(ctor: (new () => { readonly ok: boolean }) | null) { return ctor === null ? '' : ctor.name; }",
  },
  {
    id: 'parameter-intersection-branded-arrow-tostring',
    reason: TOSTRING_REASON,
    source:
      'export function out(pick: (() => void) & { readonly tag: string }) { return pick.toString(); }',
  },
  {
    id: 'parameter-call-signature-type-literal-union-name',
    reason: NAME_REASON,
    source:
      "export function out(pick: { (): void; readonly tag?: string } | undefined) { return pick === undefined ? '' : pick.name; }",
  },
  {
    id: 'const-annotated-union-arrow-from-unknown-call-source',
    reason: SOURCE_REASON,
    source:
      "export function out(choose: () => (() => void) | undefined) { const pick: (() => void) | undefined = choose(); return pick === undefined ? '' : String(pick); }",
  },
  {
    id: 'const-function-union-initialized-undefined-stays-non-function-pin',
    reason: undefined,
    source:
      "const pick: (() => void) | undefined = undefined; export function out() { return pick === undefined ? 'none' : String(pick); }",
  },
  {
    id: 'mutable-let-reassigned-only-strings-stays-accepted-pin',
    reason: undefined,
    source:
      "export function out(flag: boolean) { let pick: string | undefined = undefined; if (flag) pick = 'ready'; return String(pick); }",
  },
  {
    id: 'parameter-plain-method-object-type-literal-not-callable-pin',
    reason: undefined,
    source:
      "export function out(box: { pick(): void; readonly name: string } | undefined) { return box === undefined ? '' : box.name; }",
  },
  {
    id: 'parameter-function-reference-union-still-refused-pin',
    reason: NAME_REASON,
    source:
      "export function out(pick: Function | undefined) { return pick === undefined ? '' : pick.name; }",
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

describe('function type annotations and mutable binding reassignments', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-mutable-types.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
