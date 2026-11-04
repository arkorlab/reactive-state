import {
  type ArrayLiteralExpression,
  type Expression,
  isArrayLiteralExpression,
  isBlock,
  isCallExpression,
  isConstructorDeclaration,
  isIdentifier,
  isOmittedExpression,
  isSourceFile,
  isSpreadElement,
  isVariableStatement,
  isVoidExpression,
  type Node,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { calledMember, unwrapped } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { writtenDescriptors } from './throw-definitions.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';

/** Native mutations of a proven locked array, evaluated only on a source-bounded descriptor model. */
const MUTATOR_NAMES = ['push', 'pop', 'shift', 'unshift', 'splice', 'fill', 'reverse', 'sort'];
const MUTATORS: ReadonlyMap<string, unknown> = new Map(
  MUTATOR_NAMES.map((key) => [key, Object.getOwnPropertyDescriptor(Array.prototype, key)?.value]),
);
const ARITY = { descriptor: 3, pair: 2, single: 1 } as const;
const WRAPPERS: ReadonlyMap<string, number> = new Map([
  ['Object.defineProperties', ARITY.pair],
  ['Object.defineProperty', ARITY.descriptor],
  ['Object.freeze', ARITY.single],
  ['Object.preventExtensions', ARITY.single],
  ['Object.seal', ARITY.single],
]);
interface ArraySnapshot {
  readonly literal: ArrayLiteralExpression;
  readonly descriptors: NonNullable<ReturnType<typeof writtenDescriptors>>;
}
interface Bound {
  readonly value: string | number | boolean | null | undefined;
}

/** Whether a native mutator necessarily performs a forbidden write on its written array. */
export function arrayMutatorThrows(node: Node, outer: Resolve | undefined): boolean {
  if (
    !isCallExpression(node) ||
    node.arguments.some((each) => isSpreadElement(each) || callbackCreationEffect(each)) ||
    earlierExpressionEffect(node)
  ) {
    return false;
  }
  const member = calledMember(unwrapped(node.expression));
  const native = member === undefined ? undefined : MUTATORS.get(member.name);
  if (member === undefined || typeof native !== 'function') {
    return false;
  }
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  const snapshot = arraySnapshot(member.of, resolve);
  if (
    snapshot === undefined ||
    snapshot.descriptors.properties.has(member.name) ||
    calleeUncertain(writtenOf(member.of, resolve), node) ||
    priorStatementEffect(node, resolve)
  ) {
    return false;
  }
  const given = argumentsOf(member.name, node.arguments, snapshot.literal, resolve);
  if (given === undefined) {
    return false;
  }
  try {
    const model = arrayModel(snapshot);
    Reflect.apply(native, model, given);
  } catch {
    return true;
  }
  return false;
}

/** A native locking chain preserves the identity of its sole literal array target. */
function arraySnapshot(node: Expression, resolve: Resolve): ArraySnapshot | undefined {
  const seen = new Set<Expression>();
  let value = writtenOf(node, resolve);
  while (isCallExpression(value) && !seen.has(value)) {
    seen.add(value);
    const path = globalCalleePath(value.expression, resolve)?.join('.') ?? '';
    const [first, ...rest] = value.arguments;
    if (
      first === undefined ||
      value.arguments.length !== WRAPPERS.get(path) ||
      value.arguments.some((each) => isSpreadElement(each)) ||
      rest.some((each) => callbackCreationEffect(each))
    ) {
      return undefined;
    }
    value = writtenOf(first, resolve);
  }
  if (
    !isArrayLiteralExpression(value) ||
    value.elements.some((each) => isSpreadElement(each)) ||
    callbackCreationEffect(value)
  ) {
    return undefined;
  }
  const descriptors = writtenDescriptors(node, resolve);
  if (
    descriptors === undefined ||
    descriptors.extensible ||
    descriptors.properties.has('constructor') ||
    !ordinarySlots(descriptors, value.elements.length)
  ) {
    return undefined;
  }
  return { descriptors, literal: value };
}

/** No getters, species override or length-changing definition is copied into the descriptor model. */
function ordinarySlots(snapshot: ArraySnapshot['descriptors'], length: number): boolean {
  const held = snapshot.properties.get('length')?.values.get('value')?.value;
  if (held !== length) {
    return false;
  }
  for (const [key, property] of snapshot.properties) {
    if (property.kind !== 'data') {
      return false;
    }
    const index = Number(key);
    if (Number.isSafeInteger(index) && index >= length && String(index) === key) {
      return false;
    }
  }
  return true;
}

/** Placeholder values preserve sparse positions and flags, without retaining application values. */
function arrayModel({ literal, descriptors }: ArraySnapshot): unknown[] {
  const model: unknown[] = [];
  model.length = literal.elements.length;
  for (const [key, property] of descriptors.properties) {
    Object.defineProperty(model, key, {
      configurable: property.configurable,
      enumerable: property.enumerable,
      value: key === 'length' ? literal.elements.length : 0,
      writable: property.writable,
    });
  }
  Object.preventExtensions(model);
  return model;
}

/** Inserted values are not coerced; range positions require known primitive conversions. */
function argumentsOf(
  method: string,
  given: readonly Expression[],
  literal: ArrayLiteralExpression,
  resolve: Resolve,
): readonly unknown[] | undefined {
  if (method === 'push' || method === 'unshift') {
    return given.map(() => 0);
  }
  if (method === 'fill') {
    return fillArguments(given, resolve);
  }
  if (method === 'splice') {
    return spliceArguments(given, resolve);
  }
  if (given.length > 0) {
    return undefined;
  }
  return method !== 'sort' ||
    literal.elements.every(
      (each) =>
        isOmittedExpression(each) || primitiveOf(writtenOf(each, resolve), resolve) !== undefined,
    )
    ? []
    : undefined;
}

/** Fill converts only start/end; its value is stored without application conversion. */
function fillArguments(
  given: readonly Expression[],
  resolve: Resolve,
): readonly unknown[] | undefined {
  if (given.length > ARITY.descriptor) {
    return undefined;
  }
  const result: unknown[] = given.length === 0 ? [] : [0];
  for (const argument of given.slice(1)) {
    const bound = primitiveBound(argument, resolve);
    if (bound === undefined) {
      return undefined;
    }
    result.push(bound.value);
  }
  return result;
}

/** Splice preserves omitted arguments and converts only its first two range positions. */
function spliceArguments(
  given: readonly Expression[],
  resolve: Resolve,
): readonly unknown[] | undefined {
  const result: unknown[] = [];
  for (const [index, argument] of given.entries()) {
    if (index >= ARITY.pair) {
      result.push(0);
      continue;
    }
    const bound = primitiveBound(argument, resolve);
    if (bound === undefined) {
      return undefined;
    }
    result.push(bound.value);
  }
  return result;
}

/** Bounds whose native numeric conversion cannot invoke application hooks. */
function primitiveBound(node: Expression, resolve: Resolve): Bound | undefined {
  const value = writtenOf(node, resolve);
  const constant = constantValue(value, resolve);
  if (constant !== undefined) {
    return { value: constant };
  }
  if (value.kind === SyntaxKind.NullKeyword) {
    return { value: null };
  }
  if (value.kind === SyntaxKind.FalseKeyword || value.kind === SyntaxKind.TrueKeyword) {
    return { value: value.kind === SyntaxKind.TrueKeyword };
  }
  return isVoidExpression(value) || globalCalleePath(value, resolve)?.join('.') === 'undefined'
    ? { value: undefined }
    : undefined;
}

/** Earlier application work may replace an intrinsic; plain lock-chain declarations are quiet. */
function priorStatementEffect(node: Node, resolve: Resolve): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && statementEffect(statement, resolve),
      )
    ) {
      return true;
    }
    if (isAnswering(parent) || isConstructorDeclaration(parent)) {
      break;
    }
  }
  return false;
}

/** Known locking calls create no application callbacks; other earlier statements retain their effects. */
function statementEffect(node: Statement, resolve: Resolve): boolean {
  if (!isVariableStatement(node)) {
    return callbackCreationEffect(node);
  }
  return node.declarationList.declarations.some((declaration) => {
    const value = declaration.initializer;
    if (value === undefined) {
      return false;
    }
    return (
      (!isIdentifier(declaration.name) || arraySnapshot(value, resolve) === undefined) &&
      callbackCreationEffect(declaration)
    );
  });
}
