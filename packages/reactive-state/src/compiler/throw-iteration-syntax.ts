import { isForOfStatement, isSpreadElement, isYieldExpression, type Node } from 'typescript/ast';

import type { Resolve } from './numbers.ts';
import { skipsEvaluation } from './skipped-evaluation.ts';
import { nonIterableWritten } from './throw-collections.ts';

/** Written non-iterables requested by spread, for-of and delegated synchronous yield syntax. */
export function iterationSyntaxThrows(node: Node, resolve: Resolve | undefined): boolean {
  if (isSpreadElement(node) || isForOfStatement(node)) {
    return !skipsEvaluation(node, resolve) && nonIterableWritten(node.expression, resolve);
  }
  return (
    isYieldExpression(node) &&
    node.asteriskToken !== undefined &&
    node.expression !== undefined &&
    !skipsEvaluation(node, resolve) &&
    nonIterableWritten(node.expression, resolve)
  );
}
