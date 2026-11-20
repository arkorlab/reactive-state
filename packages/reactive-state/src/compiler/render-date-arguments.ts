import {
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isVoidExpression,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { frameMemberName } from './framed-bindings.ts';
import { freshIntlReceiver, wholeIntlConstant } from './render-intl-receivers.ts';

/** Immutable undefined argument aliases retain a fresh native formatter's clock input. */

/** The added alias proof requires the original member's unchanged native receiver. */
export function aliasedDateFormatClock(
  node: Node,
  native: (callee: Expression, member: string) => boolean,
): boolean {
  if (!isPropertyAccessExpression(node) && !isElementAccessExpression(node)) return false;
  const member = frameMemberName(node);
  if (member !== 'format' && member !== 'formatToParts') return false;
  const { at, parent } = useOf(node);
  if (!isCallExpression(parent) || parent.expression !== at) return false;
  const first = parent.arguments[0];
  if (first === undefined || !isIdentifier(unwrapped(first)) || !missingDateAlias(first))
    return false;
  const receiver = freshIntlReceiver(node.expression, node);
  return receiver !== undefined && native(receiver.expression, member);
}

/** Only whole constant chains to lexical native undefined or void supply this new proof. */
function missingDateAlias(node: Expression): boolean {
  const seen = new Set<Expression>();
  let value = unwrapped(node);
  while (!seen.has(value)) {
    seen.add(value);
    if (isVoidExpression(value) || globalPathOf(value)?.join('.') === 'undefined') return true;
    if (!isIdentifier(value)) return false;
    const initializer = wholeIntlConstant(value)?.initializer;
    if (initializer === undefined) return false;
    value = unwrapped(initializer);
  }
  return false;
}
