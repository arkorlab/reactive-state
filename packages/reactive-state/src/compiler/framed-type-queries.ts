import {
  type Identifier,
  isComputedPropertyName,
  isDecorator,
  isIdentifier,
  isParameterDeclaration,
  isParenthesizedTypeNode,
  isSourceFile,
  isTypeReferenceNode,
  isUnionTypeNode,
  type Node,
  type ParameterDeclaration,
  type TypeNode,
  isSignatureDeclaration,
} from 'typescript/ast';

import { bindingIdentifiers } from './scope.ts';

/** Pure type-name and lexical-parameter queries retain the compiler's existing exports. */

/**
 * Whether `type` names one of `names`: `Date`, or a union of it, `Date | null` — of a type the code
 * writes; none of another, nor of none written.
 */
export function namesType(type: TypeNode | undefined, names: ReadonlySet<string>): boolean {
  let each = type;
  while (each !== undefined && isParenthesizedTypeNode(each)) {
    each = each.type;
  }
  if (each === undefined) {
    return false;
  }
  if (isUnionTypeNode(each)) {
    return each.types.some((member) => namesType(member, names));
  }
  return isTypeReferenceNode(each) && isIdentifier(each.typeName) && names.has(each.typeName.text);
}

/**
 * The parameter that binds `name` where it is read, where no block around it declares the name
 * (`declarationOf`) — by its name alone: none of one of a pattern, `({ name }: Options)`, whose
 * type is the whole's. A method's parameters are not in scope in its computed name or its
 * decorators, nor in a parameter's decorator, which run where the class is defined.
 */
export function parameterOf(name: Identifier): ParameterDeclaration | undefined {
  let within: Node = name;
  let inParameterDecorator = false;
  for (let at: Node = name.parent; !isSourceFile(at); within = at, at = at.parent) {
    // A node of no function holds no parameters, though it may hold a field of the name; nor does
    // a method's computed name or decorator, which run outside them.
    const outside = inParameterDecorator || isComputedPropertyName(within) || isDecorator(within);
    const parameters = !outside && isSignatureDeclaration(at) ? at.parameters : [];
    const parameter = parameters.find((each) =>
      bindingIdentifiers(each.name).some((bound) => bound.text === name.text),
    );
    if (parameter !== undefined) {
      return isIdentifier(parameter.name) ? parameter : undefined;
    }
    inParameterDecorator = isParameterDeclaration(at) && isDecorator(within);
  }
  return undefined;
}
