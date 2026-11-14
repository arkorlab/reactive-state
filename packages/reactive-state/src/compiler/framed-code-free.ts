import { type Node, SyntaxKind } from 'typescript/ast';

/** The kinds of node that run no code but their parts': a name, a literal, a plain statement. */
const CODE_FREE: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.AsExpression,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.Block,
  SyntaxKind.BreakStatement,
  SyntaxKind.CaseBlock,
  SyntaxKind.CaseClause,
  SyntaxKind.CatchClause,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
  SyntaxKind.ClassStaticBlockDeclaration,
  SyntaxKind.ConditionalExpression,
  SyntaxKind.ContinueStatement,
  SyntaxKind.DefaultClause,
  SyntaxKind.EmptyStatement,
  SyntaxKind.ExpressionStatement,
  SyntaxKind.FalseKeyword,
  SyntaxKind.FunctionExpression,
  SyntaxKind.Identifier,
  SyntaxKind.IfStatement,
  SyntaxKind.LabeledStatement,
  SyntaxKind.NonNullExpression,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.PropertyAssignment,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.ReturnStatement,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.ShorthandPropertyAssignment,
  SyntaxKind.StringLiteral,
  SyntaxKind.SwitchStatement,
  SyntaxKind.ThisKeyword,
  SyntaxKind.ThrowStatement,
  SyntaxKind.TrueKeyword,
  SyntaxKind.TryStatement,
  SyntaxKind.TypeAssertionExpression,
  SyntaxKind.VariableDeclaration,
  SyntaxKind.VariableDeclarationList,
  SyntaxKind.VariableStatement,
]);

/** Whether a node runs no code but its parts': any other may call a getter, a trap or a method. */
export function isCodeFree(node: Node): boolean {
  return CODE_FREE.has(node.kind);
}
