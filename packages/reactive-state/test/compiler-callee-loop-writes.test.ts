import {
  type CallExpression,
  isCallExpression,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { metadataCallee } from '../src/compiler/input-callees.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DECLARED =
  'function quiet(value: object) {} function change(value: { x: number }) { value.x++; } declare function register(value: object): void; const input = { x: 0 };';

/**
 * A call of a member of a literal that a loop calls again in each round may find the member
 * replaced by a write the loop makes after the call, though that write stands later in the text;
 * a literal the loop builds in each round, and a loop that writes nothing, keep the member read.
 */
const CASES = [
  {
    id: 'loop-reassigns-the-member-after-the-call',
    resolves: false,
    source: `${DECLARED} const helpers = { pick: quiet }; for (let i = 0; i < 2; i++) { helpers.pick(input); helpers.pick = change; }`,
  },
  {
    id: 'loop-reassigns-the-member-inside-a-function',
    resolves: false,
    source: `${DECLARED} export function run() { const helpers = { pick: quiet }; for (let i = 0; i < 2; i++) { helpers.pick(input); helpers.pick = change; } }`,
  },
  {
    id: 'while-loop-reassigns-the-member-after-the-call',
    resolves: false,
    source: `${DECLARED} const helpers = { pick: quiet }; let more = true; while (more) { helpers.pick(input); helpers.pick = change; more = false; }`,
  },
  {
    id: 'do-loop-reassigns-the-member-after-the-call',
    resolves: false,
    source: `${DECLARED} const helpers = { pick: quiet }; let more = true; do { helpers.pick(input); helpers.pick = change; more = false; } while (more);`,
  },
  {
    id: 'for-of-loop-reassigns-the-member-after-the-call',
    resolves: false,
    source: `${DECLARED} const helpers = { pick: quiet }; for (const round of [1, 2]) { helpers.pick(input); helpers.pick = change; void round; }`,
  },
  {
    id: 'nested-loop-reassigns-the-member-after-the-call',
    resolves: false,
    source: `${DECLARED} const helpers = { pick: quiet }; for (const outer of [1, 2]) { for (const inner of [1, 2]) { helpers.pick(input); void inner; } helpers.pick = change; void outer; }`,
  },
  {
    id: 'loop-hands-the-literal-to-a-call-after-the-call',
    resolves: false,
    source: `${DECLARED} const helpers = { pick: quiet }; for (let i = 0; i < 2; i++) { helpers.pick(input); register(helpers); }`,
  },
  {
    id: 'loop-with-no-write-keeps-the-member-pin',
    resolves: true,
    source: `${DECLARED} const helpers = { pick: quiet }; for (let i = 0; i < 2; i++) { helpers.pick(input); }`,
  },
  {
    id: 'literal-built-in-each-round-keeps-the-member-pin',
    resolves: true,
    source: `${DECLARED} for (let i = 0; i < 2; i++) { const helpers = { pick: quiet }; helpers.pick(input); helpers.pick = change; }`,
  },
  {
    id: 'write-after-the-loop-keeps-the-member-pin',
    resolves: true,
    source: `${DECLARED} const helpers = { pick: quiet }; helpers.pick(input); for (let i = 0; i < 2; i++) { void i; } helpers.pick = change;`,
  },
  {
    id: 'straight-line-call-before-the-write-keeps-the-member-pin',
    resolves: true,
    source: `${DECLARED} const helpers = { pick: quiet }; helpers.pick(input); helpers.pick = change;`,
  },
  {
    id: 'straight-line-write-before-the-call-is-unknown-pin',
    resolves: false,
    source: `${DECLARED} const helpers = { pick: quiet }; helpers.pick = change; helpers.pick(input);`,
  },
] as const;

/** The first call of `helpers.pick` in `root`. */
function pickCall(root: Node): CallExpression {
  let found: CallExpression | undefined;
  const visit = (node: Node): void => {
    if (found !== undefined) {
      return;
    }
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      node.expression.getText() === 'helpers.pick'
    ) {
      found = node;
      return;
    }
    node.forEachChild(visit);
  };
  visit(root);
  if (found === undefined) {
    throw new Error('Expected a call of helpers.pick.');
  }
  return found;
}

describe('callees of members that a loop reassigns after calling them', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ resolves, source }) => {
    using parsed = parseModule(api, 'callee-loop-writes.ts', source);
    const callee = metadataCallee(pickCall(parsed.sourceFile).expression);

    expect(callee?.getText().startsWith('function quiet') === true).toBe(resolves);
  });
});
