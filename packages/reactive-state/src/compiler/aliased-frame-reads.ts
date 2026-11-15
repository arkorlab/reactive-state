import {
  type Expression,
  isBindingElement,
  isElementAccessExpression,
  isIdentifier,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isVariableDeclaration,
  type Node,
} from 'typescript/ast';

import { literalName, unwrapped } from './bounded.ts';
import { patternKey } from './code-globals.ts';
import { declarationOf, parameterOf } from './framed.ts';
import { namesLocalMemberType } from './local-type-reading.ts';

/**
 * The frames a route reads of a declared error through a local type alias: the same error classes
 * and frame members `framed.ts` recognizes, with no inference from an arbitrary data field's name.
 */

const ERRORS: ReadonlySet<string> = new Set([
  'AggregateError',
  'DOMException',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

const FRAMED: ReadonlySet<string> = new Set(['columnNumber', 'fileName', 'lineNumber', 'stack']);

/** The frame member `node` reads of an error declared through a local type alias. */
export function aliasedFrameRead(node: Node): string | undefined {
  if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
    const name = isPropertyAccessExpression(node) ? node.name.text : literalName(node);
    return name !== undefined && FRAMED.has(name) && declaredError(node.expression)
      ? name
      : undefined;
  }
  if (!isBindingElement(node) || !isObjectBindingPattern(node.parent)) {
    return undefined;
  }
  const name = patternKey(node);
  const declaration = node.parent.parent;
  return name !== undefined &&
    FRAMED.has(name) &&
    isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    declaredError(declaration.initializer)
    ? name
    : undefined;
}

/** Whether `value` names an error declared through aliases, following its variables' initializers. */
function declaredError(value: Expression): boolean {
  const seen = new Set<string>();
  for (let each = unwrapped(value); isIdentifier(each) && !seen.has(each.text);) {
    seen.add(each.text);
    const declaration = declarationOf(each);
    if (declaration === undefined) {
      return namesLocalMemberType(parameterOf(each)?.type, [], ERRORS);
    }
    if (!isVariableDeclaration(declaration)) {
      return false;
    }
    if (namesLocalMemberType(declaration.type, [], ERRORS)) {
      return true;
    }
    if (declaration.initializer === undefined) {
      return false;
    }
    each = unwrapped(declaration.initializer);
  }
  return false;
}
