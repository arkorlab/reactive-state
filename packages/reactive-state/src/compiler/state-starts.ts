import {
  type Expression,
  isArrayLiteralExpression,
  isElementAccessExpression,
  isIdentifier,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  isTemplateExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { constantNumber } from './numbers.ts';
import { isOwnName } from './object-kinds.ts';

/**
 * What a state a site reads starts of, as the kind of JSON it holds is read of it (`kinds.ts`): a
 * prop, or a member of one, whose type the props' type writes; a literal, which TypeScript types of
 * what it is; anything else, which the compile cannot type.
 */

/**
 * A chain of reads of a name — `options`, and `filter` of `options.filter`, of `options['filter']`,
 * of `options!.filter` — and whether the code writes the name of each member it reads (`told`):
 * not that of `options[key]`.
 */
export interface PropPath {
  readonly root: string;
  readonly members: readonly string[];
  readonly told: boolean;
}

/** The chain of reads of a name `input` is, or none where it is no such chain. */
export function propPath(input: Node): PropPath | undefined {
  const members: string[] = [];
  let told = true;
  let node = input;
  while (
    isParenthesizedExpression(node) ||
    isNonNullExpression(node) ||
    isPropertyAccessExpression(node) ||
    isElementAccessExpression(node)
  ) {
    if (isPropertyAccessExpression(node)) {
      members.unshift(node.name.text);
    } else if (isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      if (isStringLiteral(key) || isNoSubstitutionTemplateLiteral(key)) {
        members.unshift(key.text);
      } else if (isNumericLiteral(key)) {
        members.unshift(String(Number(key.text)));
      } else {
        told = false;
      }
    }
    node = node.expression;
  }
  return isIdentifier(node) ? { members, root: node.text, told } : undefined;
}

/**
 * Whether `node` is a literal of one kind of JSON, which TypeScript types of what it is: text, a
 * number — what the code computes of numbers alone too (`constantNumber`) — a boolean, `null`; an
 * array or an object of these alone, all through, each object of a member of a name of its own —
 * typed so, of JSON all through, no function satisfying it — not of what the compile cannot type,
 * `[first]`, nor `{}`, `{ name: 'x' }`, of types a function satisfies.
 */
export function isOneKindLiteral(node: Expression): boolean {
  if (constantNumber(node) !== undefined) {
    return true;
  }
  let each: Expression = node;
  while (
    isPrefixUnaryExpression(each) &&
    (each.operator === SyntaxKind.MinusToken || each.operator === SyntaxKind.PlusToken)
  ) {
    each = each.operand;
  }
  return isJsonLiteral(each);
}

/** Whether `node` is text, a number, a boolean, `null`, or an array or an object of these alone. */
function isJsonLiteral(node: Expression): boolean {
  let each = node;
  while (isParenthesizedExpression(each)) {
    each = each.expression;
  }
  if (isArrayLiteralExpression(each)) {
    return each.elements.every((element) => isJsonLiteral(element));
  }
  if (isObjectLiteralExpression(each)) {
    let owned = false;
    for (const property of each.properties) {
      if (!isPropertyAssignment(property) || !isJsonLiteral(property.initializer)) {
        return false;
      }
      const { name } = property;
      if (!isIdentifier(name) && !isStringLiteral(name) && !isNumericLiteral(name)) {
        return false;
      }
      owned ||= !isNumericLiteral(name) && isOwnName(name.text);
    }
    return owned;
  }
  return (
    constantNumber(each) !== undefined ||
    isStringLiteral(each) ||
    isNoSubstitutionTemplateLiteral(each) ||
    isTemplateExpression(each) ||
    each.kind === SyntaxKind.TrueKeyword ||
    each.kind === SyntaxKind.FalseKeyword ||
    each.kind === SyntaxKind.NullKeyword
  );
}
