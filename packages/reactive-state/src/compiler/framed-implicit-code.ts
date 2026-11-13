import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isComputedPropertyName,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPrefixUnaryExpression,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { literalArrayBinding } from './framed-array-elements.ts';

/**
 * What runs application code where no call of the code's own is written: a member read, which may
 * find a getter or reach a proxy; a spread, which takes an iterator, a getter of a field or a trap; a
 * template, whose parts a `toString`, a `valueOf` or a `Symbol.toPrimitive` coerces; an operator that
 * coerces an operand, or tests it with `Symbol.hasInstance`; an assignment, which may meet a setter;
 * a computed name, coerced to a key; a deletion, which may reach a trap; an await, which reads
 * `then`; a pattern, which reads what it takes apart.
 */

/** The binary operators that run nothing on their operands: identity, and the short circuits. */
const QUIET_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.CommaToken,
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** The node kinds that run code wherever they are written. */
const RUNS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayBindingPattern,
  SyntaxKind.AwaitExpression,
  SyntaxKind.CallExpression,
  SyntaxKind.DeleteExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.NewExpression,
  SyntaxKind.ObjectBindingPattern,
  SyntaxKind.PostfixUnaryExpression,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.SpreadAssignment,
  SyntaxKind.SpreadElement,
  SyntaxKind.TaggedTemplateExpression,
  SyntaxKind.YieldExpression,
]);

/** Whether a node, where it is evaluated, runs code: itself, or by what it does to its operands. */
export function runsCode(node: Node): boolean {
  if (RUNS.has(node.kind)) return true;
  if (isTemplateExpression(node)) return true;
  if (isBinaryExpression(node)) return !QUIET_OPERATORS.has(node.operatorToken.kind);
  if (isPrefixUnaryExpression(node)) return node.operator !== SyntaxKind.ExclamationToken;
  return isComputedPropertyName(node) && !literalKey(node.expression);
}

/** Whether a computed name is a text or a number written out, which coerces to itself. */
function literalKey(key: Expression): boolean {
  const value = unwrapped(key);
  return (
    isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value) || isNumericLiteral(value)
  );
}

/** Whether an entry is a list written out, or a name a list written out is held by: a read of its slots runs nothing. */
function isListEntry(entry: Expression): boolean {
  const value = unwrapped(entry);
  if (isArrayLiteralExpression(value)) return true;
  return isIdentifier(value) && literalArrayBinding(value) !== undefined;
}

/**
 * Whether `Object.fromEntries` itself runs code in taking the entries of its argument: the entries
 * are not a list written out, or one is not a list (an object whose `0` and `1` may be getters), or
 * is a spread of anything but a list.
 */
export function entriesRunCode(call: CallExpression): boolean {
  const [first] = call.arguments;
  const list = first === undefined ? undefined : unwrapped(first);
  if (list === undefined || !isArrayLiteralExpression(list)) return true;
  return list.elements.some((each) => {
    if (isSpreadElement(each)) return !isArrayLiteralExpression(unwrapped(each.expression));
    return !isListEntry(each);
  });
}
