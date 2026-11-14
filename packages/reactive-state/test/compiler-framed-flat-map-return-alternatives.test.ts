import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isNewExpression,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayAt } from '../src/compiler/framed-array-selections.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A `flatMap` callback's return is flattened for each value it may be. A conditional, a logical or
 * a comma expression, or a name of a whole constant that holds one, is not one scalar: its branch
 * that is an array puts its elements in the result, as the plain array return does, and the
 * branches may differ in length. `at(n)` then reads an `Error` in a branch that is an array, though
 * the return is written as a conditional (`flag ? [error] : []` is how a callback drops an entry).
 */
const FLAG = 'declare const flag: boolean;';

const CASES = [
  {
    id: 'constant-true-condition-array',
    source: 'const picked = [0].flatMap(() => true ? [new Error()] : []).at(0);',
    selected: true,
  },
  {
    id: 'constant-false-condition-array',
    source: 'const picked = [0].flatMap(() => false ? [0] : [new Error()]).at(0);',
    selected: true,
  },
  {
    id: 'condition-of-a-parameter',
    source:
      'function pick(flag: boolean) { return [0].flatMap(() => flag ? [new Error()] : []).at(0); }',
    selected: true,
  },
  {
    id: 'both-branches-arrays',
    source: `${FLAG} const picked = [0].flatMap(() => flag ? [new Error()] : [new Error()]).at(0);`,
    selected: true,
  },
  {
    id: 'array-after-a-scalar',
    source: `${FLAG} const picked = [0].flatMap(() => flag ? [0, new Error()] : []).at(1);`,
    selected: true,
  },
  {
    id: 'constant-condition-second-position',
    source: 'const picked = [0].flatMap(() => true ? [0, new Error()] : []).at(1);',
    selected: true,
  },
  {
    id: 'parenthesized-conditional',
    source: `${FLAG} const picked = [0].flatMap(() => (flag ? [new Error()] : [])).at(0);`,
    selected: true,
  },
  {
    id: 'conditional-in-a-block-return',
    source: `${FLAG} const picked = [0].flatMap(() => { return flag ? [new Error()] : []; }).at(0);`,
    selected: true,
  },
  {
    id: 'conditional-in-a-function-expression',
    source: `${FLAG} const picked = [0].flatMap(function () { return flag ? [new Error()] : []; }).at(0);`,
    selected: true,
  },
  {
    id: 'nested-conditional',
    source: `${FLAG} const picked = [0].flatMap(() => flag ? (flag ? [] : [new Error()]) : []).at(0);`,
    selected: true,
  },
  {
    id: 'conditional-held-by-a-local-constant',
    source: `${FLAG} const picked = [0].flatMap(() => { const out = flag ? [new Error()] : []; return out; }).at(0);`,
    selected: true,
  },
  {
    id: 'conditional-held-by-an-outer-constant',
    source: `${FLAG} const out = flag ? [new Error()] : []; const picked = [0].flatMap(() => out).at(0);`,
    selected: true,
  },
  {
    id: 'conditional-held-through-two-constants',
    source: `${FLAG} const first = flag ? [new Error()] : []; const out = first; const picked = [0].flatMap(() => out).at(0);`,
    selected: true,
  },
  {
    id: 'logical-and-with-an-array',
    source: `${FLAG} const picked = [0].flatMap(() => flag && [new Error()]).at(0);`,
    selected: true,
  },
  {
    id: 'logical-or-with-an-array',
    source: `${FLAG} const picked = [0].flatMap(() => flag || [new Error()]).at(0);`,
    selected: true,
  },
  {
    id: 'comma-before-an-array',
    source: 'const picked = [0].flatMap(() => (0, [new Error()])).at(0);',
    selected: true,
  },
  {
    id: 'native-identity-of-an-array',
    source: 'const picked = [0].flatMap(() => Object.freeze([new Error()])).at(0);',
    selected: true,
  },
  {
    id: 'plain-array-pin',
    source: 'const picked = [0].flatMap(() => [new Error()]).at(0);',
    selected: true,
  },
  {
    id: 'scalar-branch-pin',
    source: `${FLAG} const picked = [0].flatMap(() => flag ? new Error() : 1).at(0);`,
    selected: true,
  },
  {
    id: 'constant-condition-first-position-pin',
    source: 'const picked = [0].flatMap(() => true ? [0, new Error()] : []).at(0);',
    selected: false,
  },
  {
    id: 'conditional-of-data-arrays-pin',
    source: `${FLAG} const picked = [0].flatMap(() => flag ? [0] : []).at(0);`,
    selected: false,
  },
  {
    id: 'conditional-of-scalars-pin',
    source: `${FLAG} const picked = [0].flatMap(() => flag ? 1 : 2).at(0);`,
    selected: false,
  },
  {
    id: 'conditional-of-empty-arrays-pin',
    source: `${FLAG} const picked = [0].flatMap(() => flag ? [] : []).at(0);`,
    selected: false,
  },
  {
    id: 'array-of-an-array-is-no-error-pin',
    source: `${FLAG} const picked = [0].flatMap(() => flag ? [[new Error()]] : []).at(0);`,
    selected: false,
  },
  {
    id: 'logical-of-data-pin',
    source: `${FLAG} const picked = [0].flatMap(() => flag && [0]).at(0);`,
    selected: false,
  },
  {
    id: 'local-constant-of-a-plain-array-pin',
    source: 'const picked = [0].flatMap(() => { const out = [new Error()]; return out; }).at(0);',
    selected: true,
  },
] as const;

/** Constants that each hold the one before in both branches, a doubling of the names a return reaches. */
const DEPTHS = [4, 16, 40] as const;

/** The `at` call whose receiver is the call the source reads, the last one of the source. */
function atCall(root: Node): CallExpression {
  const pending = [root];
  let found: CallExpression | undefined;
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'at'
    )
      found = node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  if (found === undefined) throw new Error('no at call');
  return found;
}

/** A written `Error` stands for itself; nothing else is told apart by its type. */
const PROOF = {
  error: (value: Expression, keys?: readonly string[]) => {
    const each = unwrapped(value);
    return (keys === undefined || keys.length === 0) && isNewExpression(each);
  },
  typed: () => false,
};

describe('the elements of a flatMap callback that returns a conditional', () => {
  it.each(CASES)('$id', ({ source, selected }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'x.ts', source);

    expect(framedArrayAt(atCall(parsed.sourceFile), PROOF)).toBe(selected);
  });

  it.each(DEPTHS)('reads a chain of %i constants that hold the one before twice', (depth) => {
    const chain = Array.from(
      { length: depth },
      (_, at) => `const part${at + 1} = flag ? part${at} : part${at};`,
    );
    const source = `${FLAG} const part0 = [new Error()]; ${chain.join(' ')} const picked = [0].flatMap(() => part${depth}).at(0);`;
    using api = openTypeScript();
    using parsed = parseModule(api, 'x.ts', source);

    expect(framedArrayAt(atCall(parsed.sourceFile), PROOF)).toBe(true);
  });
});
