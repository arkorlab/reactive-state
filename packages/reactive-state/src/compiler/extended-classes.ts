import {
  type ClassLikeDeclaration,
  type Expression,
  isClassDeclaration,
  isClassExpression,
  isExpressionWithTypeArguments,
  isIdentifier,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { declarationOf } from './framed.ts';

/**
 * What a class `value` extends, where `value` is a class expression or a name a class declares: the
 * expressions of its `extends` clause (none for a class that extends nothing). A class that extends
 * a global is constructed, and its static members are read, as that global, whatever constructor it
 * writes, which only refuses more where a `super(…)` call changes the arguments. Undefined where
 * `value` is no class.
 */
export function extendedOf(value: Expression): readonly Expression[] | undefined {
  if (isClassExpression(value)) {
    return basesOf(value);
  }
  const declared = isIdentifier(value) ? declarationOf(value) : undefined;
  return declared !== undefined && isClassDeclaration(declared) ? basesOf(declared) : undefined;
}

/** The expressions a class declaration or expression names after `extends`. */
function basesOf(declared: ClassLikeDeclaration): readonly Expression[] {
  const { heritageClauses } = declared;
  if (heritageClauses === undefined) {
    return [];
  }
  const found: Expression[] = [];
  for (const clause of heritageClauses) {
    if (clause.token === SyntaxKind.ExtendsKeyword) {
      found.push(...clause.types.flatMap((type) => typeBases(type)));
    }
  }

  return found;
}

/** The expression of a heritage clause element, which is none of a type alone. */
function typeBases(type: Node): readonly Expression[] {
  return isExpressionWithTypeArguments(type) ? [type.expression] : [];
}
