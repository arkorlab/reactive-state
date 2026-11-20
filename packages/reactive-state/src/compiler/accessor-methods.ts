import {
  type ClassLikeDeclaration,
  type Expression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { literalKey } from './exported-values.ts';
import { declarationOf } from './framed.ts';

/** A class's written definition method is application code, rather than Object's legacy method. */
export function ownsAccessorDefinition(receiver: Expression, name: string): boolean {
  if ((name !== '__defineGetter__' && name !== '__defineSetter__') || !isNewExpression(receiver)) {
    return false;
  }
  const target = unwrapped(receiver.expression);
  const owner = isIdentifier(target) ? declarationOf(target) : target;
  if (
    owner === undefined ||
    !(isClassDeclaration(owner) || isClassExpression(owner)) ||
    !hasOrdinaryPrototype(owner)
  ) {
    return false;
  }
  return owner.members.some((member) => {
    if (
      !isMethodDeclaration(member) ||
      member.modifiers?.some((modifier) => modifier.kind === SyntaxKind.StaticKeyword) === true
    ) {
      return false;
    }
    const key = isComputedPropertyName(member.name)
      ? unwrapped(member.name.expression)
      : member.name;
    return (isIdentifier(key) ? key.text : literalKey(key)) === name;
  });
}

/** Implicit construction leaves this class's prototype in place; no initializer replaces it. */
function hasOrdinaryPrototype(owner: ClassLikeDeclaration): boolean {
  return (
    (owner.heritageClauses?.length ?? 0) === 0 &&
    owner.modifiers?.some((modifier) => modifier.kind === SyntaxKind.Decorator) !== true &&
    owner.members.every((member) => {
      return (
        isMethodDeclaration(member) &&
        member.modifiers?.some((modifier) => modifier.kind === SyntaxKind.Decorator) !== true &&
        (!isComputedPropertyName(member.name) ||
          literalKey(unwrapped(member.name.expression)) !== undefined)
      );
    })
  );
}
