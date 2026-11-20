import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBlock,
  isComputedPropertyName,
  isConstructorDeclaration,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSourceFile,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { calledMember } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { globalPath } from './global-answers.ts';
import { metadataInitializer } from './input-callees.ts';
import { constantNumber, constantValue, type Resolve } from './numbers.ts';
import { primitiveOf, typedOf, writtenOf } from './throw-shapes.ts';

/** The method and arguments a known prototype invocation borrows, as the ordinary call checks read them. */

const PROTOTYPE_PATH = 3;

export interface BorrowedCall {
  readonly brand: string;
  readonly call: CallExpression;
  readonly ordinary: boolean;
}

/** A borrowed prototype method read as a call on its explicit receiver; none of an unread argument list. */
export function borrowedCall(
  call: CallExpression,
  resolve: Resolve | undefined,
): BorrowedCall | undefined {
  const invoked = invokedMethod(call, resolve);
  if (invoked === undefined) {
    return undefined;
  }
  const { method, self, given } = invoked;
  const path = globalPath(method);
  const [brand, prototype] = path ?? [];
  if (
    brand === undefined ||
    prototype !== 'prototype' ||
    path?.length !== PROTOTYPE_PATH ||
    !(isPropertyAccessExpression(method) || isElementAccessExpression(method))
  ) {
    return undefined;
  }
  const expression = replaced(method, { expression: self });
  const args = Object.assign([...given], {
    end: call.arguments.end,
    pos: call.arguments.pos,
    transformFlags: call.arguments.transformFlags,
  });
  return {
    brand,
    call: replaced(call, { arguments: args, expression }),
    ordinary: checksOrdinary(brand, path.at(-1) ?? ''),
  };
}

/** Whether the borrowed method has the argument semantics of the receiver's method of that name. */
function checksOrdinary(brand: string, method: string): boolean {
  if (method === 'toString') {
    return brand === 'Number';
  }
  if (method === 'toLocaleString') {
    return brand === 'Number' || brand === 'Date' || brand.endsWith('Array');
  }
  return brand !== 'Array' || method !== 'with';
}

/** The target, receiver and arguments of call or apply, where all argument places are known. */
function invokedMethod(
  call: CallExpression,
  resolve: Resolve | undefined,
):
  | {
      readonly method: Expression;
      readonly self: Expression;
      readonly given: readonly Expression[];
    }
  | undefined {
  if (call.arguments.some((each) => isSpreadElement(each))) {
    return undefined;
  }
  const callee = writtenOf(call.expression, resolve);
  const member = calledMember(callee);
  const reflected = globalPath(callee)?.join('.') === 'Reflect.apply';
  const borrowed = reflected ? call.arguments[0] : member?.of;
  const self = call.arguments[reflected ? 1 : 0];
  if (
    borrowed === undefined ||
    self === undefined ||
    (!reflected && member?.name !== 'call' && member?.name !== 'apply')
  ) {
    return undefined;
  }
  const list = call.arguments[reflected ? 2 : 1];
  const given =
    reflected || member?.name === 'apply'
      ? appliedArguments(list, resolve)
      : call.arguments.slice(1);
  if (given === undefined) {
    return undefined;
  }
  return { given, method: writtenOf(borrowed, resolve), self };
}

/** Whether a borrowed array operation throws of a known empty receiver or an index outside its length. */
export function borrowedResultThrows(
  borrowed: BorrowedCall,
  resolve: Resolve | undefined,
): boolean {
  const { call, brand } = borrowed;
  const member = calledMember(call.expression);
  if (member === undefined) {
    return false;
  }
  const receiver = writtenOf(member.of, resolve);
  if ((member.name === 'reduce' || member.name === 'reduceRight') && call.arguments.length < 2) {
    if (isArrayLiteralExpression(receiver)) {
      return receiver.elements.every((each) => isOmittedExpression(each));
    }
    return (
      typedOf(receiver, resolve)?.length === 0 ||
      (brand === 'Array' && emptyArrayLike(receiver, call, resolve))
    );
  }
  if (brand !== 'Array' || member.name !== 'with') {
    return false;
  }
  const length = arrayLength(receiver, call, resolve);
  if (length === undefined) {
    return false;
  }
  const [index] = call.arguments;
  const value = index === undefined ? 0 : constantNumber(index, resolve);
  if (value === undefined) {
    return false;
  }
  const whole = Math.trunc(value) || 0;
  return whole < -length || whole >= length;
}

