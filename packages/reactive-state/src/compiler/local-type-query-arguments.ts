import {
  factory,
  isFunctionTypeNode,
  isTypeQueryNode,
  SyntaxKind,
  type FunctionTypeNode,
  type TypeParameterDeclaration,
} from 'typescript/ast';

import type { TypeReading } from './local-type-environment.ts';
import { actualQueryArgument } from './local-type-query-argument-scope.ts';

/** Explicit callable query arguments retain their written caller and declaration environments. */

const APPLIED = new WeakMap<FunctionTypeNode, FunctionTypeNode>();

/** Written argument counts retain matching generic signatures without inferring a call's arguments. */
export function acceptsQueryArguments(
  signature: { readonly typeParameters?: readonly TypeParameterDeclaration[] },
  count: number,
): boolean {
  const parameters = signature.typeParameters;
  return (
    parameters !== undefined &&
    count <= parameters.length &&
    parameters.slice(count).every((parameter) => parameter.defaultType !== undefined)
  );
}

/** Only one resolved written function is specialized; compound and opaque shapes keep their boundary. */
export function queryArgumentReadings(
  query: TypeReading,
  selected: readonly TypeReading[],
  operands: (reading: TypeReading) => readonly TypeReading[],
): readonly TypeReading[] {
  const args = isTypeQueryNode(query.type) ? query.type.typeArguments : undefined;
  const [only] = selected;
  if (args === undefined || only === undefined || args.length === 0 || selected.length !== 1)
    return selected;
  const sources = operands(only);
  const [reading] = sources;
  if (
    reading === undefined ||
    sources.length !== 1 ||
    !isFunctionTypeNode(reading.type) ||
    !acceptsQueryArguments(reading.type, args.length)
  )
    return selected;
  const signature = reading.type;
  const parameters = signature.typeParameters;
  if (parameters === undefined) return selected;
  const bindings = new Map(reading.bindings);
  for (const [index, parameter] of parameters.entries()) {
    const argument = args[index];
    const type = argument ?? parameter.defaultType;
    if (type === undefined) return selected;
    const actual = argument === undefined ? { ...reading, bindings, type } : { ...query, type };
    if (!actualQueryArgument(actual)) return selected;
    bindings.set(parameter, actual);
  }
  let type = APPLIED.get(signature);
  if (type === undefined) {
    type = factory.createFunctionTypeNode(
      undefined,
      signature.parameters,
      signature.type ?? factory.createKeywordTypeNode(SyntaxKind.UnknownKeyword),
    );
    APPLIED.set(signature, type);
  }
  return [{ ...reading, bindings, type }];
}
