import { type Node } from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { functionRead } from '../src/compiler/function-reads.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const NAME_REASON = "reads `name` of a function, which each side's bundle writes otherwise";
const SOURCE_REASON = "writes a function as text, which each side's bundle writes otherwise";
const TOSTRING_REASON = "reads `toString` of a function, which each side's bundle writes otherwise";

/**
 * The name a function or class expression gives itself, `pick` of `function pick() { … }`, is
 * bound inside the expression to the expression itself, so a read of it there is a read of a
 * function: its name, which a minifier may shorten, and its source, which a bundle writes anew.
 * The expression's own scope hides the declaration around it, so the read is of the function
 * whatever the outer name holds, and a parameter or a local of the same name stays the value it is.
 */
const CASES = [
  {
    id: 'named-function-expression-reads-its-own-name',
    reason: NAME_REASON,
    source: 'export const pick = function pick() { return pick.name; };',
  },
  {
    id: 'named-function-expression-reads-its-own-source',
    reason: TOSTRING_REASON,
    source: 'export const pick = function pick() { return pick.toString(); };',
  },
  {
    id: 'named-function-expression-writes-itself-as-text',
    reason: SOURCE_REASON,
    source: 'export const pick = function pick() { return String(pick); };',
  },
  {
    id: 'named-function-expression-in-a-template',
    reason: SOURCE_REASON,
    source: `export const pick = function pick() { return \`\${pick}\`; };`,
  },
  {
    id: 'named-function-expression-concatenated',
    reason: SOURCE_REASON,
    source: "export const pick = function pick() { return pick + ''; };",
  },
  {
    id: 'named-function-expression-bracket-name-read',
    reason: NAME_REASON,
    source: "export const pick = function pick() { return pick['name']; };",
  },
  {
    id: 'named-function-expression-destructures-its-own-name',
    reason: NAME_REASON,
    source: 'export const pick = function pick() { const { name } = pick; return name; };',
  },
  {
    id: 'named-function-expression-of-a-let',
    reason: NAME_REASON,
    source: 'export let pick = function pick() { return pick.name; };',
  },
  {
    id: 'named-function-expression-under-another-outer-name',
    reason: NAME_REASON,
    source: 'export const outer = function inner() { return inner.name; };',
  },
  {
    id: 'named-function-expression-read-from-a-nested-function',
    reason: NAME_REASON,
    source:
      'export const pick = function pick() { function deeper() { return pick.name; } return deeper(); };',
  },
  {
    id: 'named-function-expression-read-from-an-arrow',
    reason: NAME_REASON,
    source: 'export const pick = function pick() { return [1].map(() => pick.name); };',
  },
  {
    id: 'named-function-expression-given-to-a-call',
    reason: NAME_REASON,
    source: 'export function label() { return [1].map(function step() { return step.name; }); }',
  },
  {
    id: 'named-function-expression-hides-an-outer-object-of-its-name',
    reason: NAME_REASON,
    source:
      "const pick = { name: 'fixed' }; export const read = function pick() { return pick.name; };",
  },
  {
    id: 'named-function-expression-in-an-object-entry',
    reason: NAME_REASON,
    source: 'export const helpers = { run: function run() { return run.name; } };',
  },
  {
    id: 'named-class-expression-reads-its-own-name',
    reason: NAME_REASON,
    source: 'export const Picker = class Picker { static label() { return Picker.name; } };',
  },
  {
    id: 'named-class-expression-reads-its-own-source',
    reason: TOSTRING_REASON,
    source: 'export const Picker = class Picker { label() { return Picker.toString(); } };',
  },
  {
    id: 'named-class-expression-under-another-outer-name',
    reason: NAME_REASON,
    source: 'export const Outer = class Inner { static label() { return Inner.name; } };',
  },
  {
    id: 'own-name-of-a-declaration-stays-refused-pin',
    reason: NAME_REASON,
    source: 'export function pick() { return pick.name; }',
  },
  {
    id: 'own-name-of-a-class-declaration-stays-refused-pin',
    reason: NAME_REASON,
    source: 'export class Picker { static label() { return Picker.name; } }',
  },
  {
    id: 'a-parameter-of-the-same-name-is-its-own-value-stays-accepted-pin',
    reason: undefined,
    source: 'export const pick = function pick(pick: { name: string }) { return pick.name; };',
  },
  {
    id: 'a-local-of-the-same-name-is-its-own-value-stays-accepted-pin',
    reason: undefined,
    source:
      "export const pick = function pick() { const pick = { name: 'fixed' }; return pick.name; };",
  },
  {
    id: 'a-nested-parameter-of-the-same-name-stays-accepted-pin',
    reason: undefined,
    source:
      'export const pick = function pick() { return [{ name: 1 }].map((pick) => pick.name); };',
  },
  {
    id: 'a-member-that-is-no-bundled-one-stays-accepted-pin',
    reason: undefined,
    source: 'export const pick = function pick() { return pick.length; };',
  },
  {
    id: 'calling-the-own-name-stays-accepted-pin',
    reason: undefined,
    source:
      'export const pick = function pick(count: number): number { return count > 0 ? pick(count - 1) : 0; };',
  },
  {
    id: 'the-name-of-an-object-entry-stays-accepted-pin',
    reason: undefined,
    source:
      'const helpers = { run() { return helpers.run.name; } }; export const label = helpers.run();',
  },
  {
    id: 'an-anonymous-function-expression-of-a-constant-stays-refused-pin',
    reason: NAME_REASON,
    source: 'export const pick = function () { return pick.name; };',
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

describe('function and class expressions read by the name they give themselves', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ reason, source }) => {
    using parsed = parseModule(api, 'function-named-expression-self-reference.ts', source);

    expect(firstFunctionRead(parsed.sourceFile)).toBe(reason);
  });
});
