import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isClassExpression,
  isComputedPropertyName,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isVoidExpression,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf } from './bounded.ts';
import { literalKey } from './exported-values.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';

/** The scalar values read from a descriptor without running application conversions. */
interface Scalar {
  readonly value: boolean | null | number | string | undefined;
}

/** A written limit's range error, numeric value, or deferred conversion. */
interface Limit {
  readonly invalid: boolean;
  readonly value?: number;
}

/** The unsigned-long range used by memory and table limits, and the pages of a 32-bit memory. */
const LIMITS = { index: 4_294_967_296, memoryPages: 65_536 } as const;

/** The construction whose element conversion precedes its numeric limits. */
const TABLE = 'WebAssembly.Table';

/**
 * Whether a written WebAssembly construction necessarily throws of its descriptor, bytes or
 * argument kinds. No memory or table entries are allocated, and no instance or imports are run.
 */
export function wasmMadeThrows(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  if (!path.startsWith('WebAssembly.') || given.some((each) => isSpreadElement(each))) {
    return false;
  }
  const [first, second] = given;
  if (path === 'WebAssembly.Module') {
    if (
      !extrasReadAlone(given, resolve) ||
      (second !== undefined && !isUndefined(second, resolve))
    ) {
      return false;
    }
    return moduleThrows(first, resolve);
  }
  if (path === 'WebAssembly.Instance') {
    return (
      notObject(first, resolve) ||
      (first !== undefined && isPlainObject(writtenOf(first, resolve))) ||
      (second !== undefined && notObject(second, resolve) && !isUndefined(second, resolve))
    );
  }
  if (path !== 'WebAssembly.Memory' && path !== TABLE) {
    return false;
  }
  if (!extrasReadAlone(given, resolve)) {
    return false;
  }
  if (notObject(first, resolve)) {
    return true;
  }
  const descriptor = first === undefined ? undefined : descriptorOf(first, resolve);
  return descriptor !== undefined && limitsThrow(path, descriptor, resolve);
}

/** A descriptor's ordinary final entries; unknown keys, prototypes, spreads and accessors defer it. */
function descriptorOf(
  node: Expression,
  resolve: Resolve | undefined,
): ReadonlyMap<string, Expression> | undefined {
  const value = writtenOf(node, resolve);
  if (!isObjectLiteralExpression(value)) {
    return undefined;
  }
  const entries = new Map<string, Expression>();
  for (const property of value.properties) {
    if (!(isPropertyAssignment(property) || isShorthandPropertyAssignment(property))) {
      return undefined;
    }
    let key: number | string | undefined = literalKey(property.name);
    if (isIdentifier(property.name)) {
      key = property.name.text;
    } else if (isComputedPropertyName(property.name)) {
      key = constantValue(property.name.expression, resolve);
    }
    if (key === undefined || key === '__proto__') {
      return undefined;
    }
    if (isPropertyAssignment(property)) {
      entries.set(String(key), property.initializer);
    } else if (isIdentifier(property.name)) {
      entries.set(String(key), property.name);
    } else {
      return undefined;
    }
  }
  return entries;
}

/** Whether a plain memory or table descriptor has impossible required values or limits. */
function limitsThrow(
  path: string,
  descriptor: ReadonlyMap<string, Expression>,
  resolve: Resolve | undefined,
): boolean {
  const address = descriptor.get('address');
  if (address !== undefined && constantValue(address, resolve) !== 'i32') {
    return false;
  }
  if (path === TABLE) {
    const element = tableElementThrows(descriptor.get('element'), resolve);
    if (element !== false) {
      return element === true;
    }
  }
  const initial = limitOf(descriptor.get('initial'), resolve);
  if (initial.invalid || initial.value === undefined) {
    return initial.invalid;
  }
  const maximumNode = descriptor.get('maximum');
  const maximum: Limit =
    maximumNode === undefined ? { invalid: false } : limitOf(maximumNode, resolve);
  const from = initial.value;
  const to = maximum.value;
  if (
    (maximumNode !== undefined && maximum.invalid && !isUndefined(maximumNode, resolve)) ||
    (to !== undefined && to < from)
  ) {
    return true;
  }
  if (path === TABLE) {
    return false;
  }
  return memoryLimitsThrow(descriptor, { initial: from, maximum: to }, resolve);
}

/** Whether a memory exceeds its address space or omits the maximum required for sharing. */
function memoryLimitsThrow(
  descriptor: ReadonlyMap<string, Expression>,
  { initial, maximum }: { readonly initial: number; readonly maximum: number | undefined },
  resolve: Resolve | undefined,
): boolean {
  const maximumNode = descriptor.get('maximum');
  const sharedNode = descriptor.get('shared');
  const shared = sharedNode === undefined ? undefined : scalarOf(sharedNode, resolve);
  return (
    initial > LIMITS.memoryPages ||
    (maximum !== undefined && maximum > LIMITS.memoryPages) ||
    (shared !== undefined &&
      Boolean(shared.value) &&
      (maximumNode === undefined || isUndefined(maximumNode, resolve)))
  );
}

