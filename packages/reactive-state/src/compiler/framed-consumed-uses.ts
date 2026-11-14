import {
  isBinaryExpression,
  isPrefixUnaryExpression,
  isTaggedTemplateExpression,
  isTemplateSpan,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { COPIERS, isFirstArgument, readsWithoutCallback } from './framed-array-callbacks.ts';
import { nativePath } from './framed-mutator-calls.ts';

/** The operators that read both operands as numbers or as texts and answer a number, a text or a boolean. */
const OPERANDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandToken,
  SyntaxKind.AsteriskAsteriskToken,
  SyntaxKind.AsteriskToken,
  SyntaxKind.BarToken,
  SyntaxKind.CaretToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
  SyntaxKind.GreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  SyntaxKind.GreaterThanGreaterThanToken,
  SyntaxKind.GreaterThanToken,
  SyntaxKind.LessThanEqualsToken,
  SyntaxKind.LessThanLessThanToken,
  SyntaxKind.LessThanToken,
  SyntaxKind.MinusToken,
  SyntaxKind.PercentToken,
  SyntaxKind.PlusToken,
  SyntaxKind.SlashToken,
]);

/**
 * Whether a member read of an array is consumed where it stands: converted to text by a template, an
 * operator that answers a number, a text or a boolean, a minus or a plus before it, or a native that
 * reads it and runs no function of the program and answers none of it (a native that copies, or
 * answers the descriptors, gives the parts of what it reads on). What it gives is not kept, handed to a
 * function or written through, so a list the member holds stays where the readers of the writes follow it.
 */
export function consumed(result: Node): boolean {
  const { parent } = result;
  if (isTemplateSpan(parent)) return !isTaggedTemplateExpression(parent.parent.parent);
  if (isBinaryExpression(parent)) return OPERANDS.has(parent.operatorToken.kind);
  if (isPrefixUnaryExpression(parent))
    return (
      parent.operator !== SyntaxKind.PlusPlusToken && parent.operator !== SyntaxKind.MinusMinusToken
    );
  if (!isFirstArgument(parent, result)) return false;
  const path = nativePath(parent.expression);
  return path !== undefined && !COPIERS.has(path) && readsWithoutCallback(parent, path);
}
