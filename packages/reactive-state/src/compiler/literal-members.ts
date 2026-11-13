import {
  type Expression,
  isArrowFunction,
  isClassExpression,
  isComputedPropertyName,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';

/** What an object written has of a member, by what its entries write, in order: the last of them is the member. */

/**
 * The member of an object written: a function the code writes for it (`function`), none (`absent`),
 * or one whose value the code does not show (`unknown`) — an entry of the name that is no function
 * written, a getter, a spread or a name it computes after, a prototype set where it has none of its own.
 */
export type Member = 'absent' | 'function' | 'unknown';

/** The name an entry of an object written gives, where the code writes it; none of a computed one or a spread. */
function nameOf(
  property: ObjectLiteralElementLike,
  textOf: (node: Node) => string | undefined,
): string | undefined {
  if (isSpreadAssignment(property)) {
    return undefined;
  }
  const { name } = property;
  if (isIdentifier(name)) {
    return name.text;
  }
  return textOf(isComputedPropertyName(name) ? unwrapped(name.expression) : name);
}

/** Whether `expression` is a function the code writes, which is not the function's own method. */
function isWrittenFunction(expression: Expression): boolean {
  const each = unwrapped(expression);
  return isFunctionExpression(each) || isArrowFunction(each) || isClassExpression(each);
}

/**
 * What `literal` has of the member `name`: its entries, in order, each write it again — an entry of
 * the name, a spread or a name it computes, which may — so that the last is the member; where it
 * has none, a prototype it sets, `__proto__: fn`, brings the function's, or may.
 */
export function memberOf(
  literal: ObjectLiteralExpression,
  name: string,
  textOf: (node: Node) => string | undefined,
): Member {
  let member: Member = 'absent';
  let inherits = false;
  for (const property of literal.properties) {
    const written = nameOf(property, textOf);
    if (written === undefined) {
      member = 'unknown';
    } else if (written === '__proto__' && !isShorthandPropertyAssignment(property)) {
      inherits = true;
    } else if (written === name) {
      member =
        isMethodDeclaration(property) ||
        (isPropertyAssignment(property) && isWrittenFunction(property.initializer))
          ? 'function'
          : 'unknown';
    }
  }
  return member === 'absent' && inherits ? 'unknown' : member;
}

/** Whether `literal` sets its prototype, `__proto__: base`, whose members it has besides its own. */
export function setsPrototype(
  literal: ObjectLiteralExpression,
  textOf: (node: Node) => string | undefined,
): boolean {
  return literal.properties.some(
    (property) =>
      nameOf(property, textOf) === '__proto__' && !isShorthandPropertyAssignment(property),
  );
}
