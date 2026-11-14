import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isClassExpression,
  isConstructorDeclaration,
  isElementAccessExpression,
  isIdentifier,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isVariableDeclaration,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { emptyArrayFill } from '../src/compiler/framed-array-fill-ranges.ts';
import { sourceArrayFunction } from '../src/compiler/framed-array-functions.ts';
import { framedLogicalElementSkipped } from '../src/compiler/framed-array-logical-writes.ts';
import { type FrameBinding, frameBindingOf } from '../src/compiler/framed-bindings.ts';
import { framedConstructorDefaultEvaluation } from '../src/compiler/framed-constructor-default-evaluation.ts';
import { framedAppliedArguments } from '../src/compiler/framed-keys.ts';
import { framedQuietOwnerPrefix } from '../src/compiler/framed-native-prefix.ts';
import { framedOriginCoowned } from '../src/compiler/framed-origin-ownership.ts';
import { framedAssignedValues } from '../src/compiler/framed-writes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * TypeScript counts a class's `extends` expression, and an instantiation expression `f<T>`, among
 * its type nodes (`ExpressionWithTypeArguments`), though both read their expression where they are
 * evaluated: the superclass expression where the class is defined (ECMA-262, ClassDefinitionEvaluation).
 * A walk that leaves every type node out leaves out what they do — a write, a call, a use of a
 * name. An `implements` clause, an interface's `extends` and a type annotation are types alone, and
 * stay out.
 */

/** Every node of `root`'s tree. */
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

/** The binding a name stands for. */
function identity(value: Expression): FrameBinding | undefined {
  const name = unwrapped(value);
  return isIdentifier(name) ? frameBindingOf(name)?.binding : undefined;
}

/** The first node of `root` that `pick` selects. */
function find<T extends Node>(root: Node, pick: (node: Node) => node is T): T {
  const found = nodesOf(root).find(pick);
  if (found === undefined) throw new Error('not found');
  return found;
}

const FILLS = [
  {
    id: 'fill-length-changed-in-a-class-extends',
    source: 'const values = [1, 2]; class A extends (values.push(3), Object) {} values.fill(0, 2);',
    empty: false,
  },
  {
    id: 'fill-length-changed-in-a-class-expression-extends',
    source:
      'const values = [1, 2]; const A = class extends (values.push(3), Object) {}; void A; values.fill(0, 2);',
    empty: false,
  },
  {
    id: 'fill-length-changed-in-an-instantiation-expression',
    source:
      'declare function id<T>(): T; const values = [1, 2]; (values.push(3), id)<string>; values.fill(0, 2);',
    empty: false,
  },
  {
    id: 'fill-beside-a-class-without-a-write-pin',
    source: 'const values = [1, 2]; class A extends Object {} void A; values.fill(0, 2);',
    empty: true,
  },
  {
    id: 'fill-beside-an-implements-clause-naming-the-array-pin',
    source:
      'const values = [1, 2]; class A implements values {} void A; interface Wide extends values {} values.fill(0, 2);',
    empty: true,
  },
  {
    id: 'fill-beside-an-implements-clause-naming-an-interface-of-the-array-name-pin',
    source:
      'interface values {} const values = [1, 2]; class A implements values {} void A; values.fill(0, 2);',
    empty: true,
  },
  {
    id: 'fill-beside-an-implements-clause-pin',
    source:
      'interface Shape { size: number } const values = [1, 2]; class A implements Shape { size = 1; } void A; values.fill(0, 2);',
    empty: true,
  },
  {
    id: 'fill-beside-an-interface-extends-and-a-type-query-pin',
    source:
      'interface Shape { size: number } interface Wide extends Shape { wide: boolean } const values = [1, 2]; let kept: typeof values | undefined; void kept; values.fill(0, 2);',
    empty: true,
  },
];

const LOGICAL = [
  {
    id: 'slot-written-in-a-class-extends',
    source:
      'declare function g(): number; const arr = [1]; class A extends (arr[0] = 0, Object) {} void A; arr[0] ||= g();',
    skipped: false,
  },
  {
    id: 'slot-beside-a-class-without-a-write-pin',
    source:
      'declare function g(): number; const arr = [1]; class A extends Object {} void A; arr[0] ||= g();',
    skipped: true,
  },
  {
    id: 'slot-beside-an-implements-clause-pin',
    source:
      'declare function g(): number; interface Shape { size: number } const arr = [1]; class A implements Shape { size = 1; } void A; arr[0] ||= g();',
    skipped: true,
  },
];

