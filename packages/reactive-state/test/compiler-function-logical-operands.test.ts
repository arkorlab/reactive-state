import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";
const SOURCE_REASON = "writes a function as text, which each side's bundle writes otherwise";
const TOSTRING_REASON = "reads `toString` of a function, which each side's bundle writes otherwise";

/**
 * An operator that answers one of its operands (`&&`, `||`, `??`, the comma, a plain assignment)
 * answers a function when an operand is one, as the conditional expression does.
 */
const CASES = [
  {
    id: 'and-operand-text',
    reason: SOURCE_REASON,
    source:
      'function named() {} export function label(enabled: boolean) { const pick = enabled && named; return String(pick); }',
  },
  {
    id: 'or-operand-text',
    reason: SOURCE_REASON,
    source:
      'function named() {} export function label(enabled: boolean) { const pick = enabled || named; return String(pick); }',
  },
  {
    id: 'nullish-operand-text',
    reason: SOURCE_REASON,
    source:
      'function named() {} export function label(given?: () => void) { const pick = given ?? named; return String(pick); }',
  },
  {
    id: 'and-operand-concatenated',
    reason: SOURCE_REASON,
    source:
      "function named() {} export function label(enabled: boolean) { return (enabled && named) + ''; }",
  },
  {
    id: 'or-operand-in-template',
    reason: SOURCE_REASON,
    source: `function named() {} export function label(enabled: boolean) { return \`\${enabled || named}\`; }`,
  },
  {
    id: 'and-operand-name-read',
    reason: NAME_REASON,
    source:
      'function named() {} export function label(enabled: boolean) { return (enabled && named).name; }',
  },
  {
    id: 'nested-logical-operand-name-read',
    reason: NAME_REASON,
    source:
      'function named() {} export function label(a: boolean, b: boolean) { return ((a && b) || named).name; }',
  },
  {
    id: 'and-entry-method-source',
    reason: TOSTRING_REASON,
    source:
      'const helpers = { pick() {} }; export function label(enabled: boolean) { return (enabled && helpers.pick).toString(); }',
  },
  {
    id: 'comma-last-operand-text',
    reason: SOURCE_REASON,
    source: 'function named() {} export function label() { return String((0, named)); }',
  },
  {
    id: 'comma-last-operand-name-read',
    reason: NAME_REASON,
    source: 'function named() {} export function label() { return (0, named).name; }',
  },
  {
    id: 'assignment-value-text',
    reason: SOURCE_REASON,
    source:
      'function named() {} export function label() { let pick: unknown; return String((pick = named)); }',
  },
  {
    id: 'logical-through-const-alias-text',
    reason: SOURCE_REASON,
    source:
      'function named() {} export function label(enabled: boolean) { const pick = enabled && named; const again = pick; return String(again); }',
  },
  {
    id: 'conditional-operand-text-pin',
    reason: SOURCE_REASON,
    source:
      'function named() {} export function label(enabled: boolean) { const pick = enabled ? named : undefined; return String(pick); }',
  },
  {
    id: 'and-entry-method-name-stays-accepted-pin',
    reason: undefined,
    source:
      'const helpers = { pick() {} }; export function label(enabled: boolean) { return (enabled && helpers.pick).name; }',
  },
  {
    id: 'logical-of-non-functions-stays-accepted-pin',
    reason: undefined,
    source:
      "export function label(enabled: boolean, other?: string) { return String((enabled && 'on') || other); }",
  },
  {
    id: 'logical-of-unknown-operands-stays-accepted-pin',
    reason: undefined,
    source:
      'export function label(left: unknown, right: unknown) { return String(left ?? right); }',
  },
  {
    id: 'comma-of-non-function-last-operand-stays-accepted-pin',
    reason: undefined,
    source: "function named() {} export function label() { return String((named, 'text')); }",
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

describe('functions an operator answers as one of its operands', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-logical-operands.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
