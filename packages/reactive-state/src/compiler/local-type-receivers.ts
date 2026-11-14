import {
  isCallSignatureDeclaration,
  isFunctionTypeNode,
  isIdentifier,
  isTypeLiteralNode,
  type ParameterDeclaration,
} from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';
import { lastSignatureOf, type ShapeSignature } from './local-type-interface-members.ts';

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
 * The last written callable signature supplies the native receiver utility's result, as TypeScript
 * lists signatures (`lastSignatureOf`).
 */
export function receiverUtilityReading(
  at: TypeReading,
  operands: (reading: TypeReading) => readonly TypeReading[],
): TypeReading | undefined {
  return lastSignatureOf(at, operands, (reading) => {
    const { type } = reading;
    if (isFunctionTypeNode(type)) return { result: receiverReading(reading, type.parameters) };
    const members = isTypeLiteralNode(type) ? type.members : [];
    let found: ShapeSignature<TypeReading>;
    for (const member of members) {
      if (isCallSignatureDeclaration(member))
        found = { result: receiverReading(reading, member.parameters) };
    }
    return found;
  });
}