const METHODS = [
  {
    id: 'method-replaced-in-an-instantiation-expression',
    source:
      "declare function id<T>(): T; const methods = { join() { return 'fixed'; } }; (methods.join = Array.prototype.join, id)<string>; const taken = methods.join;",
    custom: false,
  },
  {
    id: 'method-replaced-in-a-class-extends-another-function-reads',
    source:
      "const methods = { join() { return 'fixed'; } }; function read() { return methods.join; } class A extends (methods.join = Array.prototype.join, Object) {} void A; void read;",
    custom: false,
  },
  {
    id: 'method-read-beside-a-class-without-a-write-pin',
    source:
      "const methods = { join() { return 'fixed'; } }; function read() { return methods.join; } class A extends Object {} void A; void read;",
    custom: true,
  },
  {
    id: 'method-read-beside-a-type-only-mention-pin',
    source:
      "declare function id<T>(): T; const methods = { join() { return 'fixed'; } }; let kept: typeof methods | undefined; void kept; (id)<string>; const taken = methods.join;",
    custom: true,
  },
];

const APPLIED = [
  {
    id: 'tuple-written-in-a-class-another-function-defines',
    source:
      "function define() { class Base extends (tuple[0] = new Error(), Object) {} return Base; } const tuple = [{}, 'stack']; Reflect.get.apply(define(), tuple);",
    entries: undefined,
  },
  {
    id: 'tuple-written-in-an-argument-class-extends',
    source:
      "const tuple = [{}, 'stack']; Reflect.get.apply(class extends (tuple[0] = new Error(), Object) {}, tuple);",
    entries: undefined,
  },
  {
    id: 'tuple-beside-an-argument-class-without-a-write-pin',
    source: "const tuple = [{}, 'stack']; Reflect.get.apply(class extends Object {}, tuple);",
    entries: ['{}', "'stack'"],
  },
  {
    id: 'tuple-named-only-in-a-type-pin',
    source:
      "function define() { let kept: typeof tuple | undefined; void kept; return kept; } const tuple = [{}, 'stack']; Reflect.get.apply(define(), tuple);",
    entries: ['{}', "'stack'"],
  },
];

const ASSIGNED = [
  {
    id: 'overwrite-after-a-class-extends-uses-the-data',
    source:
      'declare function mutate(v: unknown): void; function f(error: Error) { let x: unknown; x = error; const data = { a: 1 }; class K extends (mutate(data), Object) {} void K; x = data; return x; }',
    values: ['data', 'error'],
  },
  {
    id: 'overwrite-after-an-instantiation-expression-uses-the-data',
    source:
      'declare function mutate(v: unknown): void; declare function id<T>(v: unknown): T; function f(error: Error) { let x: unknown; x = error; const data = { a: 1 }; (mutate(data), id)<string>; x = data; return x; }',
    values: ['data', 'error'],
  },
  {
    id: 'overwrite-beside-a-class-without-a-use-pin',
    source:
      'function f(error: Error) { let x: unknown; x = error; const data = { a: 1 }; class K extends Object {} void K; x = data; return x; }',
    values: ['data'],
  },
  {
    id: 'overwrite-beside-an-implements-clause-naming-the-data-pin',
    source:
      'function f(error: Error) { let x: unknown; x = error; const data = { a: 1 }; class K implements data {} void K; x = data; return x; }',
    values: ['data'],
  },
  {
    id: 'overwrite-beside-a-type-only-use-pin',
    source:
      'function f(error: Error) { let x: unknown; x = error; const data = { a: 1 }; let kept: typeof data | undefined; void kept; x = data; return x; }',
    values: ['data'],
  },
];

const CARRIED = [
  {
    id: 'class-extends-a-name-of-another-owner',
    source:
      "const carried = new Error('x'); function frames() { const k = class extends (carried, Object) {}; return k; }",
    coowned: false,
  },
  {
    id: 'class-extends-a-plain-class-pin',
    source:
      "const carried = new Error('x'); function frames() { const k = class extends Object {}; void carried; return k; }",
    coowned: true,
  },
];

const PREFIXES = [
  {
    id: 'call-in-an-instantiation-expression-before-the-consumer',
    source:
      'declare function work(): void; declare function id<T>(): T; function frames(error: Error) { (work(), id)<string>; return error.stack; }',
    quiet: false,
  },
  {
    id: 'instantiation-expression-without-work-pin',
    source:
      'declare function id<T>(): T; function frames(error: Error) { id<string>; return error.stack; }',
    quiet: true,
  },
];

