import {
  isCallSignatureDeclaration,
  isFunctionTypeNode,
  isIdentifier,
  isIntersectionTypeNode,
  isTypeLiteralNode,
  type ParameterDeclaration,
} from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';
import { interfaceShapeReadings } from './local-type-interface-members.ts';

/** Explicit callable receiver annotations retain their original type argument environments. */

/** A first written this parameter is a receiver, separate from runtime argument positions. */
export function receiverReading(
  context: TypeReading,
  parameters: readonly ParameterDeclaration[],
): TypeReading | undefined {
  const first = parameters[0];
  return first !== undefined &&
    isIdentifier(first.name) &&
    first.name.text === 'this' &&
    first.type !== undefined
    ? { ...context, type: first.type }
    : undefined;
}

/**
 * The last written callable signature supplies the native receiver utility's result. Signatures an
 * interface inherits that the reader cannot read leave it unresolved, unless one it reads follows.
 */
export function receiverUtilityReading(
  at: TypeReading,
  operands: (reading: TypeReading) => readonly TypeReading[],
): TypeReading | undefined {
  let result: TypeReading | undefined;
  // `null` holds the place of signatures the reader cannot read, listed where TypeScript lists them.
  const pending: (TypeReading | null)[] = [at];
  for (let reading = pending.pop(); reading !== undefined; reading = pending.pop()) {
    if (reading === null) {
      result = undefined;
      continue;
    }
    const { type } = reading;
    const interfaces = interfaceShapeReadings(reading, operands);
    if (interfaces !== undefined) pending.push(...signatureParts(interfaces).toReversed());
    else if (isIntersectionTypeNode(type)) {
      const parts = type.types.flatMap((member) => operands({ ...reading, type: member }));
      pending.push(...parts.toReversed());
    } else if (isFunctionTypeNode(type)) result = receiverReading(reading, type.parameters);
    else if (isTypeLiteralNode(type)) {
      for (const member of type.members) {
        if (isCallSignatureDeclaration(member))
          result = receiverReading(reading, member.parameters);
      }
    }
  }
  return result;
}

/** An interface's shapes in signature order, `null` where the signatures it cannot read are listed. */
function signatureParts(
  shapes: NonNullable<ReturnType<typeof interfaceShapeReadings>>,
): (TypeReading | null)[] {
  const parts: (TypeReading | null)[] = [...shapes.sources];
  if (shapes.unknownAfter !== undefined) parts.splice(shapes.unknownAfter, 0, null);
  return parts;
}
