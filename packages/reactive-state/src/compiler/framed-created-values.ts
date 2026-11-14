import {
  type CallExpression,
  type Expression,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  type MethodDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { framedAtMethod } from './framed-at-methods.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedObjectSources } from './framed-object-members.ts';

/** A native Object.create retains positive installed-value proofs without masking opaque assertions. */
export function framedCreatedResult(
  call: CallExpression,
  keys: readonly string[],
  error: (value: Expression, path: readonly string[]) => boolean,
): boolean | undefined {
  const prefix = framedArgumentPrefix(call);
  if (prefix.unknown || prefix.alternatives !== undefined) return undefined;
  const [prototype, map] = prefix.values;
  const key = keys[0];
  if (prototype === undefined || map === undefined || key === undefined) return undefined;
  const descriptors = descriptorFields(map);
  if (descriptors === undefined) return undefined;
  const descriptor = descriptors.get(key);
  if (descriptor === undefined) return selectedError(prototype, keys, error) ? true : undefined;
  if (isMethodDeclaration(descriptor)) return undefined;
  return installedError(descriptor, keys.slice(1), error) === true ? true : undefined;
}

/** A complete literal descriptor supplies either its data value or a synchronous getter result. */
function installedError(
  descriptor: Expression,
  keys: readonly string[],
  error: (value: Expression, path: readonly string[]) => boolean,
): boolean | undefined {
  const fields = descriptorFields(descriptor);
  if (fields === undefined) return undefined;
  const value = fields.get('value');
  const getter = fields.get('get');
  if (value !== undefined && getter !== undefined) return undefined;
  if (value !== undefined)
    return isMethodDeclaration(value) ? undefined : selectedError(value, keys, error);
  if (getter === undefined) return false;
  if (!isMethodDeclaration(getter) && globalPathOf(unwrapped(getter))?.join('.') === 'undefined')
    return false;
  return framedAtMethod(getter, (each) => selectedError(each, keys, error));
}

/** Accessor-backed descriptor attributes and unknown keys keep the installed value opaque. */
function descriptorFields(
  expression: Expression,
): ReadonlyMap<string, Expression | MethodDeclaration> | undefined {
  const value = unwrapped(expression);
  if (!isObjectLiteralExpression(value)) return undefined;
  const fields = new Map<string, Expression | MethodDeclaration>();
  for (const field of value.properties) {
    if (
      !isPropertyAssignment(field) &&
      !isMethodDeclaration(field) &&
      !isShorthandPropertyAssignment(field)
    )
      return undefined;
    const key = writtenArrayKey(field.name);
    if (key === undefined || key === '__proto__') return undefined;
    if (isMethodDeclaration(field)) fields.set(key, field);
    else if (isPropertyAssignment(field)) fields.set(key, field.initializer);
    else if (isIdentifier(field.name)) fields.set(key, field.name);
    else return undefined;
  }
  return fields;
}

/** Nested written members retain their source path and existing lexical Error proof. */
function selectedError(
  value: Expression,
  keys: readonly string[],
  error: (value: Expression, path: readonly string[]) => boolean,
): boolean {
  const sources = framedObjectSources(value, keys);
  return sources === undefined
    ? error(value, keys)
    : sources.some((each) => error(each.value, each.keys));
}
