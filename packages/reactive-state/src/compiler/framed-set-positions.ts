import {
  type Expression,
  type Node,
  isArrayLiteralExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isVariableDeclaration,
  isVariableDeclarationList,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedAssignedValues } from './framed-writes.ts';
import { localTypePrimitiveIdentityKeys, namesLocalMemberType } from './local-type-reading.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Finite source-written Set entries retain insertion positions and guaranteed duplicate identities. */

export interface SetIdentity {
  readonly key: string;
  readonly uncertain: boolean;
  readonly primitiveKeys?: readonly string[];
}

/** Unknown equality among supplied Error objects preserves each possible insertion position. */
export function finiteSetPositions(
  values: readonly (Expression | undefined)[],
  index: number,
  read: Expression,
): readonly Expression[] | undefined {
  if (index === 0) return values[0] === undefined ? [] : [values[0]];
  const selected: Expression[] = [];
  const seen = new Set<string>();
  const identities: SetIdentity[] = [];
  for (const value of values) {
    const identity = setIdentity(value, read);
    if (identity === undefined) return undefined;
    if (seen.has(identity.key)) continue;
    seen.add(identity.key);
    const minimum = minimumSetPosition(identities);
    if (value !== undefined && index >= minimum && index <= identities.length) selected.push(value);
    identities.push(identity);
  }
  return selected;
}

/** Different known keys remain distinct; supplied Errors may also match a written primitive arm. */
function minimumSetPosition(identities: readonly SetIdentity[]): number {
  const known = identities.filter((identity) => !identity.uncertain);
  const unmatched = identities.some(
    (identity) =>
      identity.uncertain && known.every((other) => !possiblePrimitive(identity, other.key)),
  );
  return known.length + (unmatched ? 1 : 0);
}

/** Fresh local identities never match a primitive alternative of a supplied parameter. */
function possiblePrimitive(identity: SetIdentity, key: string): boolean {
  if (!key.startsWith('primitive:')) return false;
  return (
    identity.primitiveKeys?.some((alternative) => {
      return (
        alternative === '*' ||
        alternative === key ||
        (alternative.endsWith(':*') && key.startsWith(alternative.slice(0, -1)))
      );
    }) === true
  );
}

/** Written primitive values, fresh local shapes and unchanged native Error parameters keep identity. */
export function setIdentity(
  expression: Expression | undefined,
  read: Expression,
): SetIdentity | undefined {
  if (expression === undefined || isOmittedExpression(expression))
    return { key: 'primitive:undefined', uncertain: false };
  const primitive = framedMapKey(expression);
  if (primitive !== undefined) return { key: `primitive:${primitive}`, uncertain: false };
  let value = unwrapped(expression);
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    const binding = selected?.binding;
    if (
      binding === undefined ||
      selected?.keys.length !== 0 ||
      seen.has(binding) ||
      framedAssignedValues(value).length > 0
    )
      return undefined;
    seen.add(binding);
    if (isParameterDeclaration(binding)) {
      return namesLocalMemberType(binding.type, [], STANDARD_ERRORS)
        ? {
            key: `parameter:${binding.pos}`,
            uncertain: true,
            primitiveKeys: localTypePrimitiveIdentityKeys(binding.type),
          }
        : undefined;
    }
    if (
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    value = unwrapped(binding.initializer);
  }
  return freshLocal(value, read) ? { key: `fresh:${value.pos}`, uncertain: false } : undefined;
}

/** A literal or construction allocated in this execution cannot equal a supplied parameter. */
function freshLocal(value: Node, read: Expression): boolean {
  return (
    executionOwner(value) === executionOwner(read) &&
    (isObjectLiteralExpression(value) || isArrayLiteralExpression(value) || isNewExpression(value))
  );
}
