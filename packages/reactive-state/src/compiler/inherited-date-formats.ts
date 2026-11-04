import {
  type ClassDeclaration,
  type ClassExpression,
  type Expression,
  isComputedPropertyName,
  isExpressionWithTypeArguments,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isStringLiteral,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { heritageReference } from './local-type-class-bases.ts';

/** Native formatter methods inherited through local classes and constant constructor aliases. */
export function inheritedDateFormat(node: Expression, member: string | undefined): boolean {
  const seen = new Set<Node>();
  let expression = node;
  for (;;) {
    const reference = heritageReference(expression);
    if (reference.builtin !== undefined) return reference.builtin === 'Intl.DateTimeFormat';
    const declared = reference.binding;
    if (declared === undefined || declared === null || seen.has(declared)) return false;
    seen.add(declared);
    if (member !== undefined && ownsFormat(declared, member)) return false;
    const base = declared.heritageClauses?.find(
      (clause) => clause.token === SyntaxKind.ExtendsKeyword,
    )?.types[0];
    if (base === undefined || !isExpressionWithTypeArguments(base)) return false;
    expression = base.expression;
  }
}

/** A written receiver member replaces the native formatter method at that name. */
function ownsFormat(declared: ClassDeclaration | ClassExpression, name: string): boolean {
  return declared.members.some((member) => {
    if (
      !isMethodDeclaration(member) &&
      !isPropertyDeclaration(member) &&
      !isGetAccessorDeclaration(member) &&
      !isSetAccessorDeclaration(member)
    )
      return false;
    if (isStaticOrDeclared(member)) return false;
    if (isComputedPropertyName(member.name)) {
      const own = unwrapped(member.name.expression);
      return (isStringLiteral(own) || isNoSubstitutionTemplateLiteral(own)) && own.text === name;
    }
    const own = member.name;
    return (
      (isIdentifier(own) || isStringLiteral(own) || isNoSubstitutionTemplateLiteral(own)) &&
      own.text === name
    );
  });
}

/** Static members and erased declare fields do not replace a constructed receiver member. */
function isStaticOrDeclared(node: Node): boolean {
  let found = false;
  node.forEachChild((child) => {
    if (child.kind === SyntaxKind.StaticKeyword || child.kind === SyntaxKind.DeclareKeyword)
      found = true;
  });
  return found;
}
