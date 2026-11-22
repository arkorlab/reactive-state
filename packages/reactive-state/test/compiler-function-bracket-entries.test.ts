import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const SOURCE_REASON = "writes a function as text, which each side's bundle writes otherwise";
const TOSTRING_REASON = "reads `toString` of a function, which each side's bundle writes otherwise";

/**
 * Reading or stringifying an object entry that holds a function through bracket notation
 * (`String(helpers['pick'])`, `helpers['pick'].toString()`, or a dynamic bracket key on an object
 * literal of functions) exposes bundle-dependent function source just like dot access.
 */
const CASES = [
  {
    id: 'string-call-on-bracket-entry',
    reason: SOURCE_REASON,
    source: "const helpers = { pick() {} }; export const out = String(helpers['pick']);",
  },
  {
    id: 'template-on-template-bracket-entry',
    reason: SOURCE_REASON,
    source: `const helpers = { pick() {} }; export const out = \`\${helpers[\`pick\`]}\`;`,
  },
  {
    id: 'tostring-on-bracket-entry',
    reason: TOSTRING_REASON,
    source: "const helpers = { pick() {} }; export const out = helpers['pick'].toString();",
  },
  {
    id: 'computed-literal-method-entry-source',
    reason: SOURCE_REASON,
    source: "const helpers = { ['pick']() {} }; export const out = String(helpers['pick']);",
  },
  {
    id: 'inline-object-bracket-entry-source',
    reason: SOURCE_REASON,
    source: "export const out = String(({ pick() {} })['pick']);",
  },
  {
    id: 'dynamic-bracket-key-on-function-table-source',
    reason: SOURCE_REASON,
    source:
      "const helpers = { first() {}, second() {} }; export function out(key: 'first' | 'second') { return String(helpers[key]); }",
  },
  {
    id: 'dot-entry-source-pin',
    reason: SOURCE_REASON,
    source: 'const helpers = { pick() {} }; export const out = String(helpers.pick);',
  },
  {
    id: 'bracket-plain-string-entry-pin',
    reason: undefined,
    source: "const helpers = { label: 'ok' }; export const out = String(helpers['label']);",
  },
  {
    id: 'bracket-method-entry-name-pin',
    reason: undefined,
    source: "const helpers = { pick() {} }; export const out = helpers['pick'].name;",
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

describe('function source reads through bracket object entries', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-bracket-entries.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
