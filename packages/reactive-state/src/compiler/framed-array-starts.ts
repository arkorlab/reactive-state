import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBindingElement,
  isBinaryExpression,
  isConditionalExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type ObjectLiteralElementLike,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { givenValues } from './framed-array-identity.ts';
import { frameBindingOf, frameDeclarationOf, type FrameBinding } from './framed-bindings.ts';
import { bindingIdentifiers } from './scope.ts';

/**
 * Whether a name may start as an array: its initializer is a written array, or a chain of names, the
 * parts a pattern selects among them, ends at one, or at anything the compile cannot read (a
 * parameter, a call). A chain that ends at a value that is no array (a string, a number, a function, an
 * object) starts as none.
 */
export function mayStartAsArray(binding: FrameBinding): boolean {
  return mayBeArray(binding.initializer, binding);
}

/**
 * Whether a name that is written as a whole elsewhere may be given an array there: the right of an
 * assignment, read as the initializer is, or a pattern or a loop head, whose value is not read. A name
 * that starts as a number or a text and is given a list holds the list afterwards.
 */
export function mayBecomeArray(binding: FrameBinding): boolean {
  return givenValues(binding).some((value) => value === undefined || mayBeArray(value, binding));
}

/**
 * Whether the value a name is given, followed through the names it passes, may be an array. A name it
 * passes is read as the name asked about is: by the value it starts as and by the values it is given as
 * a whole elsewhere, each name once.
 */
function mayBeArray(given: Expression | undefined, binding: FrameBinding): boolean {
  const seen = new Map<FrameBinding, Set<string>>([[binding, new Set([''])]]);
  const pending: (Expression | undefined)[] = [given];
  while (pending.length > 0) {
    const value = pending.pop();
    const next = value === undefined ? undefined : leadsOf(value, seen);
    if (next === undefined) return true;
    pending.push(...next);
  }
  return false;
}

/**
 * The values a value leads to, none where it may be an array: a name leads to what it starts as and to what
 * it is given as a whole, once for each part of a pattern it names; a value that is none of an array, a name
 * or a scalar the compile knows is one.
 */
function leadsOf(
  value: Expression,
  seen: Map<FrameBinding, Set<string>>,
): readonly (Expression | undefined)[] | undefined {
  const start = unwrapped(value);
  if (isArrayLiteralExpression(start)) return undefined;
  if (!isIdentifier(start)) return isNoArray(start) ? [] : undefined;
  const selected = frameBindingOf(start);
  if (selected === undefined) return start.text === 'undefined' ? [] : undefined;
  if (!firstVisit(seen, selected.binding, selected.keys)) return [];
  if (defaultMayBeArray(start)) return undefined;
  return [
    selectedValue(selected.binding.initializer, selected.keys),
    ...givenValues(selected.binding),
  ];
}

/** Whether a part of a declaration is met for the first time: the fields of one pattern are different names. */
function firstVisit(
  seen: Map<FrameBinding, Set<string>>,
  binding: FrameBinding,
  keys: readonly string[],
): boolean {
  const parts = seen.get(binding) ?? new Set<string>();
  seen.set(binding, parts);
  const part = keys.join('\0');
  if (parts.has(part)) return false;
  parts.add(part);
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
export function isNoArray(value: Expression): boolean {
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
 * Whether a field of a written object may change another when the object is taken apart: a getter
 * runs where its name is read, and may assign a field read after it; a written prototype may hold one.
 */
function runsOnRead(property: ObjectLiteralElementLike): boolean {
  if (isGetAccessorDeclaration(property)) return true;
  return isPropertyAssignment(property) && writtenArrayKey(property.name) === '__proto__';
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
  if (!isObjectLiteralExpression(value) || value.properties.some((each) => runsOnRead(each)))
    return undefined;
  for (const each of value.properties.toReversed()) {
    if (isSpreadAssignment(each)) return undefined;
    const name = writtenArrayKey(each.name);
    if (name === undefined) return undefined;
    if (name === key) return isPropertyAssignment(each) ? unwrapped(each.initializer) : undefined;
  }
  return undefined;
}
