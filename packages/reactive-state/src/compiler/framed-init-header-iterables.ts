import {
  type Expression,
  type Identifier,
  isCatchClause,
  isComputedPropertyName,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isParameterDeclaration,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isVariableDeclaration,
  type NewExpression,
  type Node,
  type ObjectLiteralExpression,
  type PropertyName,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedInitTextValue, type InitTextWords } from './framed-init-option-text.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedNativeEntryGenerator } from './framed-native-entry-generators.ts';
import type { FramedNativeErrorReads } from './framed-native-error-inputs.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedPrefixSameOwner, framedQuietOwnerPrefix } from './framed-native-prefix.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedRecordOrigin } from './framed-record-origins.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Native Request and Response header iterators convert finite direct Error entry values. */

const CONSTRUCTORS = new Set(['Request', 'Response']);
const ITERATORS = new Set(['Symbol.iterator']);
const NATIVES = new Set(['Request', 'Response', 'Symbol.iterator']);

/** Closed original arguments and unchanged literal dictionaries precede each selected conversion. */
export function framedInitHeaderIterable(call: NewExpression, words: InitTextWords): boolean {
  if (!framedNativeConstructor(call.expression, CONSTRUCTORS)) return false;
  const options = quietArguments(call);
  if (options === undefined) return false;
  const init = framedRecordOrigin(options, call);
  if (
    init?.unchanged !== true ||
    !framedPrefixSameOwner(init.record, call) ||
    !framedOriginCoowned(options, call)
  )
    return false;
  const headers = headerOption(init.record);
  if (headers === undefined) return false;
  const origin = framedRecordOrigin(headers, call);
  if (
    origin?.unchanged !== true ||
    !framedPrefixSameOwner(origin.record, call) ||
    !framedOriginCoowned(headers, call)
  )
    return false;
  const entries = framedNativeEntryGenerator(origin.record);
  if (entries === undefined) return false;
  return iteratorWords(
    entries.filter((entry) => entry.active).map((entry) => entry.value),
    origin.record,
    call,
    words,
  );
}

/** Both original operands are evaluated quietly; ignored or spread arguments retain opacity. */
function quietArguments(call: NewExpression): Expression | undefined {
  const args = call.arguments ?? [];
  if (args.length !== 2) return undefined;
  const first = args[0];
  const options = args[1];
  return first !== undefined &&
    options !== undefined &&
    framedQuietPrimitive(first) &&
    quietPrefix(call)
    ? options
    : undefined;
}

/** Native symbol names are quiet; earlier completed application work keeps the original opacity. */
function quietPrefix(call: NewExpression): boolean {
  return framedQuietOwnerPrefix(call, {
    primitive: (value) =>
      framedMapKey(value) !== undefined || framedNativeConstructor(value, ITERATORS),
    value: (value) => framedNativeConstructor(value, NATIVES),
  });
}

/** The selected header literal is created quietly; every unselected dictionary value stays primitive. */
function headerOption(record: ObjectLiteralExpression): Expression | undefined {
  let headers: Expression | undefined;
  for (const property of record.properties) {
    if (isSpreadAssignment(property)) return undefined;
    const name = optionName(property.name);
    const value = optionValue(property);
    if (name === undefined || name === '__proto__' || value === undefined) return undefined;
    if (name === 'headers') {
      if (headers !== undefined) return undefined;
      headers = value;
    } else if (!framedQuietPrimitive(value)) return undefined;
  }
  return headers;
}

/** Only direct static option names can select the native headers dictionary member. */
function optionName(name: PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (!isComputedPropertyName(name) && isIdentifier(name)) return name.text;
  const value = isComputedPropertyName(name) ? unwrapped(name.expression) : name;
  return isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value) ? value.text : undefined;
}

/** Only ordinary data fields or shorthand reads contribute option values. */
function optionValue(
  property: ObjectLiteralExpression['properties'][number],
): Expression | undefined {
  if (isPropertyAssignment(property)) {
    if (isComputedPropertyName(property.name) && !framedQuietPrimitive(property.name.expression))
      return undefined;
    return property.initializer;
  }
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? property.name
    : undefined;
}

/** Only the closed iterator is invoked; other quiet literal record reads cannot change Error conversion. */
function iteratorWords(
  values: readonly Expression[],
  record: ObjectLiteralExpression,
  call: NewExpression,
  words: InitTextWords,
): boolean {
  const consumed = consumedReads(values, call, words);
  if (consumed === undefined) return false;
  const reads: FramedNativeErrorReads = {
    consumer: call,
    unconverted: unconvertedReads(record, call, words),
    consumed,
  };
  let found = false;
  for (const value of values) {
    if (framedQuietPrimitive(value)) continue;
    if (!framedInitTextValue(value, call, words, reads)) return false;
    found = true;
  }
  return found;
}

/** Each active nonprimitive cell is an initialized same-owner Error binding before native conversion. */
function consumedReads(
  values: readonly Expression[],
  call: NewExpression,
  words: InitTextWords,
): ReadonlySet<Identifier> | undefined {
  const reads = new Set<Identifier>();
  for (const value of values) {
    if (framedQuietPrimitive(value)) continue;
    const source = unwrapped(value);
    if (
      !isIdentifier(source) ||
      !readyErrorBinding(source, call) ||
      !framedOriginCoowned(source, call) ||
      !words.error(source)
    )
      return undefined;
    reads.add(source);
  }
  return reads;
}

/** Unused literal data fields add only their direct quiet binding reads, never key or nested evaluation. */
function unconvertedReads(
  record: ObjectLiteralExpression,
  call: NewExpression,
  words: InitTextWords,
): ReadonlySet<Identifier> {
  const reads = new Set<Identifier>();
  for (const property of record.properties) {
    const value = optionValue(property);
    if (value === undefined) continue;
    const source = unwrapped(value);
    if (isIdentifier(source) && readyErrorBinding(source, call) && words.error(source))
      reads.add(source);
  }
  return reads;
}

/** Direct parameters and catch bindings, or completed same-owner whole aliases, precede iteration. */
function readyErrorBinding(expression: Expression, call: NewExpression): boolean {
  let value = unwrapped(expression);
  const seen = new Set<Node>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0) return false;
    const { binding } = selected;
    if (seen.has(binding) || binding.end > call.pos || !framedPrefixSameOwner(binding, call))
      return false;
    seen.add(binding);
    if (isParameterDeclaration(binding) || isCatchClause(binding.parent)) return true;
    if (!isVariableDeclaration(binding) || binding.initializer === undefined) return false;
    value = unwrapped(binding.initializer);
  }
  return false;
}
