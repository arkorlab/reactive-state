import {
  type Expression,
  isCallExpression,
  isGetAccessorDeclaration,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { writtenArrayKey } from './framed-array-functions.ts';

/** Accessors that take an assignment of a fresh object's member, leaving what it held before. */

/** How `Object.create`'s written descriptors define a name: as plain data, not at all, or otherwise. */
type Described = 'absent' | 'data' | 'other';

/**
 * Whether an accessor may take an assignment of a name on a fresh object: a getter or setter its
 * literal declares under that name, or under a name not read; for `Object.create`, an own
 * descriptor other than plain data, or else an accessor of a prototype other than `null` or a
 * literal without one.
 */
export function framedAccessorTakes(value: Expression, key: string): boolean {
  if (isObjectLiteralExpression(value)) return framedLiteralAccessor(value, key);
  if (
    !isCallExpression(value) ||
    globalPathOf(unwrapped(value.expression))?.join('.') !== 'Object.create'
  )
    return false;
  const [prototype, descriptors, ...rest] = value.arguments;
  if (prototype === undefined || rest.length > 0) return true;
  const own = descriptors === undefined ? 'absent' : describedKind(descriptors, key);
  if (own !== 'absent') return own !== 'data';
  const written = unwrapped(prototype);
  if (written.kind === SyntaxKind.NullKeyword) return false;
  return !isObjectLiteralExpression(written) || framedLiteralAccessor(written, key);
}

/** Whether a written literal declares a getter or setter under the name, or under one not read. */
export function framedLiteralAccessor(literal: ObjectLiteralExpression, key: string): boolean {
  return literal.properties.some((property) => {
    if (!isGetAccessorDeclaration(property) && !isSetAccessorDeclaration(property)) return false;
    const name = writtenArrayKey(property.name);
    return name === undefined || name === key;
  });
}

/** The last written descriptor of a name; a spread or an unread name may define it otherwise. */
function describedKind(node: Expression, key: string): Described {
  const descriptors = unwrapped(node);
  if (!isObjectLiteralExpression(descriptors)) return 'other';
  let kind: Described = 'absent';
  for (const property of descriptors.properties) {
    if (isSpreadAssignment(property)) return 'other';
    const name = writtenArrayKey(property.name);
    if (name === undefined) return 'other';
    if (name !== key) continue;
    kind =
      isPropertyAssignment(property) && dataDescriptor(property.initializer) ? 'data' : 'other';
  }
  return kind;
}

/** A written descriptor literal naming neither `get` nor `set`, nor anything that may be either. */
function dataDescriptor(node: Expression): boolean {
  const descriptor = unwrapped(node);
  return (
    isObjectLiteralExpression(descriptor) &&
    descriptor.properties.every((property) => {
      if (isSpreadAssignment(property)) return false;
      const name = writtenArrayKey(property.name);
      return name !== undefined && name !== 'get' && name !== 'set';
    })
  );
}
