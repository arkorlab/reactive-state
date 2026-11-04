import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isNewExpression,
  isElementAccessExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isTaggedTemplateExpression,
  type Node,
} from 'typescript/ast';

import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { isTypedKind, typedOf, writtenOf } from './throw-shapes.ts';

/** Whether freezing or sealing a written view throws because it has indexed elements. */
export function locksViewThrows(
  path: string,
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  if (
    (path !== 'Object.freeze' && path !== 'Object.seal') ||
    given.length !== 1 ||
    given.some((each) => isSpreadElement(each))
  ) {
    return false;
  }
  const [first] = given;
  return first !== undefined && nonemptyView(first, resolve);
}

/** Whether a written typed array, including a literal-backed factory, has at least one element. */
function nonemptyView(node: Expression, resolve: Resolve | undefined): boolean {
  let current = node;
  const seen = new Set<Expression>();
  for (;;) {
    const value = writtenOf(current, resolve);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (mayHaveChanged(value, node)) {
      return false;
    }
    if (isCallExpression(value)) {
      return nonemptyFactory(value, resolve);
    }
    if (!isNewExpression(value)) {
      return false;
    }
    const path = globalCalleePath(value.expression, resolve)?.join('.');
    const view = typedOf(value, resolve, path);
    if (view?.length !== undefined) {
      return view.length > 0;
    }
    const args = value.arguments ?? [];
    const [first] = args;
    if (view === undefined || first === undefined || args.length !== 1 || isSpreadElement(first)) {
      return false;
    }
    current = first;
  }
}

/** Whether intervening application evaluation may detach or resize a retained view's buffer. */
function mayHaveChanged(value: Expression, at: Expression): boolean {
  if (value.getSourceFile() !== at.getSourceFile()) {
    return true;
  }
  const from = value.end;
  const before = at.parent.pos;
  if (before <= from) {
    return false;
  }
  let changed = false;
  const visit = (each: Node): void => {
    if (changed || each.end <= from || each.pos >= before) {
      return;
    }
    if (each.pos >= from && each.end <= before && canChangeView(each)) {
      changed = true;
      return;
    }
    each.forEachChild(visit);
  };
  visit(value.getSourceFile());
  return changed;
}

/** Whether evaluating a node can execute application code that changes a view kept elsewhere. */
function canChangeView(node: Node): boolean {
  return (
    isCallExpression(node) ||
    isNewExpression(node) ||
    isPropertyAccessExpression(node) ||
    isElementAccessExpression(node) ||
    isTaggedTemplateExpression(node)
  );
}

/** Whether a typed-array factory keeps a nonempty list of arguments or literal source elements. */
function nonemptyFactory(call: CallExpression, resolve: Resolve | undefined): boolean {
  const path = globalCalleePath(call.expression, resolve) ?? [];
  const [kind = '', method] = path;
  if (
    path.length !== 2 ||
    !isTypedKind(kind) ||
    call.arguments.some((each) => isSpreadElement(each))
  ) {
    return false;
  }
  if (method === 'of') {
    return call.arguments.length > 0;
  }
  const [first] = call.arguments;
  if (method !== 'from' || first === undefined || call.arguments.length !== 1) {
    return false;
  }
  const source = writtenOf(first, resolve);
  return (
    isArrayLiteralExpression(source) &&
    source.elements.length > 0 &&
    !source.elements.some((each) => isSpreadElement(each))
  );
}
