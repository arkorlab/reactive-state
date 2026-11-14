import {
  type Expression,
  isArrowFunction,
  isFunctionExpression,
  isJsxExpression,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { isTypeOnly } from './scope.ts';

/**
 * Whether a constructor's defaults, and the expressions evaluated beside them, run nothing the
 * application wrote. The scan is as coarse as it can be: it does not follow what a construction
 * supplies, so a read that may run the application's code is work wherever it is written.
 */

/**
 * The kinds that run, or may run, the application's code. A member read, an element access and a
 * pattern take their value from what the construction supplies, which may be a getter, a proxy or an
 * iterator the compile does not follow: they are work, not data.
 */
const OPAQUE_EVALUATION: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayBindingPattern,
  SyntaxKind.AwaitExpression,
  SyntaxKind.BinaryExpression,
  SyntaxKind.CallExpression,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
  SyntaxKind.ComputedPropertyName,
  SyntaxKind.DeleteExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.GetAccessor,
  SyntaxKind.JsxSpreadAttribute,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.NewExpression,
  SyntaxKind.ObjectBindingPattern,
  SyntaxKind.PostfixUnaryExpression,
  SyntaxKind.PrefixUnaryExpression,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.SetAccessor,
  SyntaxKind.SpreadAssignment,
  SyntaxKind.SpreadElement,
  SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.TemplateExpression,
  SyntaxKind.YieldExpression,
]);

/** A JSX child spread, `{...items}`, which iterates what it spreads; an attribute spread is none. */
function spreadChild(node: Node): boolean {
  return isJsxExpression(node) && node.dotDotDotToken !== undefined;
}

/**
 * Whether the defaults of `parameters` and the expressions `evaluated` hold no work: names, literals
 * and what is written of them alone. A function written in a default is not run by it, and a type
 * is erased.
 */
export function framedConstructorDefaultEvaluation(
  parameters: readonly ParameterDeclaration[],
  evaluated: readonly Expression[],
): boolean {
  const pending: Node[] = [...parameters, ...evaluated];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node) || isArrowFunction(node) || isFunctionExpression(node)) continue;
    if (OPAQUE_EVALUATION.has(node.kind) || spreadChild(node)) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}
