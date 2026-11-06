import {
  factory,
  SyntaxKind,
  type ClassDeclaration,
  type ClassExpression,
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
  type TypeNode,
  type TypeParameterDeclaration,
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
    ) {
      const { closing, reading } = instanceArguments(at, selected, type.typeArguments);
      return {
        ...reading,
        type: factory.createExpressionWithTypeArguments(type.exprName, closing),
      };
    }
  }
  const instance = factory.createTypeQueryNode(
    factory.createQualifiedName(type.exprName, factory.createIdentifier('prototype')),
  );
  return prototypeQueryBuiltin(instance) === undefined ? undefined : { ...at, type: instance };
}

/**
 * A class query's instance arguments: an instantiation's as written, and otherwise the class's own
 * parameters, the binders of its construct signature, closed as `closedBinders` closes them.
 */
function instanceArguments(
  at: TypeReading,
  declaration: ClassDeclaration | ClassExpression,
  written: readonly TypeNode[] | undefined,
): ClosedBinders {
  const parameters = declaration.typeParameters ?? [];
  return written !== undefined || parameters.length === 0
    ? { closing: written, reading: at }
    : closedBinders(at, parameters);
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
  return { ...closedBinders(at, parameters).reading, type };
}

interface ClosedBinders {
  readonly reading: Omit<TypeReading, 'type'>;
  /** What each binder closes at, as an argument written in its place. */
  readonly closing: readonly TypeNode[] | undefined;
}

/** Each own binder at its constraint, read where all of them are closed, or else at unknown. */
function closedBinders(
  at: TypeReading,
  parameters: readonly TypeParameterDeclaration[],
): ClosedBinders {
  const bindings = new Map(at.bindings);
  const closing = parameters.map((parameter) => {
    const constraint = constraintReading(parameter, { ...at, bindings });
    bindings.set(parameter, constraint ?? { ...at, bindings, type: UNKNOWN });
    return constraint === undefined ? UNKNOWN : (parameter.constraint ?? UNKNOWN);
  });
  return { closing, reading: { ...at, bindings } };
}
