import { type CallExpression, isCallExpression, isSpreadElement, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedArgumentPrefix } from '../src/compiler/framed-keys.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A call that spreads a captured tuple reads its entries where the spread stands, and what the call
 * evaluates after the spread comes too late for that read. Where the call passes again, in a loop,
 * the next pass reads the tuple as that work left it: a write after the spread, or a function it
 * runs, replaces the entries the next spread reads. A call that passes once, and a tuple the loop
 * declares anew each pass, leave the entries as written.
 */
const TUPLE = "const tuple = [{}, 'stack']; declare const more: boolean; declare const x: unknown;";
const EXPOSED = { values: ['{}'], unknown: true, alternatives: ['new Error()'] };
const KEPT = {
  values: ['{}', "'stack'", '(tuple[0] = new Error())'],
  unknown: false,
  alternatives: undefined,
};

const CASES = [
  {
    id: 'reviewed-write-after-the-spread-in-a-for-loop',
    source: `${TUPLE} for (let pass = 0; pass < 2; pass++) { Reflect.get(...tuple, (tuple[0] = new Error())); }`,
    prefix: EXPOSED,
  },
  {
    id: 'write-after-the-spread-in-a-while-loop',
    source: `${TUPLE} while (more) { Reflect.get(...tuple, (tuple[0] = new Error())); }`,
    prefix: EXPOSED,
  },
  {
    id: 'write-after-the-spread-in-a-do-loop',
    source: `${TUPLE} do { Reflect.get(...tuple, (tuple[0] = new Error())); } while (more);`,
    prefix: EXPOSED,
  },
  {
    id: 'write-after-the-spread-in-a-for-of-loop',
    source: `${TUPLE} for (const each of [1, 2]) { void each; Reflect.get(...tuple, (tuple[0] = new Error())); }`,
    prefix: EXPOSED,
  },
  {
    id: 'write-after-the-spread-in-an-outer-loop',
    source: `${TUPLE} while (more) { if (x) { Reflect.get(...tuple, (tuple[0] = new Error())); } }`,
    prefix: EXPOSED,
  },
  {
    id: 'function-run-after-the-spread-in-a-loop',
    source: `function swap() { return (tuple[0] = new Error()); } ${TUPLE} while (more) { Reflect.get(...tuple, swap()); }`,
    prefix: EXPOSED,
  },
  {
    id: 'write-after-a-second-spread-in-a-loop',
    source: `${TUPLE} const rest = [1]; while (more) { Reflect.get(...tuple, ...rest, (tuple[0] = new Error())); }`,
    prefix: EXPOSED,
  },
  {
    id: 'write-after-the-spread-outside-a-loop-pin',
    source: `${TUPLE} Reflect.get(...tuple, (tuple[0] = new Error()));`,
    prefix: KEPT,
  },
  {
    id: 'write-after-the-spread-in-a-loop-that-passes-once-pin',
    source: `${TUPLE} for (const each of [1]) { void each; Reflect.get(...tuple, (tuple[0] = new Error())); }`,
    prefix: KEPT,
  },
  {
    id: 'write-after-the-spread-in-a-tuple-declared-each-pass-pin',
    source: `declare const more: boolean; while (more) { const tuple = [{}, 'stack']; Reflect.get(...tuple, (tuple[0] = new Error())); }`,
    prefix: KEPT,
  },
  {
    id: 'write-after-the-spread-in-a-for-initializer-pin',
    source: `${TUPLE} for (let pass = Reflect.get(...tuple, (tuple[0] = new Error())); more; ) { void pass; }`,
    prefix: KEPT,
  },
  {
    id: 'unrelated-argument-after-the-spread-in-a-loop-pin',
    source: `${TUPLE} while (more) { Reflect.get(...tuple, x); }`,
    prefix: { values: ['{}', "'stack'", 'x'], unknown: false, alternatives: undefined },
  },
  {
    id: 'spread-in-a-loop-with-no-work-after-it-pin',
    source: `${TUPLE} while (more) { Reflect.get(...tuple); } function later() { return tuple.length; }`,
    prefix: { values: ['{}', "'stack'"], unknown: false, alternatives: undefined },
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

describe('a spread of a captured tuple in a call that passes again', () => {
  it.each(CASES)('$id', ({ source, prefix }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'repeated-spread-tail.ts', source);
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
