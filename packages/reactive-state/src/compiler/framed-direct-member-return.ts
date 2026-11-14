import {
  type Expression,
  isBlock,
  isElementAccessExpression,
  isExpressionStatement,
  isPropertyAccessExpression,
  isReturnStatement,
  isStringLiteral,
} from 'typescript/ast';

import type { Answering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedQuietPrimitive } from './framed-native-evaluation.ts';

/** Additional local receiver origins require a direct returned member path without earlier application work. */

/** A literal directive and a single returned member chain do not introduce a callable or mutation prefix. */
export function framedDirectMemberReturn(node: Expression, owner: Answering): boolean {
  const { body } = owner;
  if (body === undefined || !isBlock(body)) return false;
  const statements = [...body.statements];
  const returned = statements.pop();
  if (
    returned === undefined ||
    !isReturnStatement(returned) ||
    returned.expression === undefined ||
    statements.some(
      (statement) => !isExpressionStatement(statement) || !isStringLiteral(statement.expression),
    )
  )
    return false;
  let value = unwrapped(returned.expression);
  while (value !== unwrapped(node)) {
    if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return false;
    if (isElementAccessExpression(value) && !framedQuietPrimitive(value.argumentExpression))
      return false;
    if (frameMemberName(value) === undefined) return false;
    value = unwrapped(value.expression);
  }
  return true;
}
