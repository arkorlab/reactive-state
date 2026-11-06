import {
  type CallExpression,
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { sourceArrayFunction } from '../src/compiler/framed-array-functions.ts';
import { framedAppliedArguments } from '../src/compiler/framed-keys.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * An instance field's initializer runs at each construction, after what the class's scope goes on
 * to write: a method its object holds there, or a tuple's entry, may be replaced by then. A static
 * field's initializer runs where the class is defined, before what follows it.
 */
const METHODS = [
  {
    id: 'reviewed-instance-field-method',
    source:
      "const obj = { toString() { return 'custom'; } }; class C { method = obj.toString; } obj.toString = Array.prototype.toString; new C();",
    method: 'obj.toString',
    custom: false,
  },
  {
    id: 'reviewed-instance-field-function',
    source:
      'function custom() { return 1; } class C { value = custom; } custom = Array.prototype.toString; new C();',
    method: 'custom',
    custom: false,
  },
  {
    id: 'static-field-function-pin',
    source:
      'function custom() { return 1; } class C { static value = custom; } custom = Array.prototype.toString;',
    method: 'custom',
    custom: true,
  },
  {
    id: 'instance-field-immediate-call',
    source:
      "function frames(error: Error) { const methods = {join() { return 'fixed'; }}; class Reader { text = (() => { const values = [error]; values.join = methods.join; return values.join(','); })(); } methods.join = Array.prototype.join; return new Reader().text; }",
    method: 'methods.join',
    custom: false,
  },
  {
    id: 'unchanged-instance-field-pin',
    source:
      "function frames(error: Error) { const methods = {join() { return 'fixed'; }}; class Reader { text = (() => { const values = [error]; values.join = methods.join; return values.join(','); })(); } return new Reader().text; }",
    method: 'methods.join',
    custom: true,
  },
  {
    id: 'static-field-runs-first-pin',
    source:
      "function frames(error: Error) { const methods = {join() { return 'fixed'; }}; class Reader { static text = (() => { const values = [error]; values.join = methods.join; return values.join(','); })(); } methods.join = Array.prototype.join; return Reader.text; }",
    method: 'methods.join',
    custom: true,
  },
  {
    id: 'computed-field-name-runs-first-pin',
    source:
      "function frames(error: Error) { const methods = {join() { return 'fixed'; }}; const values = [error]; class Reader { [(values.join = methods.join, 'text')] = 0; } methods.join = Array.prototype.join; return values.join(','); }",
    method: 'methods.join',
    custom: true,
  },
];

const TUPLES = [
  {
    id: 'instance-field-tuple',
    source:
      "function frames(error: Error) { const tuple: [unknown, string] = [{}, 'stack']; class Reader { text = Reflect.get.apply(null, tuple); } tuple[0] = error; return new Reader().text; }",
    entries: undefined,
  },
  {
    id: 'static-field-tuple-pin',
    source:
      "function frames(error: Error) { const tuple: [unknown, string] = [{}, 'stack']; class Reader { static text = Reflect.get.apply(null, tuple); } tuple[0] = error; return Reader.text; }",
    entries: ['{}', "'stack'"],
  },
];

/** Every node of `root`'s tree, in the order a walk of it meets them. */
function nodesOf(root: Node): readonly Node[] {
  const nodes: Node[] = [];
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    nodes.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return nodes;
}

/**
 * The reads of `method` in `root`, a member's or a function's name, but those that write it and the
 * name a function declaration declares, the one name a declaration holds directly.
 */
function methodReads(root: Node, method: string): readonly Expression[] {
  return nodesOf(root).filter((node): node is Expression => {
    return (
      (isPropertyAccessExpression(node) || isIdentifier(node)) &&
      node.getText() === method &&
      !(isBinaryExpression(node.parent) && node.parent.left === node) &&
      !isFunctionDeclaration(node.parent)
    );
  });
}

/** What the tuple proof keeps of each `Reflect.get.apply` call's list in `root`, as text. */
function appliedEntries(root: Node): readonly (readonly string[] | undefined)[] {
  const calls = nodesOf(root).filter(
    (node): node is CallExpression =>
      isCallExpression(node) && node.expression.getText() === 'Reflect.get.apply',
  );
  return calls.map((call) => {
    const list = call.arguments[1];
    return list === undefined
      ? undefined
      : framedAppliedArguments(call, list)?.map((each) => each.getText());
  });
}

describe('instance field initializers as execution owners', () => {
  it.each(METHODS)('$id', ({ source, method, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'field-initializer-owners.ts', source);
    const reads = methodReads(parsed.sourceFile, method);

    expect(reads).toHaveLength(1);
    expect(reads.map((each) => sourceArrayFunction(each))).toStrictEqual([custom]);
  });

  it.each(TUPLES)('$id', ({ source, entries }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'field-initializer-tuples.ts', source);

    expect(appliedEntries(parsed.sourceFile)).toStrictEqual([entries]);
  });
});
