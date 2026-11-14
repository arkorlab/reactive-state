import { type CallExpression, isCallExpression, isSpreadElement, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedArgumentPrefix } from '../src/compiler/framed-keys.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A call that spreads a captured tuple reads its entries where the spread stands. A function that
 * can be called again, with a tuple that is declared outside it, reads in each call what the calls
 * before left: what it does after the spread — a write to an entry in the call's own arguments or
 * after the call, a read of the tuple — comes before the next call's spread. A tuple the function
 * declares anew in each call, and a function called where it is written, which runs once, leave the
 * entries as written.
 */
const TUPLE = "const tuple = [{}, 'stack']; declare const x: unknown;";
const EXPOSED = { values: ['{}'], unknown: true, alternatives: ['new Error()'] };
const READ = { values: ['{}'], unknown: true, alternatives: [] };
const KEPT = {
  values: ['{}', "'stack'", '(tuple[0] = new Error())'],
  unknown: false,
  alternatives: undefined,
};

const CASES = [
  {
    id: 'reviewed-write-after-the-spread-in-a-function',
    source: `${TUPLE} function read() { return Reflect.get(...tuple, (tuple[0] = new Error())); } read(); read();`,
    prefix: EXPOSED,
  },
  {
    id: 'write-after-the-spread-in-an-arrow',
    source: `${TUPLE} const read = () => Reflect.get(...tuple, (tuple[0] = new Error())); read(); read();`,
    prefix: EXPOSED,
  },
  {
    id: 'write-after-the-spread-in-a-method',
    source: `${TUPLE} const holder = { read() { return Reflect.get(...tuple, (tuple[0] = new Error())); } }; holder.read(); holder.read();`,
    prefix: EXPOSED,
  },
  {
    id: 'write-after-the-spread-in-a-function-of-a-function',
    source: `${TUPLE} function outer() { return () => Reflect.get(...tuple, (tuple[0] = new Error())); } const read = outer(); read(); read();`,
    prefix: EXPOSED,
  },
  {
    id: 'write-after-the-call-in-a-function',
    source: `${TUPLE} function read() { Reflect.get(...tuple, 'k'); tuple[0] = new Error(); } read(); read();`,
    prefix: EXPOSED,
  },
  {
    id: 'read-of-the-tuple-after-the-call-in-a-function-pin',
    source: `${TUPLE} function read() { Reflect.get(...tuple, 'k'); return tuple.length; } read(); read();`,
    prefix: READ,
  },
  {
    id: 'write-after-the-spread-in-a-tuple-declared-in-the-function-pin',
    source: `function read() { const tuple = [{}, 'stack']; return Reflect.get(...tuple, (tuple[0] = new Error())); } read(); read();`,
    prefix: KEPT,
  },
  {
    id: 'write-after-the-spread-in-a-function-called-where-it-is-written-pin',
    source: `${TUPLE} (() => Reflect.get(...tuple, (tuple[0] = new Error())))();`,
    prefix: KEPT,
  },
  {
    id: 'write-after-the-spread-outside-a-function-pin',
    source: `${TUPLE} Reflect.get(...tuple, (tuple[0] = new Error()));`,
    prefix: KEPT,
  },
  {
    id: 'unrelated-argument-after-the-spread-in-a-function-pin',
    source: `${TUPLE} function read() { return Reflect.get(...tuple, x); } read(); read();`,
    prefix: { values: ['{}', "'stack'", 'x'], unknown: false, alternatives: undefined },
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

describe('a spread of a captured tuple in a function that is called again', () => {
  it.each(CASES)('$id', ({ source, prefix }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'tuple-repeated-calls.ts', source);
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
