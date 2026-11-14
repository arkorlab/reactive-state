import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBigIntLiteral,
  isBinaryExpression,
  isComputedPropertyName,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isParameterDeclaration,
  isPrefixUnaryExpression,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { arrayIdentity } from './framed-array-identity.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { framedKeyNames } from './framed-keys.ts';
import { soleTarget } from './framed-mutator-calls.ts';
import { constantValue } from './numbers.ts';

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

/**
 * The list an entry is: written out, or held by a name that is not written as a whole elsewhere,
 * so that it holds the list it was given. None for anything else, whose slots a read may find a getter
 * of.
 */
function entryList(entry: Expression): ArrayLiteralExpression | undefined {
  const value = unwrapped(entry);
  if (isArrayLiteralExpression(value)) return value;
  const root = isIdentifier(value) ? arrayIdentity(value) : undefined;
  const held =
    root?.initializer === undefined ? undefined : soleTarget(unwrapped(root.initializer));
  return held !== undefined && isArrayLiteralExpression(held) ? held : undefined;
}

/** The primitive types a name may be written with: what a key of them coerces to is its own text. */
const PRIMITIVE_TYPES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.LiteralType,
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
]);

/** Whether a name is written as one of the primitive types, which no hook of its own is run on. */
function isPrimitiveName(name: Identifier): boolean {
  const declared = frameBindingOf(name)?.binding;
  if (declared === undefined) return false;
  const type =
    isParameterDeclaration(declared) || isVariableDeclaration(declared) ? declared.type : undefined;
  return type !== undefined && PRIMITIVE_TYPES.has(type.kind);
}

/**
 * Whether the key of an entry, which `Object.fromEntries` converts to the name it installs, may be an
 * object: it is not a text, a number or a primitive written out, a constant that is one, a name of
 * a type that is one, or a name whose written values are all texts. An object is converted by its
 * `Symbol.toPrimitive`, its `toString` or its `valueOf`, or those of its prototype.
 */
function keyMayBeObject(key: Expression | undefined): boolean {
  if (key === undefined) return false;
  const value = unwrapped(key);
  if (isSpreadElement(key)) return true;
  if (
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    isNumericLiteral(value) ||
    isBigIntLiteral(value) ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.NullKeyword
  )
    return false;
  if (isIdentifier(value) && (value.text === 'undefined' || isPrimitiveName(value))) return false;
  return constantValue(value) === undefined && framedKeyNames(value) === undefined;
}

/**
 * Whether `Object.fromEntries` itself runs code in taking the entries of its argument: the entries
 * are not a list written out, or one is not a list (an object whose `0` and `1` may be getters), or
 * is a spread of anything but a list, or the key of one may be an object it converts by a hook.
 */
export function entriesRunCode(call: CallExpression): boolean {
  const [first] = call.arguments;
  const list = first === undefined ? undefined : unwrapped(first);
  if (list === undefined || !isArrayLiteralExpression(list)) return true;
  return list.elements.some((each) => {
    if (isSpreadElement(each)) return !isArrayLiteralExpression(unwrapped(each.expression));
    const entry = entryList(each);
    return entry === undefined || keyMayBeObject(entry.elements[0]);
  });
}
