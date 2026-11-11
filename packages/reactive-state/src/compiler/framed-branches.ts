import {
  isClassStaticBlockDeclaration,
  isConditionalExpression,
  isIfStatement,
  isSourceFile,
  type Node,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { framedCondition } from './framed-sources.ts';

/** The arm a written constant condition rules out; unknown conditions retain both arms. */
function unselectedBranch(node: Node): Node | undefined {
  if (isIfStatement(node)) {
    const condition = framedCondition(node.expression);
    if (condition === undefined) return undefined;
    return condition ? node.elseStatement : node.thenStatement;
  }
  if (isConditionalExpression(node)) {
    const condition = framedCondition(node.condition);
    if (condition === undefined) return undefined;
    return condition ? node.whenFalse : node.whenTrue;
  }
  return undefined;
}

/** A source-proven unselected if or conditional arm cannot supply a receiver. */
export function framedPossibleBranch(node: Node): boolean {
  for (let parent = node.parent, within = node; ; within = parent, parent = parent.parent) {
    if (isSourceFile(parent) || isAnswering(parent) || isClassStaticBlockDeclaration(parent))
      return true;
    if (within === unselectedBranch(parent)) return false;
  }
}
