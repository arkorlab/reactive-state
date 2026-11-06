import {
  type Expression,
  isComputedPropertyName,
  isCallExpression,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  isStringLiteral,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import type { AssignedFrameSource } from './framed-assignment-patterns.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedEntriesCall, framedEntryValues } from './framed-entry-values.ts';
import { framedFactoryReturns } from './framed-factory-returns.ts';
import { framedArgumentPrefix, framedKeyNames } from './framed-keys.ts';

/** Source-written literal property selections retain their possible Error values. */
export function framedObjectMember(
  node: Expression,
  keys: readonly string[],
  error: (value: Expression, path: readonly string[]) => boolean,
): boolean {
  return framedObjectSources(node, keys)?.some((each) => error(each.value, each.keys)) === true;
}

/** Direct literal selections retain their original values and remaining written member paths. */
export function framedObjectSources(
  node: Expression,
  keys: readonly string[],
): readonly AssignedFrameSource[] | undefined {
  const root = literalReceiver(node, keys);
  if (root === undefined) return undefined;
  const pending: AssignedFrameSource[] = [root];
  const found: AssignedFrameSource[] = [];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = unwrapped(at.value);
    const key = at.keys[0];
    if (key === undefined) {
      found.push(at);
      continue;
    }
    const entries = selectedEntries(value, key);
    if (entries === undefined) {
      found.push(at);
      continue;
    }
    for (const each of entries) {
      pending.push({ value: each.value, keys: [...each.keys, ...at.keys.slice(1)] });
    }
  }
  return found;
}

/** Direct literal receivers preserve their written path without guessing mutable holder fields. */
function literalReceiver(
  node: Expression,
  keys: readonly string[],
): AssignedFrameSource | undefined {
  let value = unwrapped(node);
  let path = keys;
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = frameMemberName(value);
    if (key === undefined) return undefined;
    path = [key, ...path];
    value = unwrapped(value.expression);
  }
  return (isObjectLiteralExpression(value) ||
    assignedSources(value) !== undefined ||
    framedEntriesCall(value)) &&
    path.length > 0
    ? { value, keys: path }
    : undefined;
}

/** Ordered native copies keep a definite later field and retain opaque possible source fields. */
function selectedEntries(
  value: Expression,
  key: string,
): readonly AssignedFrameSource[] | undefined {
  if (isObjectLiteralExpression(value)) {
    const own = ownEntries(value, key);
    return own.own ? own.values : [...own.values, ...inheritedEntries(value, key)];
  }
  const entries = framedEntryValues(value, key);
  if (entries !== undefined) return entries;
  const sources = assignedSources(value);
  if (sources === undefined) return undefined;
  let values: AssignedFrameSource[] = [];
  const inherited: AssignedFrameSource[] = [];
  for (const source of sources) {
    const object = unwrapped(source);
    if (isObjectLiteralExpression(object)) {
      inherited.push(...copiedPrototypes(object, key));
      const selected = ownEntries(object, key);
      if (selected.own) values = selected.values;
      else values.push(...selected.values);
    } else values.push({ value: source, keys: [key] });
  }
  return [...values, ...inherited];
}

/**
 * The empty target inherits `Object.prototype`'s `__proto__` setter, so a source's own `__proto__`
 * entry, copied with `Set`, becomes the target's prototype, which a field is then read from. A later
 * write may meet a setter of that prototype, so no later field hides it.
 */
function copiedPrototypes(
  object: ObjectLiteralExpression,
  key: string,
): readonly AssignedFrameSource[] {
  const prototypes = ownEntries(object, '__proto__', true).values;
  return prototypes.map((each) => ({ value: each.value, keys: [...each.keys, key] }));
}

/**
 * A member a literal's own fields do not define is read from the prototype its written `__proto__`
 * entry sets, getters included; a computed or shorthand `__proto__` defines a field instead.
 */
function inheritedEntries(
  object: ObjectLiteralExpression,
  key: string,
): readonly AssignedFrameSource[] {
  return framedLiteralPrototypes(object).map((value) => ({ value, keys: [key] }));
}

/** The prototypes a literal's written `__proto__` entries set, other than `null`. */
export function framedLiteralPrototypes(object: ObjectLiteralExpression): readonly Expression[] {
  const prototypes: Expression[] = [];
  for (const property of object.properties) {
    if (!isPropertyAssignment(property) || !prototypeName(property.name)) continue;
    if (unwrapped(property.initializer).kind !== SyntaxKind.NullKeyword)
      prototypes.push(property.initializer);
  }
  return prototypes;
}

/** The spelling that sets a literal's prototype rather than naming its own field. */
function prototypeName(name: PropertyName): boolean {
  return (isIdentifier(name) || isStringLiteral(name)) && name.text === '__proto__';
}

