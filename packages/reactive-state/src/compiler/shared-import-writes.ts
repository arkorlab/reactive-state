import {
  type Expression,
  type Identifier,
  isAsExpression,
  isElementAccessExpression,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  type Node,
} from 'typescript/ast';

import { writtenBy } from './written.ts';

/**
 * Whether `identifier`, an import of a shared module's, is written where it stands: itself or a
 * member of it written as `writtenBy` reads a write — assigned, counted, deleted, the target of a
 * loop of no declaration, changed in place by a method that changes what it is called on, or given
 * first to a function of a global's that changes what it is given. A cast, a parenthesis or a `!`
 * around it, or around a member of it, is the same value. Not one it is handed to a function of the
 * application's, or copies: what a function does with an argument is that function's, and a copy is
 * the code's own.
 */
export function isWrittenAt(identifier: Identifier): boolean {
  const rooted = new Set<Node>();
  let node: Expression = identifier;
  for (;;) {
    rooted.add(node);
    const { parent } = node;
    if (
      isParenthesizedExpression(parent) ||
      isNonNullExpression(parent) ||
      isAsExpression(parent) ||
      isSatisfiesExpression(parent) ||
      ((isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
        parent.expression === node)
    ) {
      node = parent;
    } else {
      const written = writtenBy(parent);
      return written !== undefined && rooted.has(written);
    }
  }
}
