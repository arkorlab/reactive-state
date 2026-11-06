import {
  type ClassDeclaration,
  type ClassExpression,
  isArrowFunction,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isDecorator,
  isExpressionWithTypeArguments,
  isFunctionLikeDeclaration,
  isParameterDeclaration,
  isTypeNode,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

/** Reads of the surrounding middleware receiver, excluding receivers inner functions and classes own. */
export function middlewareThisRead(node: Node): Node | undefined {
  const pending = [node];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isTypeNode(at) && !isExpressionWithTypeArguments(at)) continue;
    if (at.kind === SyntaxKind.ThisKeyword) return at;
    if (isClassDeclaration(at) || isClassExpression(at)) {
      pending.push(...definitionHeaders(at));
    } else if (isFunctionLikeDeclaration(at) && !isArrowFunction(at)) {
      pending.push(...outerHeaders(at));
    } else {
      at.forEachChild((child) => {
        pending.push(child);
      });
    }
  }
  return undefined;
}

/** Decorators and computed names run outside a member's own receiver binding. */
function outerHeaders(node: Node): Node[] {
  const headers: Node[] = [];
  node.forEachChild((child) => {
    if (isDecorator(child) || isComputedPropertyName(child)) {
      headers.push(child);
    } else if (isParameterDeclaration(child)) {
      child.forEachChild((part) => {
        if (isDecorator(part)) headers.push(part);
      });
    }
  });
  return headers;
}

/** A class owns field, static and method receivers, while its definition evaluates outer headers. */
function definitionHeaders(node: ClassDeclaration | ClassExpression): readonly Node[] {
  const headers = outerHeaders(node);
  const heritage = node.heritageClauses;
  if (heritage !== undefined) {
    for (const clause of heritage) {
      if (clause.token !== SyntaxKind.ExtendsKeyword) continue;
      for (const base of clause.types) {
        if (isExpressionWithTypeArguments(base)) headers.push(base.expression);
      }
    }
  }
  for (const member of node.members) headers.push(...outerHeaders(member));
  return headers;
}
