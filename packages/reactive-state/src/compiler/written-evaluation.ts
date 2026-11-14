import {
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isNewExpression,
  isPropertyAccessExpression,
  isTaggedTemplateExpression,
  type Node,
} from 'typescript/ast';

/** Whether application evaluation between a written value and its use may have changed it. */
export function interveningEvaluation(value: Expression, at: Expression): boolean {
  if (value.getSourceFile() !== at.getSourceFile()) {
    return true;
  }
  const from = value.end;
  const before = at.pos;
  if (before <= from) {
    return false;
  }
  let changed = false;
  const visit = (node: Node): void => {
    if (changed || node.end <= from || node.pos >= before) {
      return;
    }
    if (node.pos >= from && node.end <= before && evaluatesApplication(node)) {
      changed = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(value.getSourceFile());
  return changed;
}

/** Whether evaluating a node can execute application code through a call, construction or read. */
function evaluatesApplication(node: Node): boolean {
  return (
    isCallExpression(node) ||
    isNewExpression(node) ||
    isPropertyAccessExpression(node) ||
    isElementAccessExpression(node) ||
    isTaggedTemplateExpression(node)
  );
}

/** Whether an expression includes evaluation that can change an aliased value before a later use. */
export function includesApplication(node: Node): boolean {
  let found = false;
  const visit = (each: Node): void => {
    if (found) {
      return;
    }
    found = evaluatesApplication(each);
    if (!found) {
      each.forEachChild(visit);
    }
  };
  visit(node);
  return found;
}
