import {
  type HeritageClauseElement,
  type InterfaceDeclaration,
  isEnumDeclaration,
  isIdentifier,
  isIntersectionTypeNode,
  isParenthesizedTypeNode,
  isPropertySignatureDeclaration,
  isQualifiedName,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  type Node,
  SyntaxKind,
  type TypeElement,
  type TypeNode,
  type TypeReferenceNode,
} from 'typescript/ast';

import { type MembersKind, membersKind } from './object-kinds.ts';
import { declarationOf, isLanguageType, type TypeReading, type TypeSite } from './type-names.ts';

/**
 * What the members of a type written in the application's code are, as `kinds.ts` reads them: the
 * type a member is written of, through aliases, intersections and what an interface extends; and
 * what an interface's members, its bases' too, tell of its values' kind (`object-kinds.ts`).
 */

/** A state's type as its code writes it, and where; and whether what it is of may be left out. */
export interface WrittenType {
  /** The type, where the compile reads it; none where the code types it in a way it cannot read. */
  readonly type: TypeNode | undefined;
  readonly at: TypeSite;
  /** Of a prop that may be left out (`initial?: string`), which holds `undefined` then. */
  readonly optional: boolean;
  /**
   * Of a start the compile cannot read the type of — `initial ?? 'all'`, `options[key]`, a constant,
   * a call — which TypeScript types, and a type argument tells the compile.
   */
  readonly unreadStart?: boolean;
}

/**
 * The type the member `name` of `type` is written of — a type literal's property, an interface's,
 * its bases' too, an intersection's parts', an alias's followed, `Readonly<T>`'s and `Partial<T>`'s
 * of `T` — none where it cannot be read.
 */
export function memberOf(
  type: TypeNode,
  name: string,
  at: TypeSite,
  reading: TypeReading,
): WrittenType | undefined {
  let node = type;
  while (isParenthesizedTypeNode(node)) {
    node = node.type;
  }
  if (isTypeLiteralNode(node)) {
    return propertyOf(node.members, name, at);
  }
  if (isIntersectionTypeNode(node)) {
    let member: WrittenType | undefined;
    for (const part of node.types) {
      const found = memberOf(part, name, at, reading);
      if (found !== undefined) {
        member =
          member === undefined ? found : { ...member, optional: member.optional && found.optional };
      }
    }
    return member;
  }
  return isTypeReferenceNode(node) ? referencedMember(node, name, at, reading) : undefined;
}

/** Every matching union member a list key may read, each in its own declaration context. */
export function memberTypes(
  type: TypeNode,
  name: string,
  at: TypeSite,
  reading: TypeReading,
): readonly WrittenType[] {
  let node = type;
  while (isParenthesizedTypeNode(node)) {
    node = node.type;
  }
  if (isUnionTypeNode(node)) {
    return node.types.flatMap((part) => memberTypes(part, name, at, reading));
  }
  if (isTypeReferenceNode(node)) {
    return referencedTypes(node, name, at, reading);
  }
  const member = memberOf(node, name, at, reading);
  return member === undefined ? [] : [member];
}

/** Aliases and the language's transparent wrappers retain each alternative's own scope. */
function referencedTypes(
  reference: TypeReferenceNode,
  name: string,
  at: TypeSite,
  reading: TypeReading,
): readonly WrittenType[] {
  if (isLanguageType(reference.typeName, at)) {
    const language = isIdentifier(reference.typeName) ? reference.typeName.text : '';
    const [argument] = reference.typeArguments ?? [];
    if (argument === undefined || (language !== 'Readonly' && language !== 'Partial')) {
      return [];
    }
    return memberTypes(argument, name, at, reading).map((member) => {
      const optional = member.optional || language === 'Partial';
      return { ...member, optional };
    });
  }
  const declared = declarationOf(reference.typeName, at, reading);
  if (declared !== undefined && isTypeAliasDeclaration(declared.declaration)) {
    const { declaration } = declared;
    return declaration.typeParameters === undefined
      ? (within(declaration, reading, () =>
          memberTypes(declaration.type, name, declared.at, reading),
        ) ?? [])
      : [];
  }
  const member = memberOf(reference, name, at, reading);
  return member === undefined ? [] : [member];
}

/** The member `name` of the type `reference` names, as `memberOf` reads it. */
function referencedMember(
  reference: TypeReferenceNode,
  name: string,
  at: TypeSite,
  reading: TypeReading,
): WrittenType | undefined {
  if (isLanguageType(reference.typeName, at)) {
    const language = isIdentifier(reference.typeName) ? reference.typeName.text : '';
    const [argument] = reference.typeArguments ?? [];
    const kept = language === 'Readonly' || language === 'Partial';
    const member =
      argument !== undefined && kept ? memberOf(argument, name, at, reading) : undefined;
    return member === undefined
      ? undefined
      : { ...member, optional: member.optional || language === 'Partial' };
  }
  const declared = declarationOf(reference.typeName, at, reading);
  if (declared === undefined || isEnumDeclaration(declared.declaration)) {
    return undefined;
  }
  const { declaration } = declared;
  if (isTypeAliasDeclaration(declaration)) {
    return declaration.typeParameters === undefined
      ? within(declaration, reading, () => memberOf(declaration.type, name, declared.at, reading))
      : undefined;
  }
  return interfaceMember(declaration, name, declared.at, reading);
}

