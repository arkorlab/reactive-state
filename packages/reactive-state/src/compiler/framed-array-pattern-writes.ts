import {
  type Expression,
  isBinaryExpression,
  isElementAccessExpression,
  isForOfStatement,
  isExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import {
  type AssignedFrameSource,
  assignmentPatternDefault,
  assignmentPatternTargets,
  iteratedFrameSources,
} from './framed-assignment-patterns.ts';

/** Pattern and iteration assignments keep the selected value of each written array element. */
export function arrayPatternSources(
  node: Node,
  matches: (target: Expression) => boolean,
): readonly AssignedFrameSource[] {
  let target: Expression;
  let sources: readonly AssignedFrameSource[];
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
    if (assignmentPatternDefault(node)) return [];
    target = node.left;
    sources = [{ value: node.right, keys: [] }];
  } else if (isForOfStatement(node) && isExpression(node.initializer)) {
    target = node.initializer;
    sources = iteratedFrameSources(node.expression);
  } else return [];
  const result: AssignedFrameSource[] = [];
  const pending = [{ target, sources }];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = unwrapped(at.target);
    if (isElementAccessExpression(value)) {
      if (matches(value)) result.push(...at.sources);
    } else pending.push(...assignmentPatternTargets(value, at.sources));
  }
  return result;
}
