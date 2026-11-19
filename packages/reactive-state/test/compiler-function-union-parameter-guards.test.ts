import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";
const SOURCE_REASON = "writes a function as text, which each side's bundle writes otherwise";
const TOSTRING_REASON = "reads `toString` of a function, which each side's bundle writes otherwise";

/**
 * A name whose written type is a union with a function type is read as a function, but where a
 * guard of the same function, `typeof value === 'function'` or its negation, or a `typeof` test of
 * another type, has shown that the name is not a function, a read there is of the other members:
 * the setter-updater pattern `typeof value === 'function' ? value(open) : value` takes the function
 * only in the branch that calls it. The guard must test the same binding, in a condition that
 * selects the read (a conditional's branch, an `if` or its `else`, the right operand of `&&` or
 * `||`, or the statements after an `if` that always leaves the block), and the binding is never
 * assigned; the form that is not read so keeps its answer.
 */
const CASES = [
  {
    id: 'updater-in-a-ternary-then-a-template',
    reason: undefined,
    source: `export function next(open: boolean, value: boolean | ((value: boolean) => boolean)) { const state = typeof value === "function" ? value(open) : value; return \`open=\${state}\`; }`,
  },
  {
    id: 'false-branch-of-a-ternary-in-a-template',
    reason: undefined,
    source: `export function label(value: string | (() => string)) { return typeof value === "function" ? value() : \`\${value}\`; }`,
  },
  {
    id: 'true-branch-of-a-negated-ternary',
    reason: undefined,
    source: `export function label(value: string | (() => string)) { return typeof value !== "function" ? \`\${value}\` : value(); }`,
  },
  {
    id: 'else-branch-of-an-if',
    reason: undefined,
    source:
      'export function label(value: string | (() => string)) { if (typeof value === "function") { return value(); } else { return String(value); } }',
  },
  {
    id: 'then-branch-of-a-negated-if',
    reason: undefined,
    source:
      'export function label(value: string | (() => string)) { if (typeof value !== "function") { return String(value); } return value(); }',
  },
  {
    id: 'after-an-if-that-returns-from-a-block',
    reason: undefined,
    source:
      'export function label(value: string | (() => string)) { if (typeof value === "function") { return value(); } return String(value); }',
  },
  {
    id: 'after-an-if-that-returns-without-a-block',
    reason: undefined,
    source: `export function label(value: string | (() => string)) { if (typeof value === "function") return value(); return \`\${value}\`; }`,
  },
  {
    id: 'after-an-if-that-throws',
    reason: undefined,
    source: `export function label(value: string | (() => string)) { if (typeof value === "function") { throw new Error("no"); } return \`\${value}\`; }`,
  },
  {
    id: 'after-an-if-that-continues-a-loop',
    reason: undefined,
    source: `export function label(values: (string | (() => string))[], value: string | (() => string)) { const out: string[] = []; for (const each of values) { if (typeof value === "function") { continue; } out.push(\`\${value}\`); } return out; }`,
  },
  {
    id: 'after-an-if-with-an-else-whose-then-branch-returns',
    reason: undefined,
    source: `export function label(value: string | (() => string)) { if (typeof value === "function") { return value(); } else { value; } return \`\${value}\`; }`,
  },
  {
    id: 'right-operand-of-an-and',
    reason: undefined,
    source: `export function label(value: string | (() => string)) { return typeof value !== "function" && \`\${value}\`; }`,
  },
  {
    id: 'right-operand-of-an-or',
    reason: undefined,
    source: `export function label(value: string | (() => string)) { return typeof value === "function" || \`\${value}\`; }`,
  },
  {
    id: 'loose-equality-and-reversed-operands',
    reason: undefined,
    source: `export function label(value: string | (() => string)) { return "function" == typeof value ? value() : \`\${value}\`; }`,
  },
  {
    id: 'conjunction-that-holds-the-negated-guard',
    reason: undefined,
    source: `export function label(value: string | (() => string)) { return typeof value !== "function" && value !== "" ? \`\${value}\` : ""; }`,
  },
  {
    id: 'disjunction-whose-falsity-holds-the-guard',
    reason: undefined,
    source:
      'export function label(value: string | (() => string)) { if (typeof value === "function" || value === "") { return ""; } return String(value); }',
  },
  {
    id: 'parenthesized-and-negated-guard',
    reason: undefined,
    source: `export function label(value: string | (() => string)) { return !(typeof value === "function") ? \`\${value}\` : ""; }`,
  },
  {
    id: 'typeof-test-of-another-type-in-its-true-branch',
    reason: undefined,
    source: `export function label(value: string | (() => string)) { return typeof value === "string" ? \`\${value}\` : value(); }`,
  },
  {
    id: 'to-string-and-name-read-of-the-guarded-value',
    reason: undefined,
    source:
      'export function label(value: { name: string } | (() => string)) { return typeof value !== "function" ? value.name + value.toString() : ""; }',
  },
  {
    id: 'generic-union-resolved-by-the-guard',
    reason: undefined,
    source: `export function resolve<T extends string>(value: T | (() => T)): string { return typeof value === "function" ? value() : \`\${value}\`; }`,
  },
  {
    id: 'guard-and-read-in-one-closure',
    reason: undefined,
    source: `export function label(items: number[], value: string | (() => string)) { return items.map(() => (typeof value === "function" ? value() : \`\${value}\`)); }`,
  },
  {
    id: 'a-constant-of-a-union-type-resolved-by-the-guard',
    reason: undefined,
    source: `declare function pick(): string | (() => string); export function label() { const value: string | (() => string) = pick(); return typeof value === "function" ? value() : \`\${value}\`; }`,
  },
  {
    id: 'unguarded-union-parameter-in-a-template-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: string | (() => string)) { return \`v=\${value}\`; }`,
  },
  {
    id: 'unguarded-union-parameter-in-string-stays-refused-pin',
    reason: SOURCE_REASON,
    source: 'export function label(value: string | (() => string)) { return String(value); }',
  },
  {
    id: 'unguarded-union-parameter-to-string-stays-refused-pin',
    reason: TOSTRING_REASON,
    source: 'export function label(value: string | (() => string)) { return value.toString(); }',
  },
  {
    id: 'optional-function-parameter-name-stays-refused-pin',
    reason: NAME_REASON,
    source:
      'export function out(pick: (() => void) | undefined) { if (pick !== undefined) return pick.name; }',
  },
  {
    id: 'plain-function-parameter-in-a-template-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: () => number) { return \`\${value}\`; }`,
  },
  {
    id: 'plain-function-parameter-after-a-negated-guard-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: () => number) { return typeof value === "function" ? \`\${value}\` : ""; }`,
  },
  {
    id: 'function-branch-that-is-converted-stays-refused-pin',
    reason: SOURCE_REASON,
    source:
      'export function label(value: string | (() => string)) { return typeof value === "function" ? String(value) : value; }',
  },
  {
    id: 'function-branch-of-an-if-that-is-converted-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: string | (() => string)) { if (typeof value !== "function") { return ""; } return \`\${value}\`; }`,
  },
  {
    id: 'conjunction-in-the-condition-says-nothing-of-the-false-branch-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: string | (() => string), ready: boolean) { return typeof value === "function" && ready ? "" : \`\${value}\`; }`,
  },
  {
    id: 'disjunction-in-the-condition-says-nothing-of-the-true-branch-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: string | (() => string), ready: boolean) { return typeof value !== "function" || ready ? \`\${value}\` : ""; }`,
  },
  {
    id: 'guard-of-another-name-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(other: unknown, value: string | (() => string)) { return typeof other === "function" ? "" : \`\${value}\`; }`,
  },
  {
    id: 'guard-of-a-shadowing-parameter-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: string | (() => string)) { const inner = (value: string) => typeof value === "string" ? "" : ""; return \`\${value}\${inner("")}\`; }`,
  },
  {
    id: 'instanceof-guard-is-no-proof-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: string | (() => string)) { return value instanceof Function ? value() : \`\${value}\`; }`,
  },
  {
    id: 'typeof-test-of-another-type-false-branch-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: string | (() => string)) { return typeof value === "string" ? "" : \`\${value}\`; }`,
  },
  {
    id: 'then-branch-that-does-not-leave-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: string | (() => string)) { if (typeof value === "function") { value(); } return \`\${value}\`; }`,
  },
  {
    id: 'then-branch-that-leaves-on-some-paths-only-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: string | (() => string), flag: boolean) { if (typeof value === "function") { if (flag) { return ""; } } return \`\${value}\`; }`,
  },
  {
    id: 'read-before-the-guard-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: string | (() => string)) { const text = \`\${value}\`; if (typeof value === "function") { return ""; } return text; }`,
  },
  {
    id: 'closure-made-outside-the-guard-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: string | (() => string)) { const read = () => \`\${value}\`; return typeof value === "function" ? "" : read(); }`,
  },
  {
    id: 'closure-made-in-the-guarded-branch-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: string | (() => string)) { return typeof value === "function" ? "" : (() => \`\${value}\`)(); }`,
  },
  {
    id: 'parameter-the-function-assigns-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: string | (() => string), other: () => string) { value = other; return typeof value === "function" ? "" : \`\${value}\`; }`,
  },
  {
    id: 'parameter-assigned-in-a-destructuring-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: string | (() => string), pair: [() => string]) { [value] = pair; return typeof value === "function" ? "" : \`\${value}\`; }`,
  },
  {
    id: 'parameter-assigned-by-a-loop-head-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: string | (() => string), all: (() => string)[]) { for (value of all) { value; } return typeof value === "function" ? "" : \`\${value}\`; }`,
  },
  {
    id: 'alias-made-outside-the-guard-stays-refused-pin',
    reason: SOURCE_REASON,
    source: `export function label(value: string | (() => string)) { const alias = value; return typeof value === "function" ? "" : \`\${alias}\`; }`,
  },
  {
    id: 'unknown-parameter-is-no-function-stays-accepted-pin',
    reason: undefined,
    source: `export function label(value: unknown) { return \`\${String(value)}\`; }`,
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

describe('names of a union type with a function, read where a guard has shown they are none', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-union-parameter-guards.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
