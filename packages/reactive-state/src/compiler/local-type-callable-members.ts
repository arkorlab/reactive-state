import {
  factory,
  type FunctionTypeNode,
  type MethodSignatureDeclaration,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

/** Selected method values preserve their callable signatures and original lexical type nodes. */

const GROUPS = new WeakMap<MethodSignatureDeclaration, TypeNode>();
const METHODS = new WeakMap<MethodSignatureDeclaration, FunctionTypeNode>();

/** Overloads retain source order as callable intersections, never as their return types. */
export function selectedMethodType(methods: readonly MethodSignatureDeclaration[]): TypeNode {
  const first = methods[0];
  const previous = first === undefined ? undefined : GROUPS.get(first);
  if (previous !== undefined) return previous;
  const signatures = methods.map((method) => methodValue(method));
  const only = signatures.length === 1 ? signatures[0] : undefined;
  const result = only ?? factory.createIntersectionTypeNode(signatures);
  if (first !== undefined) GROUPS.set(first, result);
  return result;
}

/** Stable containers retain original parameters, type parameters and result annotations. */
function methodValue(method: MethodSignatureDeclaration): FunctionTypeNode {
  const previous = METHODS.get(method);
  if (previous !== undefined) return previous;
  const value = factory.createFunctionTypeNode(
    method.typeParameters,
    method.parameters,
    method.type ?? factory.createKeywordTypeNode(SyntaxKind.UnknownKeyword),
  );
  METHODS.set(method, value);
  return value;
}
