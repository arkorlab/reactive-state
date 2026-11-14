import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedAppliedArguments, framedArgumentPrefix } from '../src/compiler/framed-keys.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A call evaluates its callee and its arguments before it reads a list it is given, and the
 * arguments before a spread before the spread reads its entries: what that work writes into a
 * captured tuple, or what a function it runs may write there, is what the call then reads. Work
 * reaches the tuple only through a function of the module's that names it (`later` below), or
 * another module's, where the module exports it.
 */
const APPLIED = [
  {
    id: 'reviewed-receiver-write',
    source: "const tuple = [{}, 'message']; Reflect.get.apply((tuple[0] = new Error()), tuple);",
    callee: 'Reflect.get.apply',
    list: 1,
    entries: undefined,
  },
  {
    id: 'callee-write',
    source:
      "const tuple = [{}, 'stack']; ((tuple[0] = new Error()), Reflect.get).apply(null, tuple);",
    callee: '((tuple[0] = new Error()), Reflect.get).apply',
    list: 1,
    entries: undefined,
  },
  {
    id: 'hoisted-writer-called-first',
    source:
      "const tuple = [{}, 'stack']; Reflect.get.apply(swap(), tuple); function swap() { tuple[0] = new Error(); }",
    callee: 'Reflect.get.apply',
    list: 1,
    entries: undefined,
  },
  {
    id: 'later-argument-write',
    source:
      "const tuple = [{}, 'stack']; Reflect.apply(Reflect.get, null, tuple, (tuple[0] = new Error()));",
    callee: 'Reflect.apply',
    list: 2,
    entries: undefined,
  },
  {
    id: 'reachable-member-receiver',
    source:
      "const tuple = [{}, 'stack']; Reflect.get.apply(holder.x, tuple); function later() { tuple[0] = new Error(); }",
    callee: 'Reflect.get.apply',
    list: 1,
    entries: undefined,
  },
  {
    id: 'exported-tuple-member-receiver',
    source: "export const tuple = [{}, 'stack']; Reflect.get.apply(holder.x, tuple);",
    callee: 'Reflect.get.apply',
    list: 1,
    entries: undefined,
  },
  {
    id: 'export-listed-tuple-member-receiver',
    source: "const tuple = [{}, 'stack']; Reflect.get.apply(holder.x, tuple); export { tuple };",
    callee: 'Reflect.get.apply',
    list: 1,
    entries: undefined,
  },
  {
    id: 'unreachable-member-receiver-pin',
    source: "const tuple = [{}, 'stack']; Reflect.get.apply(holder.x, tuple);",
    callee: 'Reflect.get.apply',
    list: 1,
    entries: ['{}', "'stack'"],
  },
  {
    id: 'native-target-argument-pin',
    source:
      "const tuple = [{}, 'stack']; Reflect.apply(Reflect.get, null, tuple); function later() { return tuple.length; }",
    callee: 'Reflect.apply',
    list: 2,
    entries: ['{}', "'stack'"],
  },
  {
    id: 'aliased-native-callee-pin',
    source:
      "const get = Reflect.get; const tuple = [{}, 'stack']; get.apply(undefined, tuple); function later() { return tuple.length; }",
    callee: 'get.apply',
    list: 1,
    entries: ['{}', "'stack'"],
  },
  {
    id: 'construct-new-target-pin',
    source:
      "class Failure extends Error {} const tuple = ['fixed']; Reflect.construct(Error, tuple, Failure);",
    callee: 'Reflect.construct',
    list: 1,
    entries: ["'fixed'"],
  },
];

const SPREAD = [
  {
    id: 'reviewed-spread-key-write',
    source: "const keys = ['safe']; Reflect.get((keys[0] = 'toString', target), ...keys);",
    callee: 'Reflect.get',
    prefix: { values: ["(keys[0] = 'toString', target)"], unknown: true, alternatives: [] },
  },
  {
    id: 'spread-after-receiver-write',
    source:
      "const tuple = [{}, 'stack']; Reflect.get.call((tuple[0] = new Error(), null), ...tuple);",
    callee: 'Reflect.get.call',
    prefix: { values: ['(tuple[0] = new Error(), null)'], unknown: true, alternatives: [] },
  },
  {
    id: 'spread-before-write-pin',
    source:
      "const tuple = [{}, 'stack']; Reflect.get.call(null, ...tuple, (tuple[0] = new Error()));",
    callee: 'Reflect.get.call',
    prefix: { values: ['null', '{}', "'stack'"], unknown: false, alternatives: undefined },
  },
  {
    id: 'listed-spread-receiver-write',
    source: "const tuple = [{}, 'stack']; Reflect.get.apply((tuple[0] = new Error()), [...tuple]);",
    callee: 'Reflect.get.apply',
    prefix: { values: ['{}'], unknown: true, alternatives: ['new Error()'] },
  },
  {
    id: 'construction-in-callee-pin',
    source: "const keys = ['safe'] as const; new Map([['safe', {}]]).get(...keys);",
    callee: "new Map([['safe', {}]]).get",
    prefix: { values: ["'safe'"], unknown: false, alternatives: undefined },
  },
];

/** The calls in `root` whose callee is written `callee`, by a walk of its tree. */
function callsOf(root: Node, callee: string): readonly CallExpression[] {
  const calls: CallExpression[] = [];
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isCallExpression(node) && node.expression.getText() === callee) calls.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return calls;
}

/** The arguments a spread case reads: those of a literal list it is given, or its own. */
function givenOf(call: CallExpression): readonly Expression[] {
  const [, list] = call.arguments;
  return list !== undefined && isArrayLiteralExpression(list) ? list.elements : call.arguments;
}

describe('a call’s own work before it reads a tuple', () => {
  it.each(APPLIED)('$id', ({ source, callee, list, entries }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'applied-tuple-work.ts', source);
    const read = callsOf(parsed.sourceFile, callee).map((call) => {
      const given = call.arguments[list];
      return given === undefined
        ? undefined
        : framedAppliedArguments(call, given)?.map((each) => each.getText());
    });

    expect(read).toStrictEqual([entries]);
  });

  it.each(SPREAD)('$id', ({ source, callee, prefix }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'spread-tuple-work.ts', source);
    const read = callsOf(parsed.sourceFile, callee).map((call) => {
      const { values, unknown, alternatives } = framedArgumentPrefix(call, givenOf(call), 3);
      return {
        values: values.map((each) => each.getText()),
        unknown,
        alternatives: alternatives?.map((each) => each.getText()),
      };
    });

    expect(read).toStrictEqual([prefix]);
  });
});
