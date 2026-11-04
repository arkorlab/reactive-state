import {
  type GetAccessorDeclaration,
  isCallSignatureDeclaration,
  isComputedPropertyName,
  isConstructSignatureDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodSignatureDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPropertySignatureDeclaration,
  isSetAccessorDeclaration,
  isStringLiteral,
  type MethodSignatureDeclaration,
  type PropertySignatureDeclaration,
  type SetAccessorDeclaration,
  SyntaxKind,
  type TypeElement,
  type TypeLiteralNode,
} from 'typescript/ast';

/** Written object members by their names, and a weak object type's need of a common one. */

/** Whether the property may be absent from the source object. */
export function optionalMember(member: TypeElement): boolean {
  return (
    (isPropertySignatureDeclaration(member) || isMethodSignatureDeclaration(member)) &&
    member.postfixToken?.kind === SyntaxKind.QuestionToken
  );
}

/** A literal property name, including literal computed names. */
export function memberName(member: TypeElement): string | undefined {
  if (!propertyMember(member)) return undefined;
  const { name } = member;
  const key = isComputedPropertyName(name) ? name.expression : name;
  if (isIdentifier(key) && !isComputedPropertyName(name)) return key.text;
  if (isStringLiteral(key) || isNoSubstitutionTemplateLiteral(key)) return key.text;
  return isNumericLiteral(key) ? String(Number(key.text)) : undefined;
}

/**
 * Whether written sources share no property with a weak target — one of members all optional
 * properties, and some — though they hold a property, or a call or construct signature, which
 * TypeScript's assignability refuses: `{ caption: string } extends { message?: string }` takes the
 * false branch. Unknown where a property's name is not written; none of a target that is not weak.
 */
export function weakMismatch(
  sources: readonly TypeLiteralNode[],
  target: TypeLiteralNode,
): boolean | undefined {
  if (target.members.length === 0 || !target.members.every((member) => optionalMember(member)))
    return false;
  const wanted = writtenNames(target.members);
  const held = writtenNames(sources.flatMap((source) => source.members));
  if (wanted === undefined || held === undefined) return undefined;
  if (held.some((name) => wanted.includes(name))) return false;
  return (
    held.length > 0 ||
    sources.some((source) => {
      return source.members.some(
        (member) => isCallSignatureDeclaration(member) || isConstructSignatureDeclaration(member),
      );
    })
  );
}

/** The names of written properties, methods and accessors; none where one is computed unknown. */
function writtenNames(members: readonly TypeElement[]): readonly string[] | undefined {
  const names: string[] = [];
  for (const member of members) {
    if (!propertyMember(member)) continue;
    const name = memberName(member);
    if (name === undefined) return undefined;
    names.push(name);
  }
  return names;
}

/** A member that is a property of the object: a property, a method or an accessor. */
export function propertyMember(
  member: TypeElement,
): member is
  | GetAccessorDeclaration
  | MethodSignatureDeclaration
  | PropertySignatureDeclaration
  | SetAccessorDeclaration {
  return (
    isPropertySignatureDeclaration(member) ||
    isMethodSignatureDeclaration(member) ||
    isGetAccessorDeclaration(member) ||
    isSetAccessorDeclaration(member)
  );
}
