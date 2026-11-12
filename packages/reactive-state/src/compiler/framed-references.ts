import {
  type BigIntLiteral,
  type Identifier,
  isBigIntLiteral,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isExpressionWithTypeArguments,
  isIdentifier,
  isMetaProperty,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTypeNode,
  type Node,
  type NoSubstitutionTemplateLiteral,
  type NumericLiteral,
  type PrivateIdentifier,
  type StringLiteral,
  SyntaxKind,
} from 'typescript/ast';

import { holderOf } from './framed-function-names.ts';
import { readsBinding } from './scope.ts';

/**
 * What a node reads and writes by a name: a variable, or a property by its name, written out as an
 * identifier, a private name, or a literal key; the call it is what calls; and what is a type and
 * no value.
 */

/** Whether a node is a type and no value: the expression a class extends is a value. */
export function isTypeOnly(node: Node): boolean {
  return isTypeNode(node) && !isExpressionWithTypeArguments(node);
}

/** The name an identifier or a private name reads: a variable's, or a property's by its name. */
function readName(node: Identifier | PrivateIdentifier): string | undefined {
  const { parent } = node;
  if (isPropertyAccessExpression(parent) && parent.name === node) return node.text;
  if (!isIdentifier(node)) return undefined;
  if (!isShorthandPropertyAssignment(parent) && (parent as { name?: Node }).name === node)
    return undefined;
  return readsBinding(node) ? node.text : undefined;
}

/** The name a node reads, if it reads one: a variable, or a property by its name. */
export function referenceText(node: Node): string | undefined {
  if (isMetaProperty(node))
    return node.keywordToken === SyntaxKind.NewKeyword ? 'constructor' : undefined;
  if (isIdentifier(node) || isPrivateIdentifier(node)) return readName(node);
  return isLiteralKey(node) ? literalText(node as KeyLiteral) : undefined;
}

/** The literals a property is named by: a string, a template without substitutions, a number. */
type KeyLiteral = BigIntLiteral | NoSubstitutionTemplateLiteral | NumericLiteral | StringLiteral;

/** Whether a node is a literal that names a property. */
function isLiteral(node: Node): node is KeyLiteral {
  return (
    isStringLiteral(node) ||
    isNoSubstitutionTemplateLiteral(node) ||
    isNumericLiteral(node) ||
    isBigIntLiteral(node)
  );
}

/** The property a literal names: a big integer's is its digits. */
function literalText(node: KeyLiteral): string {
  return isBigIntLiteral(node) ? node.text.replace(/n$/u, '') : node.text;
}

/** Whether a node is a literal an element access names its property by, past type wrappers. */
function isLiteralKey(node: Node): boolean {
  if (!isLiteral(node)) return false;
  const held = holderOf(node);
  return isElementAccessExpression(held.parent) && held.parent.argumentExpression === held;
}

/**
 * The call, construction or tag that a node, the name of a reference, is what it calls: the name
 * itself, a property's, or either of them through `call` or `apply`.
 */
function callOf(node: Node): Node | undefined {
  let at = holderOf(node);
  if ((isPropertyAccessExpression(at.parent) && at.parent.name === at) || isLiteralKey(node))
    at = holderOf(at.parent);
  if (isPropertyAccessExpression(at.parent) && at.parent.expression === at) {
    const via = at.parent.name.text;
    if (via !== 'call' && via !== 'apply') return undefined;
    at = holderOf(at.parent);
  }
  const { parent } = at;
  return ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === at) ||
    (isTaggedTemplateExpression(parent) && parent.tag === at)
    ? parent
    : undefined;
}

/** Whether a node, the name of a reference, is what a call, a construction or a tag calls. */
export function called(node: Node): boolean {
  return callOf(node) !== undefined;
}

/** Whether a node, the name of a reference, is what a call calls whose result is dropped. */
export function droppedCall(node: Node): boolean {
  const call = callOf(node);
  return call !== undefined && isExpressionStatement(call.parent);
}

/**
 * Whether a reference is a name that is written to, and not read: a variable, or a property by its
 * name. A write of a property that calls a setter is found by the setter, which is reached from
 * anywhere, whatever the name.
 */
export function written(node: Node): boolean {
  const { parent } = node;
  let target = node;
  if (isPropertyAccessExpression(parent) && parent.name === node) target = parent;
  else if (isLiteralKey(node)) target = holderOf(node).parent;
  const held = holderOf(target);
  return (
    isBinaryExpression(held.parent) &&
    held.parent.left === held &&
    held.parent.operatorToken.kind === SyntaxKind.EqualsToken
  );
}
