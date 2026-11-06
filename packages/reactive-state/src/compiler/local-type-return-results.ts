import {
  factory,
  SyntaxKind,
  type CallSignatureDeclaration,
  type FunctionTypeNode,
} from 'typescript/ast';

import { constraintReading, type TypeReading } from './local-type-environment.ts';

const UNKNOWN = factory.createKeywordTypeNode(SyntaxKind.UnknownKeyword);

/** Native ReturnType instantiates own generic binders at their constraints or unknown, not defaults. */
export function writtenReturnReading(
  at: TypeReading,
  signature: FunctionTypeNode | CallSignatureDeclaration,
): TypeReading | undefined {
  const { type } = signature;
  if (type === undefined) return undefined;
  const parameters = signature.typeParameters ?? [];
  if (parameters.length === 0) return { ...at, type };
  const bindings = new Map(at.bindings);
  for (const parameter of parameters) {
    const constraint = constraintReading(parameter, { ...at, bindings });
    bindings.set(parameter, constraint ?? { ...at, bindings, type: UNKNOWN });
  }
  return { ...at, bindings, type };
}
