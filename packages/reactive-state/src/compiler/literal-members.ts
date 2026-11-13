import {
  type Expression,
  isArrowFunction,
  isBinaryExpression,
  isClassExpression,
  isComputedPropertyName,
  isAsExpression,
  isConditionalExpression,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isSatisfiesExpression,
  isParenthesizedExpression,
  isNonNullExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isTypeAssertion,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';

/** What an object written has of a member, by what its entries write, in order: the last of them is the member. */

/**
 * The member of an object written: a function the code writes for it (`function`), none (`absent`),
 * or one whose value the code does not show (`unknown`) — an entry of the name that is no function
 * written, a getter, a spread or a name it computes after, a prototype set where it has none of its own.
 */
export type Member = 'absent' | 'function' | 'unknown';

/**
 * What `expression` evaluates to, past what hands its value on as it is: the parentheses, the casts
 * — in angle brackets too, which `unwrapped` leaves — the `!`, and a comma's first operands. This is
 * the one place that decides it: what a call calls, what an object's entry holds, what names it.
 */
export function peeled(expression: Expression): Expression {
  let each = unwrapped(expression);
  for (;;) {
    if (isBinaryExpression(each) && each.operatorToken.kind === SyntaxKind.CommaToken) {
      each = unwrapped(each.right);
    } else if (isTypeAssertion(each)) {
      each = unwrapped(each.expression);
    } else {
      return each;
    }
  }
}

/**
 * Where the value of `node` goes, the counterpart of `peeled`: what it stands in (`parent`), as `at`,
 * past what hands it on — the parentheses, the casts, the `!`, a comma's last operand — and what
 * chooses it or another, a condition's branches, `||`, `??`, `&&`.
 */
export function valueUse(node: Node): { readonly at: Node; readonly parent: Node } {
  let at = node;
  for (;;) {
    const { parent } = at;
    const kind = isBinaryExpression(parent) ? parent.operatorToken.kind : undefined;
    const hands =
      isParenthesizedExpression(parent) ||
      isAsExpression(parent) ||
      isSatisfiesExpression(parent) ||
      isNonNullExpression(parent) ||
      isTypeAssertion(parent) ||
      (isConditionalExpression(parent) && parent.condition !== at) ||
      (isBinaryExpression(parent) &&
        (kind === SyntaxKind.BarBarToken ||
          kind === SyntaxKind.QuestionQuestionToken ||
          kind === SyntaxKind.AmpersandAmpersandToken ||
          (kind === SyntaxKind.CommaToken && parent.right === at)));
    if (!hands) {
      return { at, parent };
    }
    at = parent;
  }
}

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
  return textOf(isComputedPropertyName(name) ? peeled(name.expression) : name);
}

/**
 * Whether `expression` is a function the code writes, whichever way it gives it: past what hands a
 * value on (`peeled`), and either of two it chooses between — a condition, `||`, `??` — both of which
 * are; not `&&`, which gives its second where its first is a function, which is no function written.
 */
function isWrittenFunction(expression: Expression): boolean {
  const each = peeled(expression);
  if (isConditionalExpression(each)) {
    return isWrittenFunction(each.whenTrue) && isWrittenFunction(each.whenFalse);
  }
  if (isBinaryExpression(each)) {
    const { kind } = each.operatorToken;
    return (
      (kind === SyntaxKind.BarBarToken || kind === SyntaxKind.QuestionQuestionToken) &&
      isWrittenFunction(each.left) &&
      isWrittenFunction(each.right)
    );
  }
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