/**
 * The member `name` of the interface `declaration`: its own, or of what it extends — none of one of
 * type parameters (`Box<T>`), which the compile gives no arguments, as of an alias of them.
 */
function interfaceMember(
  declaration: InterfaceDeclaration,
  name: string,
  at: TypeSite,
  reading: TypeReading,
): WrittenType | undefined {
  if (declaration.typeParameters !== undefined) {
    return undefined;
  }
  const own = propertyOf(declaration.members, name, at);
  const clauses = declaration.heritageClauses;
  if (own !== undefined || clauses === undefined) {
    return own;
  }
  const bases = clauses.flatMap((clause) => [...clause.types]);
  return within(declaration, reading, () => {
    let inherited: WrittenType | undefined;
    for (const base of bases) {
      inherited ??= baseMember(base, name, at, reading);
    }
    return inherited;
  });
}

/** The member `name` of `base`, an interface another extends, as `interfaceMember` reads it. */
function baseMember(
  base: HeritageClauseElement,
  name: string,
  at: TypeSite,
  reading: TypeReading,
): WrittenType | undefined {
  const typeName = isTypeReferenceNode(base) ? base.typeName : base.expression;
  const declared =
    isIdentifier(typeName) || isQualifiedName(typeName)
      ? declarationOf(typeName, at, reading)
      : undefined;
  return declared === undefined || !isInterface(declared.declaration)
    ? undefined
    : interfaceMember(declared.declaration, name, declared.at, reading);
}

/** A member of a type, and where it is written. */
export interface SitedMember {
  readonly member: TypeElement;
  readonly at: TypeSite;
}

/**
 * What the members of the interface `declaration` tell of its values' kind (`membersKind`), with
 * those of what it extends: none where it extends what the compile cannot read.
 */
export function interfaceMembersKind(
  declaration: InterfaceDeclaration,
  at: TypeSite,
  reading: TypeReading,
): MembersKind | undefined {
  const members = interfaceMembers(declaration, at, reading);
  return members === undefined ? undefined : membersKind(members.map(({ member }) => member));
}

/**
 * The members of the interface `declaration`, with those of what it extends — an interface, or an
 * alias of a type literal — each where it is written: none where it extends what the compile cannot
 * read, nor of an interface of type parameters (`Box<T>`), which the compile gives no arguments, as
 * of an alias of them.
 */
export function interfaceMembers(
  declaration: InterfaceDeclaration,
  at: TypeSite,
  reading: TypeReading,
): readonly SitedMember[] | undefined {
  if (declaration.typeParameters !== undefined) {
    return undefined;
  }
  const members: SitedMember[] = declaration.members.map((member) => ({ at, member }));
  const bases = (declaration.heritageClauses ?? []).flatMap((clause) => [...clause.types]);
  for (const base of bases) {
    const inherited = within(declaration, reading, () => baseMembers(base, at, reading));
    if (inherited === undefined) {
      return undefined;
    }
    members.push(...inherited);
  }
  return members;
}

/** The members of `base`, which an interface extends, as `interfaceMembers` reads them. */
function baseMembers(
  base: HeritageClauseElement,
  at: TypeSite,
  reading: TypeReading,
): readonly SitedMember[] | undefined {
  const typeName = isTypeReferenceNode(base) ? base.typeName : base.expression;
  const declared =
    isIdentifier(typeName) || isQualifiedName(typeName)
      ? declarationOf(typeName, at, reading)
      : undefined;
  if (declared === undefined) {
    return undefined;
  }
  const { declaration } = declared;
  if (isInterface(declaration)) {
    return interfaceMembers(declaration, declared.at, reading);
  }
  return isTypeAliasDeclaration(declaration) &&
    declaration.typeParameters === undefined &&
    isTypeLiteralNode(declaration.type)
    ? declaration.type.members.map((member) => ({ at: declared.at, member }))
    : undefined;
}

export function isInterface(declaration: Node): declaration is InterfaceDeclaration {
  return declaration.kind === SyntaxKind.InterfaceDeclaration;
}

/** The property `name` of `members`, as its type writes it; none of one it does not type. */
function propertyOf(
  members: readonly TypeElement[],
  name: string,
  at: TypeSite,
): WrittenType | undefined {
  const member = members.find((each) => {
    return (
      isPropertySignatureDeclaration(each) &&
      (isIdentifier(each.name) || isStringLiteral(each.name)) &&
      each.name.text === name
    );
  });
  if (member === undefined || !isPropertySignatureDeclaration(member)) {
    return undefined;
  }
  const type = member.type as TypeNode | undefined;
  const optional = member.postfixToken?.kind === SyntaxKind.QuestionToken;
  return { at, optional, type };
}

/** What `read` answers, `declaration` under way while it does: none where it is already. */
export function within<T>(
  declaration: Node,
  reading: TypeReading,
  read: () => T | undefined,
): T | undefined {
  if (reading.aliases.has(declaration)) {
    return undefined;
  }
  reading.aliases.add(declaration);
  try {
    return read();
  } finally {
    reading.aliases.delete(declaration);
  }
}
