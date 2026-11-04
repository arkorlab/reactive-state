import {
  isArrayLiteralExpression,
  isBinaryExpression,
  isForInStatement,
  isForOfStatement,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isSourceFile,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

/**
 * Where a destructuring pattern's own work runs: after what it destructures — a declaration's or a
 * parameter's initializer, an assignment's right side, a `for…of` or `for…in` iterable — though the
 * pattern's defaults, computed keys and targets are written before it.
 */

/** Whether `node` lies in what a destructuring pattern around `read` destructures, which runs first. */
export function destructuredFirst(node: Node, read: Node): boolean {
  for (let within = read; !isSourceFile(within); within = within.parent) {
    const source = destructured(within.parent, within);
    if (source !== undefined && contains(source, node)) return true;
  }
  return false;
}

/** Whether `node` is a destructuring pattern, or a loop's binding, whose source holds `consumer`. */
export function patternAfter(node: Node, consumer: Node): boolean {
  const source = isSourceFile(node) ? undefined : destructured(node.parent, node);
  return source !== undefined && contains(source, consumer);
}

/** What the pattern `within` destructures, where `at` holds that pattern. */
function destructured(at: Node, within: Node): Node | undefined {
  if ((isVariableDeclaration(at) || isParameterDeclaration(at)) && within === at.name)
    return at.initializer;
  if ((isForOfStatement(at) || isForInStatement(at)) && within === at.initializer)
    return at.expression;
  return isBinaryExpression(at) &&
    within === at.left &&
    at.operatorToken.kind === SyntaxKind.EqualsToken &&
    (isObjectLiteralExpression(at.left) || isArrayLiteralExpression(at.left))
    ? at.right
    : undefined;
}

/** Whether `inner` lies in `outer`, both of one syntax tree. */
function contains(outer: Node, inner: Node): boolean {
  return inner.pos >= outer.pos && inner.end <= outer.end;
}
