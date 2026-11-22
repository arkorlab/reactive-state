import {
  isIdentifier,
  isIndexSignatureDeclaration,
  isLiteralTypeNode,
  isNoSubstitutionTemplateLiteral,
  isParenthesizedTypeNode,
  isPropertySignatureDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  SyntaxKind,
  type TypeElement,
  type TypeNode,
  type TypeReferenceNode,
} from 'typescript/ast';

import { type MemberShape, shapeOf } from './object-kinds.ts';
import { interfaceMembers, isInterface, within } from './type-members.ts';
import { declarationOf, isLanguageType, type TypeReading, type TypeSite } from './type-names.ts';

/**
 * The members of an object's type, as what tells its kind (`object-kinds.ts`) and what admits no
 * JSON (`json-types.ts`) read them: a type literal's, an interface's with what it extends, an
 * alias's followed — and those the language's own types make of their arguments, as TypeScript
 * maps them: `Partial<T>`, each left out; `Required<T>`, none; `Readonly<T>`, as they are;
 * `Pick<T, K>`, those `K` names, none where `K` names what `T` has no member of; `Omit<T, K>`, the
 * others; each of these without what calls or constructs `T`, which a mapped type keeps none of;
 * and `Record<K, V>`, one of each name of text `K` holds, or an index.
 */

/** A member of an object's type, and the type of its values, each where it is written. */
export interface ObjectMember {
  readonly shape: MemberShape;
  readonly at: TypeSite;
  /** The member as its code writes it; none of one `Record<K, V>` makes. */
  readonly member: TypeElement | undefined;
  /** The type of its values — a property's, an index's; `V` of `Record<K, V>` — where written. */
  readonly value: TypeNode | undefined;
}

/** The language's own types that make the members of their first argument's, as mapped types do. */
const MAPPED: ReadonlySet<string> = new Set(['Omit', 'Partial', 'Pick', 'Readonly', 'Required']);

/**
 * The language's own types of objects alone, whose members `membersOf` reads: `Partial<T>` — not
 * `Readonly<T>`, of an array too.
 */
export const LANGUAGE_OBJECTS: ReadonlySet<string> = new Set([
  'Omit',
  'Partial',
  'Pick',
  'Record',
  'Required',
]);

/**
 * The members of the object's type `type`, each where it is written; none where it is no object's
 * type the compile reads the members of — a union, an intersection, a package's type.
 */
export function membersOf(
  type: TypeNode,
  at: TypeSite,
  reading: TypeReading,
): readonly ObjectMember[] | undefined {
  let node = type;
  while (isParenthesizedTypeNode(node)) {
    node = node.type;
  }
  if (isTypeLiteralNode(node)) {
    return node.members.map((member) => objectMember(member, at));
  }
  if (!isTypeReferenceNode(node)) {
    return undefined;
  }
  if (isLanguageType(node.typeName, at)) {
    return languageMembers(node, at, reading);
  }
  const declared = declarationOf(node.typeName, at, reading);
  if (declared === undefined) {
    return undefined;
  }
  const { declaration } = declared;
  if (isInterface(declaration)) {
    return interfaceMembers(declaration, declared.at, reading)?.map(({ at: where, member }) =>
      objectMember(member, where),
    );
  }
  return isTypeAliasDeclaration(declaration) && declaration.typeParameters === undefined
    ? within(declaration, reading, () => membersOf(declaration.type, declared.at, reading))
    : undefined;
}

function objectMember(member: TypeElement, at: TypeSite): ObjectMember {
  // A property typed of nothing is of no type the compile reads.
  const value =
    isPropertySignatureDeclaration(member) || isIndexSignatureDeclaration(member)
      ? (member.type as TypeNode | undefined)
      : undefined;
  return { at, member, shape: shapeOf(member), value };
}

/** The members a type of the language's own makes, as `membersOf` reads them. */
function languageMembers(
  reference: TypeReferenceNode,
  at: TypeSite,
  reading: TypeReading,
): readonly ObjectMember[] | undefined {
  const name = isIdentifier(reference.typeName) ? reference.typeName.text : '';
  const [first, second] = reference.typeArguments ?? [];
  if (first === undefined) {
    return undefined;
  }
  if (name === 'Record') {
    return second === undefined ? undefined : recordMembers(first, second, at, reading);
  }
  const members = MAPPED.has(name) ? membersOf(first, at, reading) : undefined;
  if (members === undefined) {
    return undefined;
  }
  const mapped = members.filter(({ shape }) => !shape.called);
  if (name === 'Pick' || name === 'Omit') {
    const keys = second === undefined ? undefined : textKeys(second, at, reading);
    // A key `Pick` is given that names no member is one an index supplies, which is not read.
    return keys === undefined || (name === 'Pick' && !namesAll(keys, mapped))
      ? undefined
      : mapped.filter(
          ({ shape }) => (shape.name !== undefined && keys.has(shape.name)) === (name === 'Pick'),
        );
  }
  if (name === 'Readonly') {
    return mapped;
  }
  return mapped.map((member) => {
    const { shape } = member;
    return { ...member, shape: { ...shape, optional: name === 'Partial' && !shape.textIndex } };
  });
}

/** Whether each of `keys` is the name of one of `members`. */
function namesAll(keys: ReadonlySet<string>, members: readonly ObjectMember[]): boolean {
  return [...keys].every((key) => members.some(({ shape }) => shape.name === key));
}

/**
 * The members `Record<K, V>` makes: an index of text, of `K` of `string`; one of each name a union
 * of text holds, `'id' | 'title'`; one of no name, which tells nothing, of `number`; none the
 * compile reads of another `K`.
 */
function recordMembers(
  keys: TypeNode,
  value: TypeNode,
  at: TypeSite,
  reading: TypeReading,
): readonly ObjectMember[] | undefined {
  const made = (shape: Partial<MemberShape>): ObjectMember => {
    const none: MemberShape = { called: false, name: undefined, optional: false, textIndex: false };
    return { at, member: undefined, shape: { ...none, ...shape }, value };
  };
  if (keys.kind === SyntaxKind.StringKeyword) {
    return [made({ textIndex: true })];
  }
  if (keys.kind === SyntaxKind.NumberKeyword) {
    return [made({})];
  }
  const names = textKeys(keys, at, reading);
  return names === undefined ? undefined : [...names].map((name) => made({ name }));
}

/**
 * The names a union of literals of text holds — `'id' | 'title'`, an alias of one followed — none
 * of another type.
 */
function textKeys(
  type: TypeNode,
  at: TypeSite,
  reading: TypeReading,
): ReadonlySet<string> | undefined {
  let node = type;
  while (isParenthesizedTypeNode(node)) {
    node = node.type;
  }
  if (isTypeReferenceNode(node)) {
    const declared = declarationOf(node.typeName, at, reading);
    const declaration = declared?.declaration;
    return declared === undefined ||
      declaration === undefined ||
      !isTypeAliasDeclaration(declaration) ||
      declaration.typeParameters !== undefined
      ? undefined
      : within(declaration, reading, () => textKeys(declaration.type, declared.at, reading));
  }
  const keys = new Set<string>();
  const types = isUnionTypeNode(node) ? node.types : [node];
  for (const each of types) {
    if (
      !isLiteralTypeNode(each) ||
      !(isStringLiteral(each.literal) || isNoSubstitutionTemplateLiteral(each.literal))
    ) {
      return undefined;
    }
    keys.add(each.literal.text);
  }
  return keys;
}
