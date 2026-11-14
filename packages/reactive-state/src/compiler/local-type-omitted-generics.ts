import {
  factory,
  SyntaxKind,
  type CallSignatureDeclaration,
  type FunctionTypeNode,
} from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';
import { actualQueryArgument } from './local-type-query-argument-scope.ts';

/** Native receiver erasure retains closed written generic parameters and results. */

export interface OmittedCallableReading {
  readonly reading: TypeReading;
  readonly signature: FunctionTypeNode | CallSignatureDeclaration;
  readonly unknown?: boolean;
}
const UNKNOWN = factory.createKeywordTypeNode(SyntaxKind.UnknownKeyword);

/** An own generic parameter erases to its closed constraint or unknown, never its declaration default. */
export function omittedGenericReading(
  selected: OmittedCallableReading,
  receiver: TypeReading,
  original: TypeReading,
): TypeReading | undefined {
  const parameters = selected.signature.typeParameters;
  if (parameters === undefined || parameters.length === 0) return selected.reading;
  if (selected.unknown === true || !actualQueryArgument(receiver)) return undefined;
  const bindings = new Map(selected.reading.bindings);
  for (const parameter of parameters) {
    const actual = { ...selected.reading, type: parameter.constraint ?? UNKNOWN };
    if (!actualQueryArgument(actual)) return undefined;
    bindings.set(parameter, actual);
  }
  if (!actualQueryArgument({ ...original, bindings })) return undefined;
  return { ...selected.reading, bindings };
}
