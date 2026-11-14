import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBindingElement,
  isBinaryExpression,
  isConditionalExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { frameBindingOf, frameDeclarationOf, type FrameBinding } from './framed-bindings.ts';
import { bindingIdentifiers } from './scope.ts';

/**
 * Whether a name may start as an array: its initializer is a written array, or a chain of names, the
 * parts a pattern selects among them, ends at one, or at anything the compile cannot read (a
 * parameter, a call). A chain that ends at a value that is no array (a string, a number, a function, an
 * object) starts as none.
 */
export function mayStartAsArray(binding: FrameBinding): boolean {
  const seen = new Set<FrameBinding>([binding]);
  let value: Expression | undefined = binding.initializer;
  while (value !== undefined) {
    const start = unwrapped(value);
    if (isArrayLiteralExpression(start)) return true;
    if (!isIdentifier(start)) return !isNoArray(start);
    const selected = frameBindingOf(start);
    if (selected === undefined) return start.text !== 'undefined';
    if (seen.has(selected.binding)) return true;
    seen.add(selected.binding);
    if (defaultMayBeArray(start)) return true;
    value = selectedValue(selected.binding.initializer, selected.keys);
  }
  return true;
}

/** The written values that are no array, whatever their operands are: literals, and what an operator makes of any. */
const NO_ARRAY_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrowFunction,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.DeleteExpression,
  SyntaxKind.FalseKeyword,
  SyntaxKind.FunctionExpression,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.PostfixUnaryExpression,
  SyntaxKind.PrefixUnaryExpression,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TemplateExpression,
  SyntaxKind.TrueKeyword,
  SyntaxKind.TypeOfExpression,
  SyntaxKind.VoidExpression,
]);

/** The binary operators whose result is a string, a number, a bigint or a boolean, whatever the operands are. */
const SCALAR_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandToken,
  SyntaxKind.AsteriskAsteriskToken,
  SyntaxKind.AsteriskToken,
  SyntaxKind.BarToken,
  SyntaxKind.CaretToken,
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
  SyntaxKind.GreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  SyntaxKind.GreaterThanGreaterThanToken,
  SyntaxKind.GreaterThanToken,
  SyntaxKind.InKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.LessThanEqualsToken,
  SyntaxKind.LessThanLessThanToken,
  SyntaxKind.LessThanToken,
  SyntaxKind.MinusToken,
  SyntaxKind.PercentToken,
  SyntaxKind.PlusToken,
  SyntaxKind.SlashToken,
]);

/** The binary operators whose result is one of the operands. */
const CHOOSING_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * Whether a name that a pattern takes apart has a default that may be an array, on the way to its
 * field: a field that is `undefined` gives the name its default, whatever the field is written as.
 */
function defaultMayBeArray(name: Identifier): boolean {
  const declared = frameDeclarationOf(name)?.name;
  if (declared === undefined) return false;
  const bound = bindingIdentifiers(declared).find((each) => each.text === name.text);
  let at: Node | undefined = bound?.parent;
  while (at !== undefined && isBindingElement(at)) {
    if (at.initializer !== undefined && !isNoArray(at.initializer)) return true;
    at = at.parent.parent;
  }
  return false;
}

/**
 * Whether an expression is written as a value that is no array: a literal, what an operator makes of
 * its operands (a number, a string, a boolean), or a choice or a sequence that ends at such a value
 * on every path. A name, a member, an element and a call may hold an array, and are none of these.
 */
function isNoArray(value: Expression): boolean {
  const pending = [value];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const written = unwrapped(each);
    if (NO_ARRAY_KINDS.has(written.kind)) continue;
    const ends = endsOf(written);
    if (ends === undefined) return false;
    pending.push(...ends);
  }
  return true;
}

/** The expressions a choice or a sequence may end at, and none for an operator that makes a scalar; undefined where it is neither. */
function endsOf(value: Expression): readonly Expression[] | undefined {
  if (isConditionalExpression(value)) return [value.whenTrue, value.whenFalse];
  if (!isBinaryExpression(value)) return undefined;
  const operator = value.operatorToken.kind;
  if (SCALAR_OPERATORS.has(operator)) return [];
  if (operator === SyntaxKind.CommaToken) return [value.right];
  return CHOOSING_OPERATORS.has(operator) ? [value.left, value.right] : undefined;
}

/** What a pattern selects from a written array or object, none where it cannot be read. */
function selectedValue(
  initializer: Expression | undefined,
  keys: readonly string[],
): Expression | undefined {
  let value = initializer === undefined ? undefined : unwrapped(initializer);
  for (const key of keys) {
    if (value === undefined) return undefined;
    value = selectedField(value, key);
  }
  return value;
}

/**
 * The field or the element a written object or array has under the key: the last field of the name,
 * where no spread and no name the compile cannot read comes after it, which may give the name another value.
 */
function selectedField(value: Expression, key: string): Expression | undefined {
  if (isArrayLiteralExpression(value)) {
    const element = value.elements.find((_, at) => String(at) === key);
    const spread = value.elements.some(
      (each) => isSpreadElement(each) || isOmittedExpression(each),
    );
    return element === undefined || spread ? undefined : unwrapped(element);
  }
  if (!isObjectLiteralExpression(value)) return undefined;
  for (const each of value.properties.toReversed()) {
    if (isSpreadAssignment(each)) return undefined;
    const name = writtenArrayKey(each.name);
    if (name === undefined) return undefined;
    if (name === key) return isPropertyAssignment(each) ? unwrapped(each.initializer) : undefined;
  }
  return undefined;
}
