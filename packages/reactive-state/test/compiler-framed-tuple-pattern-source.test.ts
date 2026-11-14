import { type CallExpression, isCallExpression, isSpreadElement, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedArgumentPrefix } from '../src/compiler/framed-keys.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A call that spreads a captured tuple reads its entries where the spread stands. A destructuring
 * pattern evaluates what it destructures before its defaults, though they are written first: a write
 * to an entry in that source replaces the entry a spread in a default reads, and it is one of the
 * targets the call may have. A write in another default after the spread, and a source that writes
 * nothing, leave the entries as written.
 */
const TUPLE = "const tuple = [{}, 'stack'];";
const CALL = "Reflect.get(...tuple, 'k')";
const SOURCE = '(tuple[0] = new Error(), ';
const EXPOSED = { values: ['{}'], unknown: true, alternatives: ['new Error()'] };
const KEPT = { values: ['{}', "'stack'", "'k'"], unknown: false, alternatives: undefined };

const CASES = [
  {
    id: 'reviewed-write-in-a-declaration-source',
    source: `${TUPLE} const { x = ${CALL} } = ${SOURCE}{}); void x;`,
    prefix: EXPOSED,
  },
  {
    id: 'write-in-an-array-declaration-source',
    source: `${TUPLE} const [x = ${CALL}] = ${SOURCE}[]); void x;`,
    prefix: EXPOSED,
  },
  {
    id: 'write-in-an-assignment-source',
    source: `${TUPLE} let x: unknown; ({ x = ${CALL} } = ${SOURCE}{})); void x;`,
    prefix: EXPOSED,
  },
  {
    id: 'write-in-a-loop-source',
    source: `${TUPLE} for (const { x = ${CALL} } of ${SOURCE}[{}])) void x;`,
    prefix: EXPOSED,
  },
  {
    id: 'write-in-a-parameter-source',
    source: `${TUPLE} function pick({ x = ${CALL} } = ${SOURCE}{})) { return x; } pick();`,
    prefix: EXPOSED,
  },
  {
    id: 'write-in-a-nested-source',
    source: `${TUPLE} const { a: { x = ${CALL} } } = { a: ${SOURCE}{}) }; void x;`,
    prefix: EXPOSED,
  },
  {
    id: 'write-in-a-default-before-the-spread-pin',
    source: `${TUPLE} const { y = (tuple[0] = new Error()), x = ${CALL} } = {}; void x; void y;`,
    prefix: EXPOSED,
  },
  {
    id: 'write-in-a-default-after-the-spread-pin',
    source: `${TUPLE} const { x = ${CALL}, y = (tuple[0] = new Error()) } = {}; void x; void y;`,
    prefix: KEPT,
  },
  {
    id: 'source-that-writes-nothing-pin',
    source: `${TUPLE} const { x = ${CALL} } = {}; void x;`,
    prefix: KEPT,
  },
];

/** The calls in `root` of `Reflect.get` that spread something, by a walk of its tree. */
function spreadCalls(root: Node): readonly CallExpression[] {
  const calls: CallExpression[] = [];
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isCallExpression(node) &&
      node.expression.getText() === 'Reflect.get' &&
      node.arguments.some((each) => isSpreadElement(each))
    )
      calls.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return calls;
}

describe('a spread of a captured tuple in the defaults of a destructuring pattern', () => {
  it.each(CASES)('$id', ({ source, prefix }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'tuple-pattern-source.ts', source);
    const read = spreadCalls(parsed.sourceFile).map((call) => {
      const { values, unknown, alternatives } = framedArgumentPrefix(call, call.arguments, 3);
      return {
        values: values.map((each) => each.getText()),
        unknown,
        alternatives: alternatives?.map((each) => each.getText()),
      };
    });

    expect(read).toStrictEqual([prefix]);
  });
});
