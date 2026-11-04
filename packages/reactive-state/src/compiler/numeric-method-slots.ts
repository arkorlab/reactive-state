import {
  type Expression,
  isArrayLiteralExpression,
  isNewExpression,
  isOmittedExpression,
  isSpreadElement,
  type NewExpression,
} from 'typescript/ast';

import { calledMember } from './bounded.ts';
import { callbackCreationEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { globalCalleePath } from './throw-callees.ts';
import { isTypedKind, primitiveOf, writtenOf } from './throw-shapes.ts';

export interface NumericConversion {
  readonly value: Expression;
  readonly kind: 'number' | 'bigint';
}

export interface MethodConversions {
  readonly path: string;
  readonly converted: readonly NumericConversion[];
}

interface Receiver {
  readonly kind: string;
  readonly length?: number | undefined;
}

const INDEX = { fourth: 3 } as const;
const SLOTS = {
  first: [0],
  second: [1],
  two: [0, 1],
  three: [0, 1, 2],
  four: [0, 1, 2, INDEX.fourth],
  lastTwo: [1, 2],
} as const;

const TEXT: ReadonlyMap<string, readonly number[]> = new Map<string, readonly number[]>([
  ['at', SLOTS.first],
  ['charAt', SLOTS.first],
  ['charCodeAt', SLOTS.first],
  ['codePointAt', SLOTS.first],
  ['endsWith', SLOTS.second],
  ['includes', SLOTS.second],
  ['indexOf', SLOTS.second],
  ['lastIndexOf', SLOTS.second],
  ['padEnd', SLOTS.first],
  ['padStart', SLOTS.first],
  ['repeat', SLOTS.first],
  ['slice', SLOTS.two],
  ['startsWith', SLOTS.second],
  ['substr', SLOTS.two],
  ['substring', SLOTS.two],
]);

const ARRAYS: ReadonlyMap<string, readonly number[]> = new Map<string, readonly number[]>([
  ['at', SLOTS.first],
  ['copyWithin', SLOTS.three],
  ['fill', SLOTS.lastTwo],
  ['flat', SLOTS.first],
  ['includes', SLOTS.second],
  ['indexOf', SLOTS.second],
  ['lastIndexOf', SLOTS.second],
  ['slice', SLOTS.two],
  ['splice', SLOTS.two],
  ['toSpliced', SLOTS.two],
  ['with', SLOTS.first],
]);

const DATES: ReadonlyMap<string, readonly number[]> = new Map<string, readonly number[]>([
  ['setDate', SLOTS.first],
  ['setFullYear', SLOTS.three],
  ['setHours', SLOTS.four],
  ['setMilliseconds', SLOTS.first],
  ['setMinutes', SLOTS.three],
  ['setMonth', SLOTS.two],
  ['setSeconds', SLOTS.two],
  ['setTime', SLOTS.first],
  ['setUTCDate', SLOTS.first],
  ['setUTCFullYear', SLOTS.three],
  ['setUTCHours', SLOTS.four],
  ['setUTCMilliseconds', SLOTS.first],
  ['setUTCMinutes', SLOTS.three],
  ['setUTCMonth', SLOTS.two],
  ['setUTCSeconds', SLOTS.two],
  ['setYear', SLOTS.first],
]);

const NUMBERS: ReadonlySet<string> = new Set([
  'toExponential',
  'toFixed',
  'toPrecision',
  'toString',
]);
const SEARCHES: ReadonlySet<string> = new Set(['includes', 'indexOf', 'lastIndexOf']);
const DATA: ReadonlySet<string> = new Set([
  'BigInt64',
  'BigUint64',
  'Float16',
  'Float32',
  'Float64',
  'Int8',
  'Int16',
  'Int32',
  'Uint8',
  'Uint16',
  'Uint32',
]);

/** The actual conversion slots of a source-proven native method, with the borrowed receiver kept. */
export function nativeMethodConversions(
  callee: Expression,
  given: readonly Expression[],
  borrowed: Expression | undefined,
  resolve: Resolve,
): MethodConversions | undefined {
  const member = calledMember(writtenOf(callee, resolve));
  if (member === undefined) {
    return undefined;
  }
  const path = globalCalleePath(callee, resolve) ?? [];
  const prototype = path.length === INDEX.fourth && path[1] === 'prototype';
  const receiver = borrowed ?? member.of;
  const known = receiverOf(receiver, resolve);
  const target = borrowed === undefined ? known : receiverOf(member.of, resolve);
  const [writtenKind] = path;
  const kind = prototype ? writtenKind : target?.kind;
  if (kind === undefined || calleeUncertain(writtenOf(receiver, resolve), callee)) {
    return undefined;
  }
  const slots = slotsOf(kind, member.name, known?.length);
  if (slots === undefined) {
    return undefined;
  }
  const converted = slots.flatMap((index): NumericConversion[] => {
    const value = given[index];
    return value === undefined ? [] : [{ kind: 'number', value }];
  });
  addElementConversion(converted, kind, member.name, given);
  return { converted, path: `${kind}.prototype.${member.name}` };
}

/** Typed values have element conversion slots in addition to their ordinary numeric indices. */
function addElementConversion(
  converted: NumericConversion[],
  kind: string,
  method: string,
  given: readonly Expression[],
): void {
  if (kind === 'DataView' && method.startsWith('setBig')) {
    const value = given[1];
    if (value !== undefined) {
      converted.push({ kind: 'bigint', value });
    }
    return;
  }
  if (!isTypedKind(kind) || (method !== 'fill' && method !== 'with')) {
    return;
  }
  const value = given[method === 'fill' ? 0 : 1];
  if (value !== undefined) {
    converted.push({
      kind: kind === 'BigInt64Array' || kind === 'BigUint64Array' ? 'bigint' : 'number',
      value,
    });
  }
}

/** Empty searches return before coercing fromIndex; data endian flags never enter this list. */
function slotsOf(
  kind: string,
  method: string,
  length: number | undefined,
): readonly number[] | undefined {
  if (kind === 'String') {
    return TEXT.get(method);
  }
  if (kind === 'Date') {
    return DATES.get(method);
  }
  if ((kind === 'Number' && NUMBERS.has(method)) || (kind === 'BigInt' && method === 'toString')) {
    return SLOTS.first;
  }
  if (kind === 'DataView') {
    return dataSlots(method);
  }
  return collectionSlots(kind, method, length);
}

/** Collection counts are distinct from ordinary stored values and typed element conversion. */
function collectionSlots(
  kind: string,
  method: string,
  length: number | undefined,
): readonly number[] | undefined {
  if (kind === 'ArrayBuffer' || kind === 'SharedArrayBuffer') {
    if (method === 'slice') {
      return SLOTS.two;
    }
    return ['grow', 'resize', 'transfer', 'transferToFixedLength'].includes(method)
      ? SLOTS.first
      : undefined;
  }
  if (kind !== 'Array' && !isTypedKind(kind)) {
    return undefined;
  }
  if (SEARCHES.has(method) && (length === undefined || length <= 0)) {
    return [];
  }
  if (isTypedKind(kind) && (method === 'set' || method === 'subarray')) {
    return method === 'set' ? SLOTS.second : SLOTS.two;
  }
  return ARRAYS.get(method);
}

/** A DataView converts its offset and numeric value, but its endian flag only to Boolean. */
function dataSlots(method: string): readonly number[] | undefined {
  const action = method.slice(0, INDEX.fourth);
  const value = method.slice(INDEX.fourth);
  if (!DATA.has(value) || (action !== 'get' && action !== 'set')) {
    return undefined;
  }
  return action === 'get' || value.startsWith('Big') ? SLOTS.first : SLOTS.two;
}

/** Literal receivers and quiet native constructions retain their original built-in kind. */
function receiverOf(node: Expression, resolve: Resolve): Receiver | undefined {
  const value = writtenOf(node, resolve);
  if (isArrayLiteralExpression(value) && !callbackCreationEffect(value)) {
    return { kind: 'Array', length: value.elements.length };
  }
  const kind = scalarKind(value, resolve);
  if (kind !== undefined) {
    return { kind };
  }
  return isNewExpression(value) ? constructedReceiver(value, resolve) : undefined;
}

/** A primitive source value is known without coercing an object or executing an application call. */
function scalarKind(value: Expression, resolve: Resolve): string | undefined {
  if (callbackCreationEffect(value)) {
    return undefined;
  }
  const primitive = constantValue(value, resolve);
  if (typeof primitive === 'string') {
    return 'String';
  }
  if (typeof primitive === 'number') {
    return 'Number';
  }
  return isBigIntWritten(value, resolve) ? 'BigInt' : undefined;
}

/** Only native constructions with primitive inputs retain their statically known method brands. */
function constructedReceiver(value: NewExpression, resolve: Resolve): Receiver | undefined {
  const [kind = ''] = globalCalleePath(value.expression, resolve) ?? [];
  const given = value.arguments ?? [];
  if (kind === 'DataView') {
    return quietView(given, resolve) ? { kind } : undefined;
  }
  const [first] = given;
  const input = first === undefined ? undefined : writtenOf(first, resolve);
  if (input !== undefined && isArrayLiteralExpression(input) && isTypedKind(kind)) {
    return input.elements.every((each) => quietPrimitive(each, resolve))
      ? { kind, length: input.elements.length }
      : undefined;
  }
  if (given.some((each) => !quietPrimitive(each, resolve))) {
    return undefined;
  }
  const length = input === undefined ? 0 : constantValue(input, resolve);
  return {
    kind,
    ...(typeof length === 'number' && length >= 0 && Number.isSafeInteger(length) && { length }),
  };
}

/** Only native buffers and primitive view offsets are proven quiet before the method is selected. */
function quietView(given: readonly Expression[], resolve: Resolve): boolean {
  const [first, ...rest] = given;
  const buffer = first === undefined ? undefined : writtenOf(first, resolve);
  if (buffer === undefined || !isNewExpression(buffer)) {
    return false;
  }
  const path = globalCalleePath(buffer.expression, resolve)?.join('.');
  return (
    (path === 'ArrayBuffer' || path === 'SharedArrayBuffer') &&
    (buffer.arguments ?? []).every((each) => quietPrimitive(each, resolve)) &&
    rest.every((each) => quietPrimitive(each, resolve))
  );
}

/** Primitive evaluation cannot run application conversion code while constructing the receiver. */
function quietPrimitive(node: Expression, resolve: Resolve): boolean {
  const value = writtenOf(node, resolve);
  return (
    isOmittedExpression(value) ||
    (!isSpreadElement(value) &&
      !callbackCreationEffect(value) &&
      (primitiveOf(value, resolve) !== undefined || isBigIntWritten(value, resolve)))
  );
}
