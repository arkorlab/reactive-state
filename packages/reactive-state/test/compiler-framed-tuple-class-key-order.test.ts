import { type CallExpression, isCallExpression, isSpreadElement, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedArgumentPrefix } from '../src/compiler/framed-keys.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A call that spreads a captured tuple reads its entries where the spread stands. A class evaluates
 * the computed keys of all its members before it runs any static initializer or static block,
 * though they are written after: a write to an entry, or any read of the tuple, in a key replaces
 * or exposes the entries a spread in a static initializer reads. A write in a static initializer
 * written after the call, in a key of another class and a key that does no work leave the entries
 * as written.
 */
const TUPLE = "const tuple = [{}, 'stack'];";
const WRITE = "[(tuple[0] = new Error(), 'k')]";
const CALL = "Reflect.get(...tuple, 'k')";
const EXPOSED = { values: ['{}'], unknown: true, alternatives: ['new Error()'] };
const KEPT = { values: ['{}', "'stack'", "'k'"], unknown: false, alternatives: undefined };

const CASES = [
  {
    id: 'reviewed-write-in-a-key-after-a-static-field',
    source: `${TUPLE} class C { static x = ${CALL}; ${WRITE} = 0; } void C;`,
    prefix: EXPOSED,
  },
  {
    id: 'write-in-a-method-key-after-a-static-field',
    source: `${TUPLE} class C { static x = ${CALL}; static ${WRITE}() { return 0; } } void C;`,
    prefix: EXPOSED,
  },
  {
    id: 'write-in-an-accessor-key-after-a-static-field',
    source: `${TUPLE} class C { static x = ${CALL}; get ${WRITE}() { return 0; } } void C;`,
    prefix: EXPOSED,
  },
  {
    id: 'write-in-a-key-after-a-static-block',
    source: `${TUPLE} class C { static { ${CALL}; } ${WRITE} = 0; } void C;`,
    prefix: EXPOSED,
  },
  {
    id: 'write-in-a-key-of-a-class-expression',
    source: `${TUPLE} const C = class { static x = ${CALL}; ${WRITE} = 0; }; void C;`,
    prefix: EXPOSED,
  },
  {
    id: 'write-in-a-key-of-the-outer-class',
    source: `${TUPLE} class Outer { static Nested = class { static x = ${CALL}; }; ${WRITE} = 0; } void Outer;`,
    prefix: EXPOSED,
  },
  {
    id: 'read-of-the-tuple-in-a-key-after-a-static-field',
    source: `${TUPLE} class C { static x = ${CALL}; [(tuple.length, 'k')] = 0; } void C;`,
    prefix: { values: ['{}'], unknown: true, alternatives: [] },
  },
  {
    id: 'write-in-a-key-before-the-static-field-pin',
    source: `${TUPLE} class C { ${WRITE} = 0; static x = ${CALL}; } void C;`,
    prefix: EXPOSED,
  },
  {
    id: 'write-in-a-static-field-after-the-call-pin',
    source: `${TUPLE} class C { static x = ${CALL}; static y = (tuple[0] = new Error()); } void C;`,
    prefix: KEPT,
  },
  {
    id: 'write-in-a-key-of-another-class-pin',
    source: `${TUPLE} class C { static x = ${CALL}; } class D { ${WRITE} = 0; } void C; void D;`,
    prefix: KEPT,
  },
  {
    id: 'key-that-does-no-work-pin',
    source: `${TUPLE} class C { static x = ${CALL}; ['k'] = 0; } void C;`,
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

describe('a spread of a captured tuple in a static initializer of a class', () => {
  it.each(CASES)('$id', ({ source, prefix }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'tuple-class-key-order.ts', source);
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
