import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isVariableDeclaration,
  isVariableDeclarationList,
  type ObjectLiteralExpression,
  type PropertyName,
  type GetAccessorDeclaration,
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSpreadAssignment,
  isVariableStatement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { iteratorQuietValues } from './framed-iterator-guards.ts';
import { framedArgumentPrefix, framedKeyNames } from './framed-keys.ts';
import { framedObjectSources } from './framed-object-members.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedPropertyNames } from './framed-symbol-keys.ts';

const ENTRIES = new Set(['Object.entries']);

/** A selected native entry tuple retains data in slot zero and its original source in slot one. */
export function entryArrayViews(
  receiver: Expression,
  index: number | undefined,
  stable: (value: Expression) => boolean,
): readonly ArrayElementView[] | undefined {
  const value = unwrapped(receiver);
  if (!isElementAccessExpression(value)) return undefined;
  const call = entryCall(value.expression);
  if (call === undefined || !stable(value.expression)) return undefined;
  if (index !== undefined && index !== 1 && index !== -1) return [];
  const positions = framedKeyNames(value.argumentExpression);
  if (positions === undefined) return enumeratedArrayViews(call, undefined, true);
  return positions.flatMap((key) =>
    /^(?:0|[1-9]\d*)$/u.test(key) ? (enumeratedArrayViews(call, Number(key), true) ?? []) : [],
  );
}

/** Whole constant result aliases retain an unexposed native entries call and original lexical nodes. */
function entryCall(node: Expression): CallExpression | undefined {
  let value = unwrapped(node);
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || seen.has(selected.binding))
      return undefined;
    const binding = selected.binding;
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    seen.add(binding);
    value = unwrapped(binding.initializer);
  }
  return isCallExpression(value) && framedNativeConstructor(value.expression, ENTRIES)
    ? value
    : undefined;
}

/** Native Object.values enumerates own string keys in numeric-then-insertion order. */
export function enumeratedArrayViews(
  call: CallExpression,
  index: number | undefined,
  entries = false,
): readonly ArrayElementView[] | undefined {
  if (entries && !framedNativeConstructor(call.expression, ENTRIES)) return undefined;
  if (!entries && globalPathOf(unwrapped(call.expression))?.join('.') !== 'Object.values')
    return undefined;
  const prefix = framedArgumentPrefix(call, call.arguments, 1);
  const first = prefix.values[0];
  if (first === undefined || prefix.alternatives !== undefined) return undefined;
  const object = unwrapped(first);
  if (!isObjectLiteralExpression(object)) return undefined;
  const keys = literalKeys(object);
  if (keys === undefined) return undefined;
  const ordered = Object.keys(Object.fromEntries(keys.map((key) => [key, true])));
  const at = index !== undefined && index < 0 ? ordered.length + index : index;
  const selected = at === undefined ? ordered : ordered.slice(at, at + 1);
  if (at !== undefined && at < 0) return [];
  return selected.flatMap((key) => {
    const sources = framedObjectSources(object, [key]);
    return (
      sources?.flatMap((source) => {
        return entries || source.keys.length === 0
          ? [{ value: source.value, index: undefined, element: true, keys: source.keys }]
          : [];
      }) ?? []
    );
  });
}

/**
 * Only literal nested spreads and fully written names establish a complete enumeration order, and
 * only quiet getters: enumeration runs each getter in turn, which may replace, delete or rewrite
 * what it reads later.
 */
function literalKeys(object: ObjectLiteralExpression): readonly string[] | undefined {
  const keys: string[] = [];
  const pending = object.properties.toReversed();
  for (let property = pending.pop(); property !== undefined; property = pending.pop()) {
    if (isSpreadAssignment(property)) {
      const value = unwrapped(property.expression);
      if (!isObjectLiteralExpression(value)) return undefined;
      pending.push(...value.properties.toReversed());
      continue;
    }
    if (isGetAccessorDeclaration(property) && !quietGetter(property)) return undefined;
    const key = enumeratedName(property.name);
    if (key === undefined) return undefined;
    if (
      key === null ||
      (key === '__proto__' &&
        isPropertyAssignment(property) &&
        !isComputedPropertyName(property.name))
    )
      continue;
    keys.push(key);
  }
  return keys;
}

/** Symbol keys are omitted; one known string key keeps its native insertion position. */
function enumeratedName(name: PropertyName): string | null | undefined {
  if (!isComputedPropertyName(name)) return writtenArrayKey(name);
  const names = framedPropertyNames(name.expression);
  if (names === undefined || names.length > 1) return undefined;
  return names.length === 0 ? null : names[0];
}

/** A getter of const declarations and a return, all of quiet values, changes nothing it is read beside. */
function quietGetter(getter: GetAccessorDeclaration): boolean {
  const statements = getter.body?.statements ?? [];
  return statements.every((statement, at) => {
    if (isReturnStatement(statement))
      return (
        at === statements.length - 1 &&
        (statement.expression === undefined || iteratorQuietValues([statement.expression]))
      );
    return (
      isVariableStatement(statement) &&
      /^const\b/u.test(statement.declarationList.getText(statement.getSourceFile())) &&
      statement.declarationList.declarations.every(
        (each) => each.initializer !== undefined && iteratorQuietValues([each.initializer]),
      )
    );
  });
}
