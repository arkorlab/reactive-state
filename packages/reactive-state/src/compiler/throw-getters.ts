import {
  type Expression,
  type GetAccessorDeclaration,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isComputedPropertyName,
  isDeleteExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isGetAccessorDeclaration,
  isIdentifier,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  isSpreadElement,
  isTypeAssertion,
  type Node,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { literalKey } from './exported-values.ts';
import type { Resolve } from './numbers.ts';
import { writtenOf } from './throw-shapes.ts';
import { interveningEvaluation } from './written-evaluation.ts';

/** The source getter a read invokes, where a literal object's last own descriptor proves it. */
export function ownReadGetter(
  node: Node,
  resolve: Resolve | undefined,
): GetAccessorDeclaration | undefined {
  if ((!isPropertyAccessExpression(node) && !isElementAccessExpression(node)) || writesOnly(node)) {
    return undefined;
  }
  const key = isPropertyAccessExpression(node)
    ? node.name.text
    : literalKey(writtenOf(node.argumentExpression, resolve));
  const object = writtenOf(node.expression, resolve);
  if (
    key === undefined ||
    !isObjectLiteralExpression(object) ||
    interveningEvaluation(object, node)
  ) {
    return undefined;
  }
  return ownGetter(object, key, resolve);
}

/** A later setter preserves a getter, while a later data member or method replaces it. */
function ownGetter(
  object: ObjectLiteralExpression,
  key: string,
  resolve: Resolve | undefined,
): GetAccessorDeclaration | undefined {
  for (const property of object.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return undefined;
    }
    const name = ownKey(property.name, resolve);
    if (name === undefined) {
      return undefined;
    }
    if (name !== key || isSetAccessorDeclaration(property)) {
      continue;
    }
    return isGetAccessorDeclaration(property) ? property : undefined;
  }
  return undefined;
}

/** An ordinary name is literal; a computed name follows only its written primitive key. */
function ownKey(name: PropertyName, resolve: Resolve | undefined): string | undefined {
  if (isIdentifier(name)) {
    return name.text;
  }
  return literalKey(isComputedPropertyName(name) ? writtenOf(name.expression, resolve) : name);
}

/** A plain assignment or deletion obtains a reference without reading its getter. */
function writesOnly(node: Expression): boolean {
  let value: Node = node;
  let reference = true;
  for (;;) {
    const { parent } = value;
    if (
      (isParenthesizedExpression(parent) ||
        isNonNullExpression(parent) ||
        isAsExpression(parent) ||
        isSatisfiesExpression(parent) ||
        isTypeAssertion(parent)) &&
      parent.expression === value
    ) {
      value = parent;
      continue;
    }
    if (targetContainer(value, parent)) {
      value = parent;
      reference = false;
      continue;
    }
    return (
      (isBinaryExpression(parent) &&
        parent.operatorToken.kind === SyntaxKind.EqualsToken &&
        parent.left === value) ||
      ((isForOfStatement(parent) || isForInStatement(parent)) && parent.initializer === value) ||
      (reference && isDeleteExpression(parent) && parent.expression === value)
    );
  }
}

/** Literal assignment patterns preserve their member targets until the surrounding assignment. */
function targetContainer(value: Node, parent: Node): boolean {
  return (
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === value) ||
    ((isSpreadAssignment(parent) || isSpreadElement(parent)) && parent.expression === value)
  );
}