const DEFAULTS = [
  {
    id: 'call-in-an-instantiation-expression-default',
    source:
      'declare function work(): void; declare function id<T>(v?: unknown): T; class C { constructor(x = (work(), id)<string>) { void x; } }',
    quiet: false,
  },
  {
    id: 'instantiation-expression-default-without-work-pin',
    source:
      'declare function id<T>(v?: unknown): T; class C { constructor(x = id<string>) { void x; } }',
    quiet: true,
  },
];

describe('what a class’s extends expression and an instantiation expression do', () => {
  it.each(FILLS)('$id', ({ source, empty }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'heritage-fill.ts', source);
    const call = find(parsed.sourceFile, (node): node is CallExpression => {
      return (
        isCallExpression(node) &&
        isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'fill'
      );
    });
    const receiver = isPropertyAccessExpression(call.expression)
      ? call.expression.expression
      : call;
    const root = identity(receiver);

    expect(root).toBeDefined();
    expect(
      root !== undefined &&
        emptyArrayFill(call.arguments, { receiver, root, call, borrowed: false, identity }),
    ).toBe(empty);
  });

  it.each(LOGICAL)('$id', ({ source, skipped }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'heritage-logical.ts', source);
    const write = find(
      parsed.sourceFile,
      (node): node is BinaryExpression =>
        isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.BarBarEqualsToken,
    );
    const target = unwrapped(write.left);
    const root = isElementAccessExpression(target) ? identity(target.expression) : undefined;

    expect(root).toBeDefined();
    expect(
      root !== undefined && framedLogicalElementSkipped(write, root, (v) => identity(v) === root),
    ).toBe(skipped);
  });

  it.each(METHODS)('$id', ({ source, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'heritage-method.ts', source);
    const reads = nodesOf(parsed.sourceFile).filter((node): node is Expression => {
      return (
        isPropertyAccessExpression(node) &&
        node.getText() === 'methods.join' &&
        !(isBinaryExpression(node.parent) && node.parent.left === node)
      );
    });

    expect(reads).toHaveLength(1);
    expect(reads.map((each) => sourceArrayFunction(each))).toStrictEqual([custom]);
  });

  it.each(APPLIED)('$id', ({ source, entries }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'heritage-tuple.ts', source);
    const call = find(
      parsed.sourceFile,
      (node): node is CallExpression =>
        isCallExpression(node) && node.expression.getText() === 'Reflect.get.apply',
    );
    const [, given] = call.arguments;

    expect(given).toBeDefined();
    expect(
      given === undefined
        ? undefined
        : framedAppliedArguments(call, given)?.map((each) => each.getText()),
    ).toStrictEqual(entries);
  });

  it.each(ASSIGNED)('$id', ({ source, values }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'heritage-assigned.ts', source);
    const reads = nodesOf(parsed.sourceFile).filter(
      (node): node is Identifier =>
        isIdentifier(node) && node.text === 'x' && !isVariableDeclaration(node.parent),
    );
    const [last] = reads.toSorted((a, b) => b.pos - a.pos);

    expect(last).toBeDefined();
    expect(
      last === undefined ? [] : framedAssignedValues(last).map((v) => v.getText()),
    ).toStrictEqual(values);
  });

  it.each(CARRIED)('$id', ({ source, coowned }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'heritage-carried.ts', source);
    const carriedSource = find(parsed.sourceFile, isClassExpression);
    const consumer = nodesOf(parsed.sourceFile)
      .filter((node): node is Identifier => isIdentifier(node) && node.text === 'k')
      .toSorted((a, b) => b.pos - a.pos)[0];

    expect(consumer).toBeDefined();
    expect(consumer !== undefined && framedOriginCoowned(carriedSource, consumer)).toBe(coowned);
  });

  it.each(PREFIXES)('$id', ({ source, quiet }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'heritage-prefix.ts', source);
    const consumer = find(
      parsed.sourceFile,
      (node): node is Expression =>
        isPropertyAccessExpression(node) && node.getText() === 'error.stack',
    );

    expect(framedQuietOwnerPrefix(consumer, { primitive: () => true, call: () => false })).toBe(
      quiet,
    );
  });

  it.each(DEFAULTS)('$id', ({ source, quiet }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'heritage-defaults.ts', source);
    const parameters = nodesOf(parsed.sourceFile).filter(
      (node): node is ParameterDeclaration =>
        isParameterDeclaration(node) && isConstructorDeclaration(node.parent),
    );

    expect(parameters).toHaveLength(1);
    expect(framedConstructorDefaultEvaluation(parameters, [])).toBe(quiet);
  });
});
