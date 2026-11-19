import {
  type CallExpression,
  isCallExpression,
  isNewExpression,
  type NewExpression,
  type Node,
} from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { metadataInvocation } from '../src/compiler/input-callees.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DECLARED =
  'function quiet(value: { x: number }) {} function change(value: { x: number }) { value.x++; } class Box {} class Other {} declare let spare: unknown; const input = { x: 0 };';

/**
 * A function or class declaration, or its `call`, that a destructuring assignment replaces
 * (`[quiet] = [change]`, `({ quiet } = source)`, `for ([quiet] of rows)`) is no proof of the callable
 * a later call invokes, as a plain assignment to its name is not; a pattern of other names is.
 */
const CASES = [
  {
    id: 'array-pattern-replaces-the-function',
    resolves: false,
    source: `${DECLARED} [quiet] = [change]; quiet(input);`,
  },
  {
    id: 'object-pattern-shorthand-replaces-the-function',
    resolves: false,
    source: `${DECLARED} ({ quiet } = { quiet: change }); quiet(input);`,
  },
  {
    id: 'object-pattern-with-a-name-replaces-the-function',
    resolves: false,
    source: `${DECLARED} ({ other: quiet } = { other: change }); quiet(input);`,
  },
  {
    id: 'defaulted-pattern-replaces-the-function',
    resolves: false,
    source: `${DECLARED} [quiet = change] = []; quiet(input);`,
  },
  {
    id: 'nested-pattern-replaces-the-function',
    resolves: false,
    source: `${DECLARED} [[quiet]] = [[change]]; quiet(input);`,
  },
  {
    id: 'for-of-pattern-replaces-the-function',
    resolves: false,
    source: `${DECLARED} for ([quiet] of [[change]]) { break; } quiet(input);`,
  },
  {
    id: 'array-pattern-replaces-the-class',
    resolves: false,
    source: `${DECLARED} [Box] = [Other]; new Box();`,
  },
  {
    id: 'array-pattern-replaces-the-call-method',
    resolves: false,
    source: `${DECLARED} [quiet.call] = [change.call]; quiet.call(null, input);`,
  },
  {
    id: 'plain-assignment-replaces-the-function-pin',
    resolves: false,
    source: `${DECLARED} quiet = change; quiet(input);`,
  },
  {
    id: 'pattern-of-other-names-keeps-the-function-pin',
    resolves: true,
    source: `${DECLARED} [spare] = [change]; quiet(input);`,
  },
  {
    id: 'unwritten-function-keeps-the-function-pin',
    resolves: true,
    source: `${DECLARED} quiet(input);`,
  },
  {
    id: 'unwritten-call-method-keeps-the-function-pin',
    resolves: true,
    source: `${DECLARED} quiet.call(null, input);`,
  },
] as const;

/** The last call or construction in `root`, which each source ends with. */
function lastInvocation(root: Node): CallExpression | NewExpression {
  let found: CallExpression | NewExpression | undefined;
  const visit = (node: Node): void => {
    if (isCallExpression(node) || isNewExpression(node)) {
      found = node;
    }
    node.forEachChild(visit);
  };
  visit(root);
  if (found === undefined) {
    throw new Error('Expected an invocation.');
  }
  return found;
}

describe('invocations of declarations that a destructuring assignment replaces', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ resolves, source }) => {
    using parsed = parseModule(api, 'callee-pattern-writes.ts', source);
    const resolved = metadataInvocation(lastInvocation(parsed.sourceFile));

    expect(resolved !== undefined).toBe(resolves);
  });
});
