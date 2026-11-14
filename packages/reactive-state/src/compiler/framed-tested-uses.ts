import {
  isBinaryExpression,
  isConditionalExpression,
  isDoStatement,
  isIfStatement,
  isPrefixUnaryExpression,
  isTypeOfExpression,
  isVoidExpression,
  isWhileStatement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

/** The comparisons that read no more than the identity of their operands. */
const IDENTITY: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
]);

/** Whether a mention is only tested: a condition, a negation, `typeof`, an identity or an `in`. */
export function tested(at: Node): boolean {
  const { parent } = at;
  if (isIfStatement(parent) || isWhileStatement(parent) || isDoStatement(parent))
    return parent.expression === at;
  if (isConditionalExpression(parent)) return parent.condition === at;
  if (isPrefixUnaryExpression(parent)) return parent.operator === SyntaxKind.ExclamationToken;
  if (isTypeOfExpression(parent) || isVoidExpression(parent)) return true;
  if (!isBinaryExpression(parent)) return false;
  const { kind } = parent.operatorToken;
  return IDENTITY.has(kind) || (kind === SyntaxKind.InKeyword && parent.right === at);
}
