import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { framedArrayString } from './framed-arrays.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import {
  framedQuietArrayWords,
  framedQuietGetter,
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedObjectSources } from './framed-object-members.ts';

/** A native Response converts the selected statusText option independently of its body. */

const RESPONSES = new Set(['Response']);

interface ResponseWords {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** Known Response constructor options retain only their selected status-text value. */
export function framedResponseStatusText(
  call: CallExpression | NewExpression,
  words: ResponseWords,
): boolean {
  const selected = framedNativeArguments(call, RESPONSES);
  if (selected?.constructed !== true || selected.args === undefined) return false;
  if (
    !framedQuietInputs(call.arguments ?? [], RESPONSES) ||
    !framedQuietInputs(selected.args, RESPONSES)
  )
    return false;
  const prefix = framedArgumentPrefix(call, selected.args, 2).values;
  const body = prefix[0];
  const options = prefix[1];
  if (
    options === undefined ||
    (body !== undefined && !framedQuietPrimitive(body)) ||
    !quietEarlierOptions(options)
  )
    return false;
  const pending: { value: Expression; keys: readonly string[] }[] = [
    { value: options, keys: ['statusText'] },
  ];
  const seen = new Set<Expression>();
  for (let source = pending.pop(); source !== undefined; source = pending.pop()) {
    const { value, keys } = source;
    if (seen.has(value)) continue;
    seen.add(value);
    const normalized = responseOptions(value) ?? value;
    const entries = framedObjectSources(normalized, keys);
    if (entries !== undefined) {
      pending.push(...entries);
      continue;
    }
    if (convertedStatusText(value, keys, words, call)) return true;
  }
  return false;
}

/** Literal array words need a quiet preceding element conversion as well as a native text method. */
function convertedStatusText(
  value: Expression,
  keys: readonly string[],
  words: ResponseWords,
  call: CallExpression | NewExpression,
): boolean {
  return (
    keys.length === 0 &&
    ((framedNativeErrorInput(value, call, undefined, false) && words.error(value)) ||
      (framedQuietArrayWords(value, words.error, call) && framedArrayString(value, words, call)))
  );
}

/** Whole constant options aliases retain their fields before an earlier exposure or write. */
function responseOptions(expression: Expression): Expression | undefined {
  let value = unwrapped(expression);
  const aliases = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0) return undefined;
    const { binding } = selected;
    if (
      !isVariableDeclaration(binding) ||
      !isIdentifier(binding.name) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined ||
      aliases.has(binding)
    )
      return undefined;
    aliases.add(binding);
    value = unwrapped(binding.initializer);
  }
  return argumentArrayExposed(expression, aliases, undefined, false) ? undefined : value;
}

/** ResponseInit reads headers and status before converting statusText, including their native conversions. */
function quietEarlierOptions(options: Expression): boolean {
  const source = responseOptions(options);
  return (
    source !== undefined &&
    isObjectLiteralExpression(source) &&
    framedQuietInputs([source], RESPONSES) &&
    quietOption(options, 'headers', quietHeaders) &&
    quietOption(options, 'status', framedQuietPrimitive)
  );
}

/** A selected earlier dictionary value must complete without a getter, iterator or coercion callback. */
function quietOption(
  options: Expression,
  key: string,
  quiet: (value: Expression) => boolean,
): boolean {
  const pending: { value: Expression; keys: readonly string[] }[] = [
    { value: options, keys: [key] },
  ];
  const seen = new Set<Expression>();
  for (let selected = pending.pop(); selected !== undefined; selected = pending.pop()) {
    const { value, keys } = selected;
    if (seen.has(value)) return false;
    seen.add(value);
    if (keys.length === 0) {
      if (!quiet(value)) return false;
      continue;
    }
    const source = responseOptions(value) ?? value;
    const entries = framedObjectSources(source, keys);
    if (entries === undefined) return false;
    pending.push(...entries);
  }
  return true;
}

/** Literal header records and entry lists retain only primitive byte strings before status text. */
function quietHeaders(expression: Expression): boolean {
  const pending = [expression];
  const seen = new Set<Expression>();
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = framedQuietSource(at, false);
    if (value === undefined || seen.has(value)) return false;
    seen.add(value);
    if (!quietHeaderValue(value, pending)) return false;
  }
  return true;
}

/** An omitted field, literal entry list or closed record completes before status-text conversion. */
function quietHeaderValue(value: Expression, pending: Expression[]): boolean {
  if (isIdentifier(value) && value.text === 'undefined' && framedQuietPrimitive(value)) return true;
  if (isArrayLiteralExpression(value))
    return value.elements.every((entry) => quietHeaderEntry(entry));
  return isObjectLiteralExpression(value) && quietHeaderFields(value, pending);
}

/** Closed record fields and literal spreads add no earlier application conversion. */
function quietHeaderFields(value: ObjectLiteralExpression, pending: Expression[]): boolean {
  for (const field of value.properties) {
    if (isSpreadAssignment(field)) pending.push(field.expression);
    else if (!quietHeaderField(field)) return false;
  }
  return true;
}

/** A native header sequence entry has exactly two source-known primitive byte strings. */
function quietHeaderEntry(expression: Expression): boolean {
  const entry = framedQuietSource(expression);
  return (
    entry !== undefined &&
    isArrayLiteralExpression(entry) &&
    entry.elements.length === 2 &&
    entry.elements.every((value) => quietByteString(value))
  );
}

/** Record values retain direct return getters; computed keys and callable members remain opaque. */
function quietHeaderField(field: ObjectLiteralExpression['properties'][number]): boolean {
  if (isSpreadAssignment(field)) return false;
  const { name } = field;
  if (
    (!isIdentifier(name) &&
      !isStringLiteral(name) &&
      !isNoSubstitutionTemplateLiteral(name) &&
      !isNumericLiteral(name)) ||
    name.text === '__proto__' ||
    !byteText(name.text)
  )
    return false;
  if (isPropertyAssignment(field)) return quietByteString(field.initializer);
  if (isShorthandPropertyAssignment(field) && isIdentifier(field.name))
    return quietByteString(field.name);
  if (!isGetAccessorDeclaration(field)) return false;
  const value = framedQuietGetter(field);
  return value !== undefined && quietByteString(value);
}

/** Primitive text cannot run application coercion or fail the earlier WebIDL ByteString conversion. */
function quietByteString(expression: Expression): boolean {
  if (!framedQuietPrimitive(expression)) return false;
  const value = framedQuietSource(expression, false);
  return (
    value !== undefined &&
    (!(isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) || byteText(value.text))
  );
}

/** Header byte strings exclude code points outside their native one-byte range. */
function byteText(text: string): boolean {
  const BYTE = { maximum: 255 } as const;
  for (const character of text) {
    const point = character.codePointAt(0);
    if (point === undefined || point > BYTE.maximum) return false;
  }
  return true;
}
