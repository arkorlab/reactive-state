import {
  type Expression,
  isArrayLiteralExpression,
  isBlock,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isSourceFile,
  isSpreadElement,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { calledMember, unwrapped } from './bounded.ts';
import { COMPRESSION_FORMATS, COMPRESSION_STREAMS } from './built-ins.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { literalKey } from './exported-values.ts';
import { globalPath } from './global-answers.ts';
import { metadataInitializer } from './input-callees.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { cloneValueThrows } from './throw-clone-values.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';
import { transferListThrows } from './throw-transfers.ts';

/**
 * What a construction of the platform's classes throws of what the code writes it is given whole,
 * tried as it is in the compile's own runtime: a label of no encoding, `new TextDecoder('bad')`; a
 * header of no name, `new Headers({ 'bad name': 'x' })`; a status past those of a response,
 * `new Response(null, { status: 99 })` — of classes that make a value alone, and reach out of none;
 * and what a method of one throws, so tried, `new Headers().append('bad name', 'x')`.
 */

/**
 * The counts of what the platform's functions read past two: a `File`'s parts, name and options, a
 * `TransformStream`'s three, `append`'s and `set`'s name, value and file name, `slice`'s start, end
 * and type.
 */
const READS = { three: 3 } as const;

/** A source-proven symbol's identity is irrelevant to native dictionary conversion. */
const WRITTEN_SYMBOL = Symbol('written platform value');

export { platformOptionsThrow } from './throw-platform-options.ts';

/**
 * How many of what they are given the platform's classes tried read (`TRIED_PLATFORM`), each of a
 * type no symbol converts to — text, a number, a dictionary, an object — past which they read none.
 */
const MADE_READS: ReadonlyMap<string, number> = new Map([
  ['AbortController', 0],
  ['Blob', 2],
  ['ByteLengthQueuingStrategy', 1],
  ['CompressionStream', 1],
  ['CountQueuingStrategy', 1],
  ['DecompressionStream', 1],
  ['DOMException', 2],
  ['Event', 2],
  ['EventTarget', 0],
  ['File', READS.three],
  ['FormData', 2],
  ['Headers', 1],
  ['ReadableStream', 2],
  ['Request', 2],
  ['Response', 2],
  ['TextDecoder', 2],
  ['TextDecoderStream', 2],
  ['TextEncoder', 0],
  ['TextEncoderStream', 0],
  ['TransformStream', READS.three],
  ['URL', 2],
  ['URLSearchParams', 1],
  ['WritableStream', 2],
]);

/** The platform's classes a construction of is tried (`madeThrows`), which make a value alone. */
const TRIED_PLATFORM: ReadonlySet<string> = new Set([
  'AbortController',
  'Blob',
  'ByteLengthQueuingStrategy',
  'CompressionStream',
  'CountQueuingStrategy',
  'DecompressionStream',
  'DOMException',
  'Event',
  'EventTarget',
  'File',
  'FormData',
  'Headers',
  'ReadableStream',
  'Request',
  'Response',
  'TextDecoder',
  'TextDecoderStream',
  'TextEncoder',
  'TextEncoderStream',
  'TransformStream',
  'URLSearchParams',
  'WritableStream',
]);

/**
 * The methods of the platform's classes tried on what a construction of them makes
 * (`platformMethodThrows`), by class: those that answer at once — never a promise, which a trial
 * would leave rejected — and reach out of none; each by how many of what it is given it reads of a
 * type no symbol converts to, as `MADE_READS` — `abort` none, of a reason of any value.
 */
const TRIED_METHODS: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map([
  ['AbortController', new Map([['abort', 0]])],
  ['Blob', new Map([['slice', READS.three]])],
  [
    'FormData',
    new Map([
      ['append', READS.three],
      ['delete', 1],
      ['get', 1],
      ['getAll', 1],
      ['has', 1],
      ['set', READS.three],
    ]),
  ],
  [
    'Headers',
    new Map([
      ['append', 2],
      ['delete', 1],
      ['get', 1],
      ['getSetCookie', 0],
      ['has', 1],
      ['set', 2],
    ]),
  ],
  ['TextDecoder', new Map([['decode', 2]])],
  ['TextEncoder', new Map([['encode', 1]])],
  [
    'URLSearchParams',
    new Map([
      ['append', 2],
      ['delete', 2],
      ['get', 1],
      ['getAll', 1],
      ['has', 2],
      ['set', 2],
      ['sort', 0],
      ['toString', 0],
    ]),
  ],
]);

/**
 * Whether a method of the platform's (`TRIED_METHODS`), called on what a construction the code
 * writes whole makes there, or a constant is declared of — `headers.append('bad name', 'x')` of
 * `const headers = new Headers()` — throws of what the code writes it is given whole, tried as it
 * is; none of what it does not write, nor of a construction that throws, which `platformMadeThrows`
 * tells.
 */
export function platformMethodThrows(
  callee: Expression,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  const member = calledMember(callee);
  const receiver = member === undefined ? undefined : writtenOf(member.of, resolve);
  const path =
    receiver !== undefined && isNewExpression(receiver)
      ? (globalPath(unwrapped(receiver.expression))?.join('.') ?? '')
      : '';
  const method = member?.name ?? '';
  const reads = TRIED_METHODS.get(path)?.get(method);
  // `new TextEncoder().encode(Symbol('x'))`: no symbol is text, nor any value it reads.
  if (reads !== undefined && given.slice(0, reads).some((each) => isSymbolWritten(each, resolve))) {
    return true;
  }
  const made: unknown = reads === undefined ? undefined : Reflect.get(globalThis, path);
  const madeOf =
    receiver !== undefined && isNewExpression(receiver)
      ? (receiver.arguments ?? []).map((each) => writtenValue(each, resolve))
      : [undefined];
  const values = given.map((each) => writtenValue(each, resolve));
  if (typeof made !== 'function' || madeOf.includes(undefined) || values.includes(undefined)) {
    return false;
  }
  let instance: unknown;
  try {
    instance = Reflect.construct(
      made,
      madeOf.map((each) => each?.value),
    );
  } catch {
    return false;
  }
  return calledThrows(
    instance,
    method,
    values.map((each) => each?.value),
  );
}

/** Whether `method` of `instance`, called with `values`, throws. */
function calledThrows(instance: unknown, method: string, values: readonly unknown[]): boolean {
  try {
    const called: unknown =
      typeof instance === 'object' && instance !== null ? Reflect.get(instance, method) : undefined;
    if (typeof called === 'function') {
      Reflect.apply(called, instance, values);
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Whether a construction of the platform's class `path` names (`TRIED_PLATFORM`) throws of what the
 * code writes it is given whole (`writtenValue`), tried as it is — and a compression stream of a
 * format an authority holds not (`COMPRESSION_FORMATS`), as it throws there; none of what it does
 * not write.
 */
export function platformMadeThrows(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  const reads = MADE_READS.get(path) ?? 0;
  // `new URLSearchParams(Symbol('x'))`: no symbol is text, nor any value it reads.
  if (
    (path !== 'URL' || quietSymbolTrial(given, resolve)) &&
    given.slice(0, reads).some((each) => isSymbolWritten(each, resolve))
  ) {
    return true;
  }
  const made: unknown = TRIED_PLATFORM.has(path) ? Reflect.get(globalThis, path) : undefined;
  const symbols = quietSymbolTrial(given, resolve);
  const values = given.map((each) => writtenValue(each, resolve, symbols));
  if (typeof made !== 'function' || values.includes(undefined)) {
    return false;
  }
  // `brotli`, which the compile's own runtime takes, and workerd's throws of.
  const [format] = values;
  if (
    COMPRESSION_STREAMS.has(path) &&
    typeof format?.value === 'string' &&
    !COMPRESSION_FORMATS.has(format.value)
  ) {
    return true;
  }
  try {
    Reflect.construct(
      made,
      values.map((each) => each?.value),
    );
    return false;
  } catch {
    return true;
  }
}

/** New symbol-bearing trials retain the original constructor's prior evaluation and alias guards. */
function quietSymbolTrial(given: readonly Expression[], resolve: Resolve | undefined): boolean {
  const call = given[0]?.parent;
  if (call === undefined || !isNewExpression(call) || earlierExpressionEffect(call)) {
    return false;
  }
  if (given.some((each) => calleeUncertain(writtenOf(each, resolve), call))) {
    return false;
  }
  for (let each: Node = call; !isSourceFile(each); each = each.parent) {
    if (
      isBlock(each.parent) &&
      each.parent.statements.some(
        (statement) => statement.end <= each.pos && callbackCreationEffect(statement),
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * What `node` is where the code writes it whole: nothing, `null`, a constant, or an array or an
 * object of such values written there — of no spread, hole, computed key or method; none told of
 * another.
 */
function writtenValue(
  node: Expression,
  resolve: Resolve | undefined,
  symbols = false,
): { readonly value: unknown } | undefined {
  const value = writtenOf(node, resolve);
  if (symbols && platformSymbol(value, resolve)) {
    return { value: WRITTEN_SYMBOL };
  }
  if (value.kind === SyntaxKind.NullKeyword) {
    return { value: null };
  }
  if (primitiveOf(value, resolve) === 'nothing') {
    return { value: undefined };
  }
  const constant = constantValue(value, resolve);
  if (constant !== undefined) {
    return { value: constant };
  }
  if (isObjectLiteralExpression(value)) {
    return writtenObject(value, resolve, symbols);
  }
  if (!isArrayLiteralExpression(value)) {
    return undefined;
  }
  const items: unknown[] = [];
  for (const element of value.elements) {
    const item =
      isSpreadElement(element) || isOmittedExpression(element)
        ? undefined
        : writtenValue(element, resolve, symbols);
    if (item === undefined) {
      return undefined;
    }
    items.push(item.value);
  }
  return { value: items };
}

/** A written symbol or a call through an unchanged source alias of its native maker. */
function platformSymbol(value: Expression, resolve: Resolve | undefined): boolean {
  if (isSymbolWritten(value, resolve)) {
    return true;
  }
  if (!isCallExpression(value)) {
    return false;
  }
  const follow: Resolve = (name) => {
    const held = resolve?.(name) ?? metadataInitializer(name);
    return held === undefined || calleeUncertain(held, value) ? undefined : held;
  };
  const path = globalCalleePath(value.expression, follow)?.join('.');
  return path === 'Symbol' || path === 'Symbol.for';
}

/** An object the code writes whole, of entries of names and of values written whole (`writtenValue`). */
function writtenObject(
  value: ObjectLiteralExpression,
  resolve: Resolve | undefined,
  symbols: boolean,
): { readonly value: unknown } | undefined {
  const entries: [string, unknown][] = [];
  for (const property of value.properties) {
    if (!isPropertyAssignment(property)) {
      return undefined;
    }
    const key = isIdentifier(property.name) ? property.name.text : literalKey(property.name);
    const written = writtenValue(property.initializer, resolve, symbols);
    if (key === undefined || written === undefined) {
      return undefined;
    }
    entries.push([key, written.value]);
  }
  return { value: Object.fromEntries(entries) };
}

/** What a function of the platform's throws of the shape of what it is given, where the code writes it. */
export const PLATFORM_SHAPED: ReadonlyMap<
  string,
  (given: readonly Expression[], resolve: Resolve | undefined) => boolean
> = new Map([
  [
    'structuredClone',
    (given, resolve) => cloneValueThrows(given, resolve) || transferListThrows(given, resolve),
  ],
]);
