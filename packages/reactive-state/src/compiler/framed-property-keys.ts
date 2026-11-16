import {
  type Expression,
  isBindingElement,
  isBinaryExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { framedGroupByKeyText } from './framed-groupby-key-text.ts';
import { framedKeyArrayWords } from './framed-key-array-words.ts';
import { framedKeyOperation } from './framed-key-operations.ts';

/** Runtime property-key conversions may expose a supplied error's engine-written words. */
export function framedPropertyKey(
  node: Node,
  words: (value: Expression, keys?: readonly string[]) => boolean,
  typed: (value: Expression) => boolean,
): boolean {
  const converted = (value: Expression, keys?: readonly string[]) => {
    return (
      words(value, keys) ||
      ((keys?.length ?? 0) === 0 && framedKeyArrayWords(value, node, { error: words, typed }))
    );
  };
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.InKeyword)
    return converted(node.left);
  if (framedGroupByKeyText(node, words, typed)) return true;
  if (framedKeyOperation(node, converted, typed)) return true;
  if (isElementAccessExpression(node)) return converted(node.argumentExpression);
  if (!isComputedPropertyName(node)) return false;
  const member = node.parent;
  if (isPropertyAssignment(member) || isBindingElement(member)) return converted(node.expression);
  if (isPropertyDeclaration(member)) {
    const erased = member.modifiers?.some(
      (modifier) =>
        modifier.kind === SyntaxKind.DeclareKeyword || modifier.kind === SyntaxKind.AbstractKeyword,
    );
    return erased !== true && converted(node.expression);
  }
  return (
    (isMethodDeclaration(member) ||
      isGetAccessorDeclaration(member) ||
      isSetAccessorDeclaration(member)) &&
    member.body !== undefined &&
    converted(node.expression)
  );
}
