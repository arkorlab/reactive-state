import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBigIntLiteral,
  isBlock,
  isCallExpression,
  isClassExpression,
  isComputedPropertyName,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isPrefixUnaryExpression,
  isRegularExpressionLiteral,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, isAnswering, parametersOf } from './answers.ts';
import { calledMember, unwrapped } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { literalKey } from './exported-values.ts';
import { globalPath } from './global-answers.ts';
import { metadataInitializer } from './input-callees.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { callbackResultThrows } from './throw-callback-results.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** What a `Set`'s composition and relation methods throw of a statically written set-like argument. */

/** The methods that make another `Set`, whose answer is a `Set` again. */
const COMBINING: ReadonlySet<string> = new Set([
  'difference',
  'intersection',
  'symmetricDifference',
  'union',
]);

/** The methods that compare two sets, whose argument is set-like too. */
const RELATING: ReadonlySet<string> = new Set(['isDisjointFrom', 'isSubsetOf', 'isSupersetOf']);

/** The language's functions that answer a bigint. */
const BIGINT_MAKERS: ReadonlySet<string> = new Set(['BigInt', 'BigInt.asIntN', 'BigInt.asUintN']);

/** A field an object writes: a method, or the expression of a data property. */
type Field = MethodDeclaration | Expression;

/**
 * Whether `callee`, a composition or relation method of a `Set` the code makes, throws of what it
 * is given first: no object, or an object written with no usable `size`, `has` or `keys`. What the
 * code does not write, a getter or a spread may supply among it, remains for the runtime.
 */
export function setArgumentThrows(
  callee: Expression,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  const member = calledMember(callee);
  const [first] = given;
  if (
    member === undefined ||
    (!COMBINING.has(member.name) && !RELATING.has(member.name)) ||
    !isMadeSet(member.of, resolve) ||
    (first !== undefined && isSpreadElement(first))
  ) {
    return false;
  }
  if (first === undefined) {
    return true;
  }
  const value = writtenOf(first, resolve);
  if (
    primitiveOf(value, resolve) !== undefined ||
    isSymbolWritten(value, resolve) ||
    isBigIntWritten(value, resolve)
  ) {
    return true;
  }
  if (isArrayLiteralExpression(value)) {
    return true;
  }
  const fields = isObjectLiteralExpression(value) ? fieldsOf(value, resolve) : undefined;
  return (
    fields !== undefined &&
    (sizeThrows(fields.get('size'), resolve) ||
      notCallable(fields.get('has'), resolve) ||
      notCallable(fields.get('keys'), resolve))
  );
}

/** A source keys method that the selected native Set branch necessarily calls. */
export function setKeysFunction(node: Node, resolve: Resolve | undefined): Answering | undefined {
  if (
    !isCallExpression(node) ||
    earlierExpressionEffect(node) ||
    priorEffect(node) ||
    node.arguments.some((each) => callbackCreationEffect(each))
  ) {
    return undefined;
  }
  const member = calledMember(unwrapped(node.expression));
  const [first] = node.arguments;
  if (member === undefined || first === undefined) {
    return undefined;
  }
  const follow: Resolve = (name) => {
    const held = resolve?.(name) ?? metadataInitializer(name);
    return held === undefined || calleeUncertain(held, node) ? undefined : held;
  };
  const receiver = writtenOf(member.of, follow);
  const source = writtenOf(first, follow);
  if (
    calleeUncertain(receiver, node) ||
    calleeUncertain(source, node) ||
    !isObjectLiteralExpression(source) ||
    callbackCreationEffect(source)
  ) {
    return undefined;
  }
  const fields = fieldsOf(source, follow);
  if (fields === undefined || !callsKeys(member.name, setSize(receiver, follow), fields, follow)) {
    return undefined;
  }
  const field = fields.get('keys');
  const fn = field === undefined || isMethodDeclaration(field) ? field : writtenOf(field, follow);
  return fn !== undefined &&
    isAnswering(fn) &&
    parametersOf(fn).every(
      (parameter) => isIdentifier(parameter.name) && parameter.initializer === undefined,
    )
    ? fn
    : undefined;
}

/** A called keys method whose simple result is known not to be an iterator object. */
export function setKeysResultThrows(node: Node, resolve: Resolve | undefined): boolean {
  const fn = setKeysFunction(node, resolve);
  return fn !== undefined && callbackResultThrows(fn, 'object', undefined);
}

/** Native Set algorithms choose between reading their own entries and the other set's keys. */
function callsKeys(
  method: string,
  size: number | undefined,
  fields: ReadonlyMap<string, Field>,
  resolve: Resolve,
): boolean {
  const field = fields.get('size');
  if (size === undefined || field === undefined || isMethodDeclaration(field)) {
    return false;
  }
  const raw = constantValue(writtenOf(field, resolve), resolve);
  if (raw === undefined) {
    return false;
  }
  const other = Math.trunc(Number(raw));
  if (Number.isNaN(other) || other < 0) {
    return false;
  }
  if (method === 'union' || method === 'symmetricDifference') {
    return true;
  }
  if (method === 'isSupersetOf') {
    return size >= other;
  }
  return ['difference', 'intersection', 'isDisjointFrom'].includes(method) && size > other;
}

