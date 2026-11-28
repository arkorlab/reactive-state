/**
 * Whether a write runs before a read the same function makes, on every path to it: a statement of
 * the read's own execution owner, reached through blocks and the arms a source-proven condition
 * selects. Split from `framed-map-mutations.ts` for its length.
 */
import { isBlock, isExpressionStatement, isIfStatement, type Node } from 'typescript/ast';

import { executionOwner } from './framed-array-mutations.ts';
import { framedCondition } from './framed-sources.ts';

/** The same lexical owner and source-proven selected if arms establish an executed prefix. */
export function definiteBefore(node: Node, read: Node, owner: Node): boolean {
  if (executionOwner(node) !== owner || node.end > read.pos || !isExpressionStatement(node.parent))
    return false;
  let within: Node = node.parent;
  for (;;) {
    const parent = within.parent;
    if (parent === owner) return true;
    if (isBlock(parent)) {
      within = parent;
      continue;
    }
    if (!isIfStatement(parent)) return false;
    const condition = framedCondition(parent.expression);
    if (condition === undefined) return false;
    const chosen: Node | undefined = condition ? parent.thenStatement : parent.elseStatement;
    if (within !== chosen) return false;
    within = parent;
  }
}
