import {
  isIdentifier,
  isLiteralTypeNode,
  isParenthesizedTypeNode,
  isTemplateLiteralTypeNode,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  isUnionTypeNode,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';

/** The written types that name a text, a number, a boolean or a bigint, whatever the program does. */
const SCALAR_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
]);

/** What a union of scalars may also hold without making room for an array. */
const ABSENT_KEYWORDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.NullKeyword,
  SyntaxKind.UndefinedKeyword,
]);

/**
 * Whether a member of a union is `undefined` or `null`: the keyword, or the literal type `null` is
 * parsed as, which holds the keyword.
 */
function isAbsentType(member: TypeNode): boolean {
  return ABSENT_KEYWORDS.has(isLiteralTypeNode(member) ? member.literal.kind : member.kind);
}

/** How many local aliases are followed to a scalar: a longer chain, or a cycle, is read as no scalar. */
const ALIAS_DEPTH = 4;

/**
 * Whether a written type excludes every array because it names a text, a number, a boolean or a
 * bigint: the keyword, a literal type, a template literal type, a union of these (with `null` or
 * `undefined`), or a local alias without type parameters of one (`type Label = string`). A generic
 * alias, an import, an interface and every other type are not read as a scalar.
 */
export function isScalarType(written: TypeNode, depth = 0): boolean {
  let type = written;
  while (isParenthesizedTypeNode(type)) type = type.type;
  if (SCALAR_KEYWORDS.has(type.kind) || isTemplateLiteralTypeNode(type)) return true;
  if (isLiteralTypeNode(type)) return type.literal.kind !== SyntaxKind.NullKeyword;
  if (isUnionTypeNode(type)) {
    return (
      type.types.some((member) => !isAbsentType(member)) &&
      type.types.every((member) => isAbsentType(member) || isScalarType(member, depth))
    );
  }
  if (
    !isTypeReferenceNode(type) ||
    !isIdentifier(type.typeName) ||
    type.typeArguments !== undefined ||
    depth >= ALIAS_DEPTH
  )
    return false;
  const binding = localTypeBinding(type.typeName);
  return (
    binding !== undefined &&
    binding !== null &&
    isTypeAliasDeclaration(binding) &&
    binding.typeParameters === undefined &&
    isScalarType(binding.type, depth + 1)
  );
}
