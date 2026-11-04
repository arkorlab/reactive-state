import {
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTemplateExpression,
  type Node,
  type ObjectLiteralExpression,
  type PropertyAssignment,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { isTypeOnly } from './scope.ts';

/** The special literal prototype entry; computed, method and shorthand names remain own entries. */
export function isPrototypeEntry(property: Node): property is PropertyAssignment {
  return (
    isPropertyAssignment(property) &&
    (isIdentifier(property.name) || isStringLiteral(property.name)) &&
    property.name.text === '__proto__'
  );
}

/** The literal expression that supplies an object's prototype, if written. */
export function prototypeInitializer(object: ObjectLiteralExpression): Expression | undefined {
  for (const property of object.properties) {
    if (isPrototypeEntry(property)) {
      return property.initializer;
    }
  }
  return undefined;
}

/** Later startup work can replace prototype members before an exported object is consumed. */
export function laterPrototypeWork(value: Expression): boolean {
  const visit = (node: Node): true | undefined => {
    if (node.end <= value.end || isTypeOnly(node)) {
      return undefined;
    }
    if (isAnswering(node) || isSetAccessorDeclaration(node)) {
      const name = 'name' in node ? node.name : undefined;
      return name !== undefined && isComputedPropertyName(name)
        ? visit(name.expression)
        : undefined;
    }
    if (node.pos >= value.end && executesApplication(node)) {
      return true;
    }
    return node.forEachChild(visit);
  };
  return visit(value.getSourceFile()) === true;
}

/** Calls, reads and implicit conversions after construction leave a retained prototype unproven. */
function executesApplication(node: Node): boolean {
  return (
    isCallExpression(node) ||
    isNewExpression(node) ||
    isPropertyAccessExpression(node) ||
    isElementAccessExpression(node) ||
    isTaggedTemplateExpression(node) ||
    isClassDeclaration(node) ||
    isClassExpression(node) ||
    isBinaryExpression(node) ||
    isPrefixUnaryExpression(node) ||
    isPostfixUnaryExpression(node) ||
    isTemplateExpression(node) ||
    isComputedPropertyName(node) ||
    isSpreadAssignment(node) ||
    isSpreadElement(node)
  );
}