/** The cardinality of a native Set constructed from quiet, fully written entries. */
function setSize(value: Expression, resolve: Resolve): number | undefined {
  if (
    !isNewExpression(value) ||
    globalPath(unwrapped(value.expression))?.join('.') !== 'Set' ||
    value.arguments?.some((each) => callbackCreationEffect(each)) === true
  ) {
    return undefined;
  }
  const [first] = value.arguments ?? [];
  if (first === undefined) {
    return 0;
  }
  const source = writtenOf(first, resolve);
  if (!isArrayLiteralExpression(source) || source.elements.some((each) => isSpreadElement(each))) {
    return undefined;
  }
  const entries = source.elements.map((each) => constantValue(each, resolve));
  return entries.includes(undefined) ? undefined : new Set(entries).size;
}

/** Earlier application work may replace either the native method or a selected source function. */
function priorEffect(node: Node): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && callbackCreationEffect(statement),
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Whether `node` is a `Set` made there, through constants, `add`, and composition methods. */
function isMadeSet(node: Expression, resolve: Resolve | undefined): boolean {
  let value = writtenOf(node, resolve);
  const followed = new Set<Expression>();
  while (isCallExpression(value)) {
    if (followed.has(value)) {
      return false;
    }
    followed.add(value);
    const member = calledMember(unwrapped(value.expression));
    if (member === undefined || (!COMBINING.has(member.name) && member.name !== 'add')) {
      return false;
    }
    value = writtenOf(member.of, resolve);
  }
  return isNewExpression(value) && globalPath(unwrapped(value.expression))?.join('.') === 'Set';
}

/**
 * The fields an object writes whole, with later properties replacing earlier ones; none of a
 * spread, a key the compile cannot read, an accessor, or a prototype of the application's.
 */
function fieldsOf(
  object: ObjectLiteralExpression,
  resolve: Resolve | undefined,
): ReadonlyMap<string, Field> | undefined {
  const fields = new Map<string, Field>();
  for (const property of object.properties) {
    if (
      isSpreadAssignment(property) ||
      isGetAccessorDeclaration(property) ||
      isSetAccessorDeclaration(property)
    ) {
      return undefined;
    }
    const { name } = property;
    const key = isComputedPropertyName(name)
      ? constantValue(name.expression, resolve)
      : literalKey(name);
    const named = isIdentifier(name) ? name.text : key;
    if (named === undefined || named === '__proto__') {
      return undefined;
    }
    if (isMethodDeclaration(property)) {
      fields.set(String(named), property);
    } else if (isPropertyAssignment(property)) {
      fields.set(String(named), property.initializer);
    } else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) {
      fields.set(String(named), property.name);
    }
  }
  return fields;
}

/** Whether a size written there becomes `NaN`, a negative integer, or throws when made a number. */
function sizeThrows(field: Field | undefined, resolve: Resolve | undefined): boolean {
  if (field === undefined || isMethodDeclaration(field)) {
    return true;
  }
  const value = writtenOf(field, resolve);
  if (isBigIntWritten(value, resolve) || isSymbolWritten(value, resolve)) {
    return true;
  }
  if (primitiveOf(value, resolve) === 'nothing') {
    return value.kind !== SyntaxKind.NullKeyword;
  }
  const sized = constantValue(value, resolve);
  return sized !== undefined && (Number.isNaN(Number(sized)) || Math.trunc(Number(sized)) < 0);
}

/** Whether the code writes a bigint, through constants, a minus sign, or the language's makers. */
function isBigIntWritten(node: Expression, resolve: Resolve | undefined): boolean {
  let value = writtenOf(node, resolve);
  const followed = new Set<Expression>();
  while (isPrefixUnaryExpression(value) && value.operator === SyntaxKind.MinusToken) {
    if (followed.has(value)) {
      return false;
    }
    followed.add(value);
    value = writtenOf(value.operand, resolve);
  }
  if (isBigIntLiteral(value)) {
    return true;
  }
  const path = isCallExpression(value)
    ? globalPath(unwrapped(value.expression))?.join('.')
    : undefined;
  return BIGINT_MAKERS.has(path ?? '');
}

/** Whether a field is absent or statically no callable function; none told of an unknown value. */
function notCallable(field: Field | undefined, resolve: Resolve | undefined): boolean {
  if (field === undefined) {
    return true;
  }
  if (isMethodDeclaration(field)) {
    return false;
  }
  const value = writtenOf(field, resolve);
  if (isArrowFunction(value) || isFunctionExpression(value) || isClassExpression(value)) {
    return false;
  }
  return (
    primitiveOf(value, resolve) !== undefined ||
    isSymbolWritten(value, resolve) ||
    isArrayLiteralExpression(value) ||
    isObjectLiteralExpression(value) ||
    isRegularExpressionLiteral(value)
  );
}
