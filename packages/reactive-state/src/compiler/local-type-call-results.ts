import {
  isCallSignatureDeclaration,
  isConstructSignatureDeclaration,
  isConstructorTypeNode,
  type CallSignatureDeclaration,
  type ConstructSignatureDeclaration,
  isFunctionTypeNode,
  isIntersectionTypeNode,
  isTypeLiteralNode,
} from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';
import { independentSignatureResult } from './local-type-independent-results.ts';
import { interfaceShapeReadings } from './local-type-interface-members.ts';

/** A source-written call result is selected only from one unambiguous written signature. */

type Operands = (reading: TypeReading) => readonly TypeReading[];

export interface CallResultSelection {
  readonly keys: readonly string[];
  readonly kind: 'call' | 'construct';
}

interface WrittenCallResult {
  readonly reading: TypeReading;
  readonly generic: boolean;
}

/** Overloads and unknown inherited shapes retain their existing unresolved-call boundary. */
export function singleCallResultReading(
  at: TypeReading,
  operands: Operands,
  kind: 'call' | 'construct' = 'call',
): WrittenCallResult | undefined {
  const results: WrittenCallResult[] = [];
  const pending = [at];
  for (let reading = pending.pop(); reading !== undefined; reading = pending.pop()) {
    const { type } = reading;
    const shapes = interfaceShapeReadings(reading, operands);
    if (shapes !== undefined) {
      if (shapes.unknown) return undefined;
      pending.push(...shapes.sources);
    } else if (isIntersectionTypeNode(type)) {
      pending.push(...type.types.flatMap((member) => operands({ ...reading, type: member })));
    } else {
      const written = writtenCallResults(reading, kind);
      if (written === undefined) return undefined;
      results.push(...written);
    }
    if (results.length > 1) return undefined;
  }
  return results[0];
}

/** One written call or construct signature contributes its result in the original lexical scope. */
function writtenCallResults(
  at: TypeReading,
  kind: 'call' | 'construct',
): readonly WrittenCallResult[] | undefined {
  const { type } = at;
  if (
    (kind === 'call' && isFunctionTypeNode(type)) ||
    (kind === 'construct' && isConstructorTypeNode(type))
  ) {
    return independentSignatureResult(type) && type.type !== undefined
      ? [{ generic: (type.typeParameters?.length ?? 0) > 0, reading: { ...at, type: type.type } }]
      : undefined;
  }
  if (!isTypeLiteralNode(type)) return undefined;
  const signatures = type.members.filter(
    (member): member is CallSignatureDeclaration | ConstructSignatureDeclaration => {
      return kind === 'call'
        ? isCallSignatureDeclaration(member)
        : isConstructSignatureDeclaration(member);
    },
  );
  if (signatures.some((signature) => !independentSignatureResult(signature))) return undefined;
  return signatures.flatMap((signature) => {
    return signature.type === undefined
      ? []
      : [
          {
            generic: (signature.typeParameters?.length ?? 0) > 0,
            reading: { ...at, type: signature.type },
          },
        ];
  });
}
