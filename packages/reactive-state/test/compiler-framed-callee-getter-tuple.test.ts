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
 * A call reads its callee's member before its arguments, and a member read runs a getter: what a
 * getter of the callee's holder writes into a captured tuple is what the call then reads. The
 * getter is a function of the module's that names the tuple, so `namedElsewhere` finds it wherever
 * it is declared. A member of the language's own globals, or of a constant that names one, runs
 * none; a holder's member read where no other function names the tuple reaches nothing.
 */
const GETTER = "get get() { tuple[0] = new Error('changed'); return Reflect.get; }";
const TUPLE = "const tuple = [{}, 'message'];";

const SPREAD = [
  {
    id: 'reviewed-callee-getter',
    source: `const holder = { ${GETTER} }; ${TUPLE} holder.get(...tuple);`,
    callee: 'holder.get',
    prefix: { values: ['{}'], unknown: true, alternatives: ["new Error('changed')"] },
  },
  {
    id: 'callee-getter-in-element-access',
    source: `const holder = { ${GETTER} }; ${TUPLE} holder['get'](...tuple);`,
    callee: "holder['get']",
    prefix: { values: ['{}'], unknown: true, alternatives: ["new Error('changed')"] },
  },
  {
    id: 'callee-getter-in-parentheses',
    source: `const holder = { ${GETTER} }; ${TUPLE} (holder.get)(...tuple);`,
    callee: '(holder.get)',
    prefix: { values: ['{}'], unknown: true, alternatives: ["new Error('changed')"] },
  },
  {
    id: 'callee-getter-of-a-nested-holder',
    source: `const outer = { holder: { ${GETTER} } }; ${TUPLE} outer.holder.get(...tuple);`,
    callee: 'outer.holder.get',
    prefix: { values: ['{}'], unknown: true, alternatives: ["new Error('changed')"] },
  },
  {
    id: 'callee-class-getter',
    source: `class Holder { ${GETTER} } const holder = new Holder(); ${TUPLE} holder.get(...tuple);`,
    callee: 'holder.get',
    prefix: { values: ['{}'], unknown: true, alternatives: ["new Error('changed')"] },
  },
  {
    id: 'callee-member-of-a-constant-holder-read-elsewhere',
    source: `const holder = { get: Reflect.get }; ${TUPLE} holder.get(...tuple); function later() { return tuple.length; }`,
    callee: 'holder.get',
    prefix: { values: ['{}'], unknown: true, alternatives: [] },
  },
  {
    id: 'callee-member-unreached-pin',
    source: `const holder = { get: Reflect.get }; ${TUPLE} holder.get(...tuple);`,
    callee: 'holder.get',
    prefix: { values: ['{}', "'message'"], unknown: false, alternatives: undefined },
  },
  {
    id: 'native-callee-pin',
    source: `${TUPLE} Reflect.get(...tuple); function later() { return tuple.length; }`,
    callee: 'Reflect.get',
    prefix: { values: ['{}', "'message'"], unknown: false, alternatives: undefined },
  },
  {
    id: 'native-callee-through-call-pin',
    source: `${TUPLE} Reflect.get.call(null, ...tuple); function later() { return tuple.length; }`,
    callee: 'Reflect.get.call',
    prefix: { values: ['null', '{}', "'message'"], unknown: false, alternatives: undefined },
  },
  {
    id: 'named-callee-pin',
    source: `const get = Reflect.get; ${TUPLE} get(...tuple); function later() { return tuple.length; }`,
    callee: 'get',
    prefix: { values: ['{}', "'message'"], unknown: false, alternatives: undefined },
  },
  {
    id: 'aliased-native-member-pin',
    source: `const get = Reflect.get; ${TUPLE} get.call(null, ...tuple); function later() { return tuple.length; }`,
    callee: 'get.call',
    prefix: { values: ['null', '{}', "'message'"], unknown: false, alternatives: undefined },
  },
  {
    id: 'twice-aliased-native-member-pin',
    source: `const reflect = Reflect; const get = reflect.get; ${TUPLE} get.call(null, ...tuple); function later() { return tuple.length; }`,
    callee: 'get.call',
    prefix: { values: ['null', '{}', "'message'"], unknown: false, alternatives: undefined },
  },
  {
    id: 'destructured-native-member-pin',
    source: `const { get } = Reflect; ${TUPLE} get.call(null, ...tuple); function later() { return tuple.length; }`,
    callee: 'get.call',
    prefix: { values: ['null', '{}', "'message'"], unknown: false, alternatives: undefined },
  },
  {
    id: 'reviewed-defaulted-holder',
    source: `const fallback = { ${GETTER} }; const { missing: holder = fallback } = Reflect; ${TUPLE} holder.get(...tuple);`,
    callee: 'holder.get',
    prefix: { values: ['{}'], unknown: true, alternatives: ["new Error('changed')"] },
  },
  {
    id: 'defaulted-holder-in-a-nested-pattern',
    source: `const fallback = { ${GETTER} }; const { missing: { inner: holder } = { inner: fallback } } = Reflect; ${TUPLE} holder.get(...tuple);`,
    callee: 'holder.get',
    prefix: { values: ['{}'], unknown: true, alternatives: ["new Error('changed')"] },
  },
  {
    id: 'renamed-destructured-native-member-pin',
    source: `const { get: take } = Reflect; ${TUPLE} take.call(null, ...tuple); function later() { return tuple.length; }`,
    callee: 'take.call',
    prefix: { values: ['null', '{}', "'message'"], unknown: false, alternatives: undefined },
  },
  {
    id: 'mutable-alias-member-read',
    source: `let get = Reflect.get; ${TUPLE} get.call(null, ...tuple); function later() { return tuple.length; }`,
    callee: 'get.call',
    prefix: { values: ['null'], unknown: true, alternatives: [] },
  },
  {
    id: 'aliased-global-object-pin',
    source: `const reflect = Reflect; ${TUPLE} reflect.get(...tuple); function later() { return tuple.length; }`,
    callee: 'reflect.get',
    prefix: { values: ['{}', "'message'"], unknown: false, alternatives: undefined },
  },
];

const APPLIED = [
  {
    id: 'callee-getter-before-apply',
    source: `const holder = { ${GETTER} }; ${TUPLE} holder.get.apply(null, tuple);`,
    callee: 'holder.get.apply',
    entries: undefined,
  },
  {
    id: 'aliased-native-callee-pin',
    source: `const get = Reflect.get; ${TUPLE} get.apply(undefined, tuple); function later() { return tuple.length; }`,
    callee: 'get.apply',
    entries: ['{}', "'message'"],
  },
  {
    id: 'native-apply-pin',
    source: `${TUPLE} Reflect.get.apply(null, tuple); function later() { return tuple.length; }`,
    callee: 'Reflect.get.apply',
    entries: ['{}', "'message'"],
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

describe('a callee’s member read before a captured tuple', () => {
  it.each(SPREAD)('$id', ({ source, callee, prefix }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'callee-getter-spread.ts', source);
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

  it.each(APPLIED)('$id', ({ source, callee, entries }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'callee-getter-applied.ts', source);
    const read = callsOf(parsed.sourceFile, callee).map((call) => {
      const [, given] = call.arguments;
      return given === undefined
        ? undefined
        : framedAppliedArguments(call, given)?.map((each) => each.getText());
    });

    expect(read).toStrictEqual([entries]);
  });
});
