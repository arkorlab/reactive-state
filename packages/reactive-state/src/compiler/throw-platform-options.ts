import {
  type Expression,
  type GetAccessorDeclaration,
  isArrayLiteralExpression,
  isBlock,
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { literalKey } from './exported-values.ts';
import { globalPath } from './global-answers.ts';
import { metadataInitializer } from './input-callees.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

interface Options {
  readonly at: number;
  readonly keys: readonly string[];
}

/** The dictionary keys read by platform constructors, at their options argument. */
const OPTIONS: ReadonlyMap<string, Options> = new Map([
  ['Blob', { at: 1, keys: ['endings', 'type'] }],
  ['Event', { at: 1, keys: ['bubbles', 'cancelable', 'composed'] }],
  ['File', { at: 2, keys: ['endings', 'type', 'lastModified'] }],
  [
    'Request',
    {
      at: 1,
      keys: [
        'body',
        'cache',
        'credentials',
        'duplex',
        'headers',
        'integrity',
        'keepalive',
        'method',
        'mode',
        'priority',
        'redirect',
        'referrer',
        'referrerPolicy',
        'signal',
        'window',
      ],
    },
  ],
  ['Response', { at: 1, keys: ['headers', 'status', 'statusText'] }],
]);

/** Decoder flags and stream dictionaries read before a constructor returns. */
const ADDITIONAL_OPTIONS: ReadonlyMap<string, readonly Options[]> = new Map([
  ['ByteLengthQueuingStrategy', [{ at: 0, keys: ['highWaterMark'] }]],
  ['CountQueuingStrategy', [{ at: 0, keys: ['highWaterMark'] }]],
  [
    'ReadableStream',
    [
      { at: 0, keys: ['cancel', 'pull', 'start', 'type'] },
      { at: 1, keys: ['highWaterMark', 'size'] },
    ],
  ],
  ['TextDecoder', [{ at: 1, keys: ['fatal', 'ignoreBOM'] }]],
  ['TextDecoderStream', [{ at: 1, keys: ['fatal', 'ignoreBOM'] }]],
  [
    'TransformStream',
    [
      { at: 0, keys: ['cancel', 'flush', 'readableType', 'start', 'transform', 'writableType'] },
      { at: 1, keys: ['highWaterMark', 'size'] },
      { at: 2, keys: ['highWaterMark', 'size'] },
    ],
  ],
  [
    'WritableStream',
    [
      { at: 0, keys: ['abort', 'close', 'start', 'type', 'write'] },
      { at: 1, keys: ['highWaterMark', 'size'] },
    ],
  ],
]);

/** Whether a constructor reads a sole dictionary getter whose invocation is known to throw. */
export function platformOptionsThrow(
  path: string,
  given: readonly Expression[],
  outer: Resolve | undefined,
  throwsGetter: (getter: GetAccessorDeclaration) => boolean,
): boolean {
  const options = OPTIONS.get(path);
  if (options !== undefined) {
    return optionThrows(options, given, outer, throwsGetter);
  }
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  return (ADDITIONAL_OPTIONS.get(path) ?? []).some((each) => {
    const argument = given[each.at];
    const value = argument === undefined ? undefined : writtenOf(argument, resolve);
    return (
      argument !== undefined &&
      value !== undefined &&
      isObjectLiteralExpression(value) &&
      quietOptions(argument, value) &&
      optionThrows(each, given, resolve, throwsGetter)
    );
  });
}

/** Other arguments and earlier work must preserve a dictionary and the native constructor. */
function optionThrows(
  options: Options,
  given: readonly Expression[],
  resolve: Resolve | undefined,
  throwsGetter: (getter: GetAccessorDeclaration) => boolean,
): boolean {
  const argument = given[options.at];
  if (
    argument === undefined ||
    given.some((each, index) => index !== options.at && !safeOptionInput(each, resolve))
  ) {
    return false;
  }
  const object = writtenOf(argument, resolve);
  if (!isObjectLiteralExpression(object)) {
    return false;
  }
  const getter = optionGetter(object, options.keys, resolve);
  return getter !== undefined && throwsGetter(getter);
}

/** New dictionary selections require unchanged constructors and quiet option creation. */
function quietOptions(argument: Expression, object: ObjectLiteralExpression): boolean {
  const call = constructionOf(argument);
  return (
    call !== undefined &&
    !callbackCreationEffect(object) &&
    !calleeUncertain(object, call) &&
    !earlierExpressionEffect(call) &&
    !earlierStatementEffect(call)
  );
}

/** The original construction containing an options argument. */
function constructionOf(node: Node): Expression | undefined {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    if (isNewExpression(each)) {
      return each;
    }
  }
  return undefined;
}

