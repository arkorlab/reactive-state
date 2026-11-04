import {
  factory,
  isCallSignatureDeclaration,
  isConstructorTypeNode,
  isConstructSignatureDeclaration,
  isFunctionTypeNode,
  isIdentifier,
  isIntersectionTypeNode,
  isTypeLiteralNode,
  type CallSignatureDeclaration,
  type ConstructorTypeNode,
  type ConstructSignatureDeclaration,
  type FunctionTypeNode,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { capturedSequence, type CapturedPosition } from './local-type-captured-sequences.ts';
import { constraintReading, type TypeReading } from './local-type-environment.ts';
import { interfaceShapeReadings } from './local-type-interface-members.ts';

/** Native argument tuple utilities select the last matching written signature. */

type Operands = (reading: TypeReading) => readonly TypeReading[];
type Utility = 'ConstructorParameters' | 'Parameters';

type Signature =
  | FunctionTypeNode
  | ConstructorTypeNode
  | CallSignatureDeclaration
  | ConstructSignatureDeclaration;
const UNKNOWN = factory.createKeywordTypeNode(SyntaxKind.UnknownKeyword);

/** Call and construct parameter tuples retain each position's original lexical environment. */
export function parameterUtilityReading(
  at: TypeReading,
  utility: Utility,
  operands: Operands,
): TypeReading | undefined {
  let result: TypeReading | undefined;
  let expandInterfaces = true;
  const pending = [at];
  for (let reading = pending.pop(); reading !== undefined; reading = pending.pop()) {
    const { type } = reading;
    const interfaces = expandInterfaces ? interfaceShapeReadings(reading, operands) : undefined;
    if (interfaces?.unknown === true) {
      expandInterfaces = false;
      result = undefined;
      pending.length = 0;
      pending.push(at);
      continue;
    }
    if (interfaces !== undefined) {
      pending.push(...interfaces.sources.toReversed());
      continue;
    }
    if (isIntersectionTypeNode(type)) {
      const signatures = type.types.flatMap((member) => operands({ ...reading, type: member }));
      pending.push(...signatures.toReversed());
      continue;
    }
    const signature = writtenSignature(type, utility);
    if (signature !== undefined)
      result = parameterSequence(signatureContext(reading, signature), signature.parameters);
  }
  return result;
}

/** Only matching call or construct signatures supply positions and their own generic binders. */
function writtenSignature(type: TypeReading['type'], utility: Utility): Signature | undefined {
  if (
    (utility === 'Parameters' && isFunctionTypeNode(type)) ||
    (utility === 'ConstructorParameters' && isConstructorTypeNode(type))
  )
    return type;
  if (!isTypeLiteralNode(type)) return undefined;
  let signature: Signature | undefined;
  for (const member of type.members) {
    if (
      (utility === 'Parameters' && isCallSignatureDeclaration(member)) ||
      (utility === 'ConstructorParameters' && isConstructSignatureDeclaration(member))
    )
      signature = member;
  }
  return signature;
}

/** Native inference closes own parameters at their written constraints or unknown, not defaults. */
function signatureContext(at: TypeReading, signature: Signature): TypeReading {
  const parameters = signature.typeParameters ?? [];
  if (parameters.length === 0) return at;
  const bindings = new Map(at.bindings);
  for (const parameter of parameters) {
    const constraint = constraintReading(parameter, { ...at, bindings });
    bindings.set(parameter, constraint ?? { ...at, bindings, type: UNKNOWN });
  }
  return { ...at, bindings };
}

/** A lone rest reuses its array or tuple reading; optional fixed positions keep their markers. */
function parameterSequence(
  context: TypeReading,
  parameters: readonly ParameterDeclaration[],
): TypeReading | undefined {
  const positions: CapturedPosition[] = [];
  for (const parameter of parameters) {
    if (isIdentifier(parameter.name) && parameter.name.text === 'this') continue;
    if (parameter.type === undefined) return undefined;
    positions.push({
      optional: parameter.questionToken !== undefined || parameter.initializer !== undefined,
      reading: { ...context, type: parameter.type },
      rest: parameter.dotDotDotToken !== undefined,
    });
  }
  const [only] = positions;
  return positions.length === 1 && only?.rest === true
    ? only.reading
    : capturedSequence(context, positions);
}