/** A generic reduction's unchanged text or quiet own length can establish that it visits no entry. */
function emptyArrayLike(
  receiver: Expression,
  call: CallExpression,
  resolve: Resolve | undefined,
): boolean {
  const length = genericLength(receiver, call, resolve);
  return length !== undefined && length === 0;
}

/** Native generic methods read text length or an unchanged own data length without user conversion. */
function genericLength(
  receiver: Expression,
  call: CallExpression,
  resolve: Resolve | undefined,
): number | undefined {
  const follow: Resolve = (name) => resolve?.(name) ?? metadataInitializer(name);
  const value = writtenOf(receiver, follow);
  if (
    calleeUncertain(value, call) ||
    earlierExpressionEffect(call) ||
    priorEffect(call) ||
    call.arguments.some((argument) => callbackCreationEffect(argument))
  ) {
    return undefined;
  }
  const text = constantValue(value, follow);
  if (typeof text === 'string') {
    return text.length;
  }
  return arrayLikeLength(value, follow);
}

/** A quiet literal object's final own length is converted with native ToLength truncation and bounds. */
function arrayLikeLength(receiver: Expression, resolve: Resolve | undefined): number | undefined {
  if (!isObjectLiteralExpression(receiver)) {
    return undefined;
  }
  let length: Expression | undefined;
  for (const property of receiver.properties) {
    if (
      !isPropertyAssignment(property) ||
      isComputedPropertyName(property.name) ||
      callbackCreationEffect(property.initializer)
    ) {
      return undefined;
    }
    const key = isIdentifier(property.name) ? property.name.text : constantValue(property.name);
    if (key === '__proto__') {
      return undefined;
    }
    if (key === 'length') {
      length = property.initializer;
    }
  }
  const size = length === undefined ? undefined : constantValue(length, resolve);
  const whole = size === undefined ? undefined : Math.trunc(Number(size)) || 0;
  return whole === undefined ? undefined : Math.min(Math.max(whole, 0), Number.MAX_SAFE_INTEGER);
}

/** Prior application evaluation can replace the borrowed native function before it is captured. */
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
    if (isAnswering(parent) || isConstructorDeclaration(parent)) {
      break;
    }
  }
  return false;
}

/** A literal, typed or quiet generic receiver's known length, without counting a spread as an element. */
function arrayLength(
  receiver: Expression,
  call: CallExpression,
  resolve: Resolve | undefined,
): number | undefined {
  if (isArrayLiteralExpression(receiver)) {
    return receiver.elements.some((each) => isSpreadElement(each))
      ? undefined
      : receiver.elements.length;
  }
  return typedOf(receiver, resolve)?.length ?? genericLength(receiver, call, resolve);
}

/** The elements a known apply list passes, including constant arrays and literal spreads. */
function appliedArguments(
  node: Expression | undefined,
  resolve: Resolve | undefined,
  seen: ReadonlySet<Expression> = new Set(),
): readonly Expression[] | undefined {
  if (node === undefined) {
    return [];
  }
  const value = writtenOf(node, resolve);
  if (primitiveOf(value, resolve) === 'nothing') {
    return [];
  }
  if (!isArrayLiteralExpression(value) || seen.has(value)) {
    return undefined;
  }
  const followed = new Set([...seen, value]);
  const found: Expression[] = [];
  for (const each of value.elements) {
    const values = isSpreadElement(each)
      ? appliedArguments(each.expression, resolve, followed)
      : [each];
    if (values === undefined) {
      return undefined;
    }
    found.push(...values);
  }
  return found;
}

/** A check's view of an existing node with selected fields replaced, keeping its syntax methods. */
function replaced<T extends Node>(node: T, fields: Partial<T>): T {
  return new Proxy(node, {
    get: (target, key): unknown => Reflect.get(Object.hasOwn(fields, key) ? fields : target, key),
  });
}
