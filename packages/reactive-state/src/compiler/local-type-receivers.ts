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

/** The last written callable signature supplies the native receiver utility's result. */
export function receiverUtilityReading(
  at: TypeReading,
  operands: (reading: TypeReading) => readonly TypeReading[],
): TypeReading | undefined {
  let result: TypeReading | undefined;
  const pending = [at];
  for (let reading = pending.pop(); reading !== undefined; reading = pending.pop()) {
    const { type } = reading;
    const interfaces = interfaceShapeReadings(reading, operands);
    if (interfaces !== undefined) pending.push(...interfaces.sources.toReversed());
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