/** A fresh empty native assign target has no source-written setter that could intercept a copy. */
function assignedSources(value: Expression): readonly Expression[] | undefined {
  if (!isCallExpression(value) || globalPathOf(value.expression)?.join('.') !== 'Object.assign')
    return undefined;
  const prefix = framedArgumentPrefix(value, value.arguments, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return undefined;
  const target = prefix.values[0];
  const object = target === undefined ? undefined : unwrapped(target);
  return object !== undefined && isObjectLiteralExpression(object) && object.properties.length === 0
    ? prefix.values.slice(1)
    : undefined;
}

/** One literal's own descriptor state, before a spread copies its values as ordinary data. */
interface EntryReading {
  readonly pending: ObjectLiteralExpression['properties'][number][];
  values: AssignedFrameSource[];
  getter: readonly AssignedFrameSource[] | undefined;
  own: boolean;
}

/**
 * Literal spreads copy data values; a setter pairs only with a getter on the same receiver. A copy
 * takes no written `__proto__`, which sets the literal's prototype rather than an entry.
 */
function ownEntries(object: ObjectLiteralExpression, key: string, copied = false): EntryReading {
  const pending: EntryReading[] = [entryReading(object)];
  while (pending.length > 0) {
    const at = pending.at(-1);
    if (at === undefined) break;
    const property = at.pending.pop();
    if (property === undefined) {
      const completed = completeEntries(pending);
      if (completed !== undefined) return completed;
      continue;
    }
    if (spreadEntry(property, at, key, pending)) continue;
    if (copied && isPropertyAssignment(property) && prototypeName(property.name)) continue;
    selectEntry(at, property, key);
  }
  return entryReading(object);
}

/** A completed spread copies its value but cannot transfer its original getter/setter pair. */
function completeEntries(pending: EntryReading[]): EntryReading | undefined {
  const completed = pending.pop();
  if (completed === undefined) return undefined;
  const parent = pending.at(-1);
  if (parent === undefined) return completed;
  if (completed.own) {
    parent.values = completed.values;
    parent.getter = undefined;
    parent.own = true;
  } else parent.values.push(...completed.values);
  return undefined;
}

/** An empty literal spread changes no descriptor; opaque spread values remain possible data. */
function spreadEntry(
  property: ObjectLiteralExpression['properties'][number],
  at: EntryReading,
  key: string,
  pending: EntryReading[],
): boolean {
  if (!isSpreadAssignment(property)) return false;
  const spread = unwrapped(property.expression);
  if (isObjectLiteralExpression(spread)) pending.push(entryReading(spread));
  else at.values.push({ value: property.expression, keys: [key] });
  return true;
}

/** Each nested literal starts with no selected property or accessor pair. */
function entryReading(object: ObjectLiteralExpression): EntryReading {
  return { pending: object.properties.toReversed(), values: [], getter: undefined, own: false };
}

/** A definite field replaces earlier candidates; opaque names retain all possible selected values. */
function selectEntry(
  at: EntryReading,
  property: ObjectLiteralExpression['properties'][number],
  key: string,
): void {
  if (isSpreadAssignment(property)) return;
  const names = memberNames(property.name);
  if (names !== undefined && !names.includes(key)) return;
  const values = entryValues(property).map((value) => ({ value, keys: [] }));
  if (names?.length === 1) {
    at.own = true;
    if (isSetAccessorDeclaration(property)) {
      at.values = [...(at.getter ?? [])];
      return;
    }
    at.values = values;
    at.getter = isGetAccessorDeclaration(property) ? values : undefined;
  } else {
    at.values.push(...values);
    if (isGetAccessorDeclaration(property)) at.getter = [...(at.getter ?? []), ...values];
  }
}

/** Data entries and synchronous getter returns retain their original lexical source expressions. */
function entryValues(node: ObjectLiteralExpression['properties'][number]): readonly Expression[] {
  if (isPropertyAssignment(node)) return [node.initializer];
  if (isShorthandPropertyAssignment(node) && isIdentifier(node.name)) return [node.name];
  if (!isGetAccessorDeclaration(node) || node.body === undefined || answersLater(node)) return [];
  return (
    framedFactoryReturns(node.body, (statement) =>
      /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile())),
    ) ?? []
  );
}

/** Known computed alternatives retain lexical key bindings; unresolved names may replace any field. */
function memberNames(name: PropertyName | undefined): readonly string[] | undefined {
  if (name === undefined) return undefined;
  if (isComputedPropertyName(name)) return framedKeyNames(name.expression);
  if (isNumericLiteral(name)) return [String(Number(name.text))];
  return isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)
    ? [name.text]
    : undefined;
}
