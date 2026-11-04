import {
  isIdentifier,
  isIndexedAccessTypeNode,
  isMappedTypeNode,
  isParenthesizedTypeNode,
  isTypeOperatorNode,
  isTypeReferenceNode,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';
import type { TypeReading } from './local-type-environment.ts';

/** Identity homomorphic members select from their original operand rather than a synthetic shape. */

/** A written `[K in keyof T]: T[K]` retains the original T and its actual argument environment. */
export function homomorphicSourceReading(at: TypeReading): TypeReading | undefined {
  const { type } = at;
  if (!isMappedTypeNode(type) || type.nameType !== undefined || type.type === undefined)
    return undefined;
  const constraint = type.typeParameter.constraint;
  if (
    constraint === undefined ||
    !isTypeOperatorNode(constraint) ||
    constraint.operator !== SyntaxKind.KeyOfKeyword
  )
    return undefined;
  const body = unwrappedType(type.type);
  if (!isIndexedAccessTypeNode(body)) return undefined;
  const index = unwrappedType(body.indexType);
  if (
    !isTypeReferenceNode(index) ||
    !isIdentifier(index.typeName) ||
    index.typeArguments !== undefined ||
    index.typeName.text !== type.typeParameter.name.text
  )
    return undefined;
  return sameSource(constraint.type, body.objectType, type.typeParameter.name.text)
    ? { ...at, type: constraint.type }
    : undefined;
}

/** Only the same lexical source reference establishes an identity projection. */
function sameSource(first: TypeNode, second: TypeNode, mappedName: string): boolean {
  const left = unwrappedType(first);
  const right = unwrappedType(second);
  if (
    !isTypeReferenceNode(left) ||
    !isTypeReferenceNode(right) ||
    !isIdentifier(left.typeName) ||
    !isIdentifier(right.typeName) ||
    left.typeArguments !== undefined ||
    right.typeArguments !== undefined ||
    left.typeName.text === mappedName ||
    left.typeName.text !== right.typeName.text
  )
    return false;
  const binding = localTypeBinding(left.typeName);
  return binding !== undefined && binding !== null && binding === localTypeBinding(right.typeName);
}

/** Parentheses do not change the mapped source or selected key binding. */
function unwrappedType(type: TypeNode): TypeNode {
  let value = type;
  while (isParenthesizedTypeNode(value)) value = value.type;
  return value;
}