/** An unsigned-long limit, invalid where written, or unknown until runtime. */
function limitOf(node: Expression | undefined, resolve: Resolve | undefined): Limit {
  if (node === undefined) {
    return { invalid: true };
  }
  const scalar = scalarOf(node, resolve);
  if (scalar === undefined) {
    return { invalid: false };
  }
  const value = Number(scalar.value);
  const invalid = !Number.isFinite(value) || value < 0 || value >= LIMITS.index;
  return { invalid, value: Math.trunc(value) };
}

/** Whether the engine rejects a known reference type, using an empty table alone. */
function tableElementThrows(
  node: Expression | undefined,
  resolve: Resolve | undefined,
): boolean | undefined {
  const scalar = node === undefined ? { value: undefined } : scalarOf(node, resolve);
  if (scalar === undefined) {
    return undefined;
  }
  try {
    Reflect.construct(WebAssembly.Table, [{ element: scalar.value, initial: 0 }]);
    return false;
  } catch {
    return true;
  }
}

/** Whether a module is given no buffer source, or written bytes that fail native validation. */
function moduleThrows(node: Expression | undefined, resolve: Resolve | undefined): boolean {
  if (notObject(node, resolve)) {
    return true;
  }
  if (node === undefined) {
    return true;
  }
  const value = writtenOf(node, resolve);
  if (isPlainObject(value)) {
    return true;
  }
  const bytes = bytesOf(value, resolve);
  return bytes !== undefined && !WebAssembly.validate(bytes);
}

/** Literal bytes of a Uint8Array, or an empty ArrayBuffer; never an input-sized allocation. */
function bytesOf(
  node: Expression,
  resolve: Resolve | undefined,
): Uint8Array<ArrayBuffer> | undefined {
  if (!isNewExpression(node) || node.arguments?.some((each) => isSpreadElement(each)) === true) {
    return undefined;
  }
  const path = globalCalleePath(node.expression, resolve)?.join('.');
  const [first] = node.arguments ?? [];
  if (path === 'ArrayBuffer') {
    return first !== undefined && constantValue(first, resolve) === 0
      ? new Uint8Array()
      : undefined;
  }
  if (path !== 'Uint8Array' || (node.arguments?.length ?? 0) > 1) {
    return undefined;
  }
  if (first === undefined) {
    return new Uint8Array();
  }
  const source = writtenOf(first, resolve);
  if (!isArrayLiteralExpression(source)) {
    return undefined;
  }
  const bytes: number[] = [];
  for (const element of source.elements) {
    const value = isOmittedExpression(element) ? 0 : constantValue(element, resolve);
    if (value === undefined || isSpreadElement(element)) {
      return undefined;
    }
    bytes.push(Number(value));
  }
  return new Uint8Array(bytes);
}

/** A scalar written directly or through unchanged constants; none of an application conversion. */
function scalarOf(node: Expression, resolve: Resolve | undefined): Scalar | undefined {
  const value = writtenOf(node, resolve);
  const constant = constantValue(value, resolve);
  if (constant !== undefined) {
    return { value: constant };
  }
  if (isUndefined(value, resolve)) {
    return { value: undefined };
  }
  if (value.kind === SyntaxKind.NullKeyword) {
    return { value: null };
  }
  if (value.kind === SyntaxKind.TrueKeyword || value.kind === SyntaxKind.FalseKeyword) {
    return { value: value.kind === SyntaxKind.TrueKeyword };
  }
  return undefined;
}

/** Whether a known value cannot be the object a constructor requires. */
function notObject(node: Expression | undefined, resolve: Resolve | undefined): boolean {
  return node === undefined || primitiveOf(writtenOf(node, resolve), resolve) !== undefined;
}

/** Whether a fresh plain value has no module or buffer-source brand. */
function isPlainObject(value: Expression): boolean {
  return (
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isClassExpression(value) ||
    isRegularExpressionLiteral(value)
  );
}

/** Whether an optional argument or dictionary entry is explicitly undefined. */
function isUndefined(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  return isVoidExpression(value) || (isIdentifier(value) && globalOf(value) === 'undefined');
}

/** Whether extra arguments cannot repair a descriptor or byte source before native code reads it. */
function extrasReadAlone(given: readonly Expression[], resolve: Resolve | undefined): boolean {
  return given.slice(1).every((each) => argumentReadsAlone(each, resolve));
}

/** Whether evaluating an argument reads a scalar alone, including the operand of void. */
function argumentReadsAlone(node: Expression, resolve: Resolve | undefined): boolean {
  let current = node;
  for (;;) {
    const value = writtenOf(current, resolve);
    if (!isVoidExpression(value)) {
      return scalarOf(value, resolve) !== undefined;
    }
    current = value.expression;
  }
}