/** Earlier application work can replace a native constructor or a retained dictionary entry. */
function earlierStatementEffect(call: Expression): boolean {
  for (let each: Node = call; !isSourceFile(each); each = each.parent) {
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

/** A sole surviving consumed getter, where no other option can run code before it is read. */
function optionGetter(
  object: ObjectLiteralExpression,
  keys: readonly string[],
  resolve: Resolve | undefined,
): GetAccessorDeclaration | undefined {
  const properties = survivingOptions(object, keys, resolve);
  if (properties === undefined) {
    return undefined;
  }
  let getter: GetAccessorDeclaration | undefined;
  for (const property of properties) {
    if (isGetAccessorDeclaration(property)) {
      if (getter !== undefined) {
        return undefined;
      }
      getter = property;
    } else if (!safeOptionProperty(property, resolve)) {
      return undefined;
    }
  }
  return getter;
}

/** The final consumed properties, where no spread, unknown key or prototype can replace them. */
function survivingOptions(
  object: ObjectLiteralExpression,
  keys: readonly string[],
  resolve: Resolve | undefined,
): readonly ObjectLiteralElementLike[] | undefined {
  const seen = new Set<string>();
  const properties: ObjectLiteralElementLike[] = [];
  for (const property of object.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return undefined;
    }
    const key = optionKey(property.name, resolve);
    if (key === undefined || key === '__proto__') {
      return undefined;
    }
    if (
      key === null ||
      !keys.includes(key) ||
      seen.has(key) ||
      isSetAccessorDeclaration(property)
    ) {
      continue;
    }
    seen.add(key);
    properties.push(property);
  }
  return properties;
}

/** Whether a consumed data property cannot run code when the dictionary converts it. */
function safeOptionProperty(
  property: ObjectLiteralElementLike,
  resolve: Resolve | undefined,
): boolean {
  if (isPropertyAssignment(property)) {
    return safeOptionInput(property.initializer, resolve);
  }
  return (
    isShorthandPropertyAssignment(property) &&
    isIdentifier(property.name) &&
    safeOptionInput(property.name, resolve)
  );
}

/** A dictionary key written as text, a symbol ignored by dictionaries, or an unknown key. */
function optionKey(name: PropertyName, resolve: Resolve | undefined): string | null | undefined {
  if (isIdentifier(name)) {
    return name.text;
  }
  if (!isComputedPropertyName(name)) {
    return literalKey(name);
  }
  if (isSymbolWritten(name.expression, resolve)) {
    return null;
  }
  const key = constantValue(name.expression, resolve);
  return key === undefined ? undefined : String(key);
}

/** Whether evaluating and converting an argument cannot run application code. */
function safeOptionInput(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  if (isArrayLiteralExpression(value)) {
    return value.elements.every((each) => safeOptionScalar(each, resolve));
  }
  return safeOptionScalar(value, resolve);
}

/** A scalar whose evaluation and conversion cannot run application code. */
function safeOptionScalar(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  return (
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    (isIdentifier(value) && globalPath(value)?.join('.') === 'undefined') ||
    constantValue(value, resolve) !== undefined
  );
}
