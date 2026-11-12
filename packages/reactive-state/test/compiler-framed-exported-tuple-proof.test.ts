import { type CallExpression, isCallExpression, isSpreadElement, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedAppliedArguments, framedArgumentPrefix } from '../src/compiler/framed-keys.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A module that exports a tuple hands it to every module that imports it, and an importer can
 * replace its entries before it calls a function of this one that reads the tuple later: the entries
 * the tuple was written with are not what such a read sees. A read where the module is evaluated,
 * before any importer has run, a tuple that is not exported, and one that no function reads
 * later are as they were.
 */
const EXPOSED = { values: ['{}'], unknown: true, alternatives: [] };
const KEPT = { values: ['{}', "'stack'"], unknown: false, alternatives: undefined };

const SPREAD = [
  {
    id: 'reviewed-exported-tuple-read-by-an-exported-function',
    source:
      "export const tuple = [{}, 'stack']; export function read() { return Reflect.get(...tuple); }",
    prefix: EXPOSED,
  },
  {
    id: 'exported-tuple-read-by-a-function-of-the-module',
    source:
      "export const tuple = [{}, 'stack']; function read() { return Reflect.get(...tuple); } void read;",
    prefix: EXPOSED,
  },
  {
    id: 'exported-tuple-read-by-an-arrow',
    source: "export const tuple = [{}, 'stack']; export const read = () => Reflect.get(...tuple);",
    prefix: EXPOSED,
  },
  {
    id: 'exported-tuple-read-by-a-method',
    source:
      "export const tuple = [{}, 'stack']; export const holder = { read() { return Reflect.get(...tuple); } };",
    prefix: EXPOSED,
  },
  {
    id: 'tuple-listed-in-an-export-pin',
    source:
      "const tuple = [{}, 'stack']; export { tuple }; export function read() { return Reflect.get(...tuple); }",
    prefix: EXPOSED,
  },
  {
    id: 'tuple-not-exported-pin',
    source: "const tuple = [{}, 'stack']; export function read() { return Reflect.get(...tuple); }",
    prefix: KEPT,
  },
  {
    id: 'exported-tuple-read-where-the-module-is-evaluated-pin',
    source: "export const tuple = [{}, 'stack']; Reflect.get(...tuple);",
    prefix: KEPT,
  },
  {
    id: 'another-tuple-exported-pin',
    source:
      "export const other = [{}, 'stack']; const tuple = [{}, 'stack']; void other; export function read() { return Reflect.get(...tuple); }",
    prefix: KEPT,
  },
];

const APPLIED = [
  {
    id: 'exported-tuple-applied-by-an-exported-function',
    source:
      "export const tuple = [{}, 'stack']; export function read() { return Reflect.get.apply(null, tuple); }",
    entries: undefined,
  },
  {
    id: 'tuple-not-exported-applied-by-an-exported-function-pin',
    source:
      "const tuple = [{}, 'stack']; export function read() { return Reflect.get.apply(null, tuple); }",
    entries: ['{}', "'stack'"],
  },
  {
    id: 'exported-tuple-applied-where-the-module-is-evaluated-pin',
    source: "export const tuple = [{}, 'stack']; Reflect.get.apply(null, tuple);",
    entries: ['{}', "'stack'"],
  },
];

/** The call of `Reflect.get` in `root` that spreads its tuple or applies it, by a walk of its tree. */
function tupleCall(root: Node, callee: string): CallExpression {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isCallExpression(node) && node.expression.getText() === callee) return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no call');
}

describe('a tuple a module exports, read by a function of the module', () => {
  it.each(SPREAD)('$id', ({ source, prefix }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'exported-tuple-spread.ts', source);
    const call = tupleCall(parsed.sourceFile, 'Reflect.get');
    const { values, unknown, alternatives } = framedArgumentPrefix(call, call.arguments, 3);

    expect(call.arguments.some((each) => isSpreadElement(each))).toBe(true);
    expect({
      values: values.map((each) => each.getText()),
      unknown,
      alternatives: alternatives?.map((each) => each.getText()),
    }).toStrictEqual(prefix);
  });

  it.each(APPLIED)('$id', ({ source, entries }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'exported-tuple-applied.ts', source);
    const call = tupleCall(parsed.sourceFile, 'Reflect.get.apply');
    const [, given] = call.arguments;

    expect(given).toBeDefined();
    expect(
      given === undefined
        ? undefined
        : framedAppliedArguments(call, given)?.map((each) => each.getText()),
    ).toStrictEqual(entries);
  });
});
