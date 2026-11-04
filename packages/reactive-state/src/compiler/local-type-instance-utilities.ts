import {
  factory,
  SyntaxKind,
  type ConstructorTypeNode,
  type ConstructSignatureDeclaration,
  isConstructSignatureDeclaration,
  isConstructorTypeNode,
  isIntersectionTypeNode,
  isIdentifier,
  isClassDeclaration,
  isClassExpression,
  isTypeLiteralNode,
  isTypeQueryNode,
} from 'typescript/ast';

import { heritageReference } from './local-type-class-bases.ts';
import { constraintReading, type TypeReading } from './local-type-environment.ts';
import { interfaceShapeReadings } from './local-type-interface-members.ts';
import { prototypeQueryBuiltin } from './local-type-prototype-queries.ts';

/** Native instance utilities retain written constructor results and native error prototypes. */

type Operands = (reading: TypeReading) => readonly TypeReading[];
const UNKNOWN = factory.createKeywordTypeNode(SyntaxKind.UnknownKeyword);

/** The last matching written construct signature supplies its original instance environment. */
export function instanceUtilityReading(
  at: TypeReading,
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
    } else if (isIntersectionTypeNode(type)) {
      const signatures = type.types.flatMap((member) => operands({ ...reading, type: member }));
      pending.push(...signatures.toReversed());
    } else {
      result = writtenInstanceReading(reading) ?? result;
    }
  }
  return result;
}

/** Written instance results, with native constructor queries reusing their original value scope. */
function writtenInstanceReading(at: TypeReading): TypeReading | undefined {
  const { type } = at;
  if (isConstructorTypeNode(type)) return constructorResultReading(at, type);
  if (isTypeLiteralNode(type)) {
    let result: TypeReading | undefined;
    for (const member of type.members) {
      if (isConstructSignatureDeclaration(member))
        result = constructorResultReading(at, member) ?? result;
    }
    return result;
  }
  if (!isTypeQueryNode(type)) return undefined;
  if (isIdentifier(type.exprName)) {
    const selected = heritageReference(type.exprName).binding;
    if (
      selected !== undefined &&
      selected !== null &&
      (isClassDeclaration(selected) || isClassExpression(selected))
    )
      return {
        ...at,
        type: factory.createExpressionWithTypeArguments(type.exprName, type.typeArguments),
      };
  }
  const instance = factory.createTypeQueryNode(
    factory.createQualifiedName(type.exprName, factory.createIdentifier('prototype')),
  );
  return prototypeQueryBuiltin(instance) === undefined ? undefined : { ...at, type: instance };
}

/** Native instance inference closes own binders at constraints or unknown, never defaults. */
function constructorResultReading(
  at: TypeReading,
  signature: ConstructorTypeNode | ConstructSignatureDeclaration,
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
