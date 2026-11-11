import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isSpreadElement,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedAppliedArguments, framedArgumentPrefix } from '../src/compiler/framed-keys.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A class's `extends` clause reads its superclass's `prototype` where the class is defined, and a
 * proxy answers that read with a `get` trap of the application's own: a trap that names a captured
 * tuple, though it is written before the tuple, replaces its entries before a later native read.
 * Only the clause of a class runs; an `implements` clause and an interface's `extends` are types.
 */
const BASE =
  "const Base = new Proxy(class {}, { get(target, key) { tuple[0] = new Error(); return Reflect.get(target, key); } }); const tuple = [{}, 'stack'];";
const PLAIN =
  "class Plain {} function later() { return tuple.length; } const tuple = [{}, 'stack'];";

const APPLIED = [
  {
    id: 'reviewed-class-extends-a-proxy',
    source: `${BASE} class Derived extends Base {} Reflect.get.apply(null, tuple);`,
    entries: undefined,
  },
  {
    id: 'class-expression-extends-a-proxy',
    source: `${BASE} const Derived = class extends Base {}; void Derived; Reflect.get.apply(null, tuple);`,
    entries: undefined,
  },
  {
    id: 'class-extends-a-call-pin',
    source: `${BASE} function pick() { return Base; } class Derived extends pick() {} Reflect.get.apply(null, tuple);`,
    entries: undefined,
  },
  {
    id: 'class-extends-a-plain-class-where-a-function-names-the-tuple',
    source: `${PLAIN} class Derived extends Plain {} Reflect.get.apply(null, tuple);`,
    entries: undefined,
  },
  {
    id: 'class-implements-an-interface-pin',
    source: `${PLAIN} interface Shape {} class Derived implements Shape {} Reflect.get.apply(null, tuple);`,
    entries: ['{}', "'stack'"],
  },
  {
    id: 'interface-extends-an-interface-pin',
    source: `${PLAIN} interface Shape {} interface Wide extends Shape {} Reflect.get.apply(null, tuple);`,
    entries: ['{}', "'stack'"],
  },
  {
    id: 'class-without-a-heritage-pin',
    source: `${PLAIN} class Derived {} Reflect.get.apply(null, tuple);`,
    entries: ['{}', "'stack'"],
  },
  {
    id: 'class-extends-where-no-function-names-the-tuple-pin',
    source:
      "class Plain {} const tuple = [{}, 'stack']; class Derived extends Plain {} Reflect.get.apply(null, tuple);",
    entries: ['{}', "'stack'"],
  },
  {
    id: 'class-extends-after-the-call-pin',
    source: `${BASE} Reflect.get.apply(null, tuple); class Derived extends Base {}`,
    entries: ['{}', "'stack'"],
  },
];

const SPREAD = [
  {
    id: 'class-extends-a-proxy-before-a-spread',
    source: `${BASE} class Derived extends Base {} Reflect.get.call(null, ...tuple);`,
    prefix: { values: ['null'], unknown: true, alternatives: [] },
  },
  {
    id: 'class-extends-a-proxy-before-a-spread-of-the-receiver',
    source: `${BASE} class Derived extends Base {} Reflect.get(...tuple);`,
    prefix: { values: ['{}'], unknown: true, alternatives: ['new Error()'] },
  },
  {
    id: 'class-implements-before-a-spread-pin',
    source: `${PLAIN} interface Shape {} class Derived implements Shape {} Reflect.get(...tuple);`,
    prefix: { values: ['{}', "'stack'"], unknown: false, alternatives: undefined },
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

describe('a class heritage before a captured tuple’s native read', () => {
  it.each(APPLIED)('$id', ({ source, entries }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'class-heritage-applied.ts', source);
    const read = callsOf(parsed.sourceFile, 'Reflect.get.apply').map((call) => {
      const [, given] = call.arguments;
      return given === undefined
        ? undefined
        : framedAppliedArguments(call, given)?.map((each: Expression) => each.getText());
    });

    expect(read).toStrictEqual([entries]);
  });

  it.each(SPREAD)('$id', ({ source, prefix }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'class-heritage-spread.ts', source);
    const callee = source.includes('Reflect.get.call(') ? 'Reflect.get.call' : 'Reflect.get';
    const spreads = callsOf(parsed.sourceFile, callee).filter((call) =>
      call.arguments.some((each) => isSpreadElement(each)),
    );
    const read = spreads.map((call) => {
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
