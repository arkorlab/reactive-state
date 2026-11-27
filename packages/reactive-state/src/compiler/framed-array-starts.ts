import {
  type BinaryExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isAsExpression,
  isAssertionExpression,
  isBindingElement,
  isBinaryExpression,
  isConditionalExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isNonNullExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isSpreadAssignment,
  isSpreadElement,
  isTypeAssertion,
  type Node,
  type ObjectLiteralElementLike,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { givenValues } from './framed-array-identity.ts';
import { frameBindingOf, frameDeclarationOf, type FrameBinding } from './framed-bindings.ts';
import { isScalarType } from './framed-scalar-types.ts';
import { isWrapper } from './framed-written-targets.ts';
import { bindingIdentifiers } from './scope.ts';

/**
 * Whether a name may start as an array: its initializer is a written array, or a chain of names, the
 * parts a pattern selects among them, ends at one, or at anything the compile cannot read (a
 * parameter, a call). A chain that ends at a value that is no array (a string, a number, a function, an
 * object) starts as none.
 */
export function mayStartAsArray(binding: FrameBinding): boolean {
  return !writtenScalar(binding) && mayBeArray(binding.initializer, binding);
}

/**
 * Whether a name that is written as a whole elsewhere may be given an array there: the right of an
 * assignment, read as the initializer is, or a pattern or a loop head, whose value is not read. A name
 * that starts as a number or a text and is given a list holds the list afterwards. Of a name the code
 * writes as a scalar, only what it is shown to hold all the same is read (`shownOf`).
 */
export function mayBecomeArray(binding: FrameBinding): boolean {
  const given = writtenScalar(binding) ? shownOf(binding) : givenValues(binding);
  return given.some((value) => value === undefined || mayBeArray(value, binding));
}

/**
 * What a name the code writes as a scalar is shown to hold all the same, read from what it starts as
 * and from each value it is given as a whole. Type-checked code cannot write a list to such a name
 * but under a type assertion, so the written type vouches for a value only where no assertion stands
 * over it. A part a pattern or a loop head gives is a value the reader of whole writes does not keep
 * (`givenValues` knows none), so no assertion over its source would be seen: it is answered as a
 * value that is not known, which refuses. Parentheses, `!` and `satisfies` change no type and are
 * looked through; `as` and `<T>` are looked through and remembered. A conditional's branches, the
 * operands of `||`, `&&` and `??`, the last of a sequence and what an assignment gives (its right, or
 * either side of a logical one) are each read in turn. At the end of those:
 *
 * - a written list refuses, and a name is followed as any name is, asserted or not;
 * - a value that is no list by its syntax (a literal, a template, what an operator makes, a function,
 *   an object) is none;
 * - any other value (a call's result, a member, an element, `await`, `new`) is what the written type
 *   vouches for, unless an assertion stands over it: then nothing says it is no list, and it is
 *   answered as a value that is not known (`undefined`), which refuses. An assertion over the list a
 *   destructuring assignment takes the value from stands over it as well (`assertedWrite`).
 */
function shownOf(binding: FrameBinding): readonly (Expression | undefined)[] {
  const given = givenValues(binding);
  const shown: (Expression | undefined)[] = given.includes(undefined) ? [undefined] : [];
  const pending = [
    { isAsserted: false, value: binding.initializer },
    ...given.map((value) => ({ isAsserted: value !== undefined && assertedWrite(value), value })),
  ];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (each.value === undefined) continue;
    const { isAsserted, value } = withoutWrapping(each.value, each.isAsserted);
    const ends = endsOf(value) ?? assignedOf(value);
    if (ends !== undefined) pending.push(...ends.map((end) => ({ isAsserted, value: end })));
    else if (isArrayLiteralExpression(value) || isIdentifier(value)) shown.push(value);
    else if (isAsserted && !isNoArray(value)) shown.push(undefined);
  }
  return shown;
}

/**
 * Whether a type assertion stands over the list a destructuring assignment takes a written value from
 * (`[text] = [value] as unknown as [string]`): `givenValues` keeps the element alone, so the cast is
 * looked for above it, through the parentheses, `!` and `satisfies` that wrap the list too. A value
 * written as a whole (`text = value`) has no list above it.
 */
function assertedWrite(value: Expression): boolean {
  let at: Node = value;
  while (isWrapper(at.parent) || isArrayLiteralExpression(at.parent)) {
    at = at.parent;
    if (isAssertionExpression(at)) return true;
  }
  return false;
}

/**
 * `node` within what wraps it, and whether a type assertion (`as`, `<T>`) is among the wrappers or
 * stood over them already: parentheses, `!` and `satisfies` assert no other type.
 */
function withoutWrapping(
  node: Expression,
  isAsserted: boolean,
): { readonly isAsserted: boolean; readonly value: Expression } {
  let value = node;
  let asserted = isAsserted;
  for (;;) {
    if (isAsExpression(value) || isTypeAssertion(value)) asserted = true;
    else if (
      !isParenthesizedExpression(value) &&
      !isNonNullExpression(value) &&
      !isSatisfiesExpression(value)
    )
      return { isAsserted: asserted, value };
    value = value.expression;
  }
}

/** The assignments that answer the name's old value or the right: `||=`, `&&=` and `??=`. */
const LOGICAL_ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * What a binary expression `endsOf` does not read answers: the right of an assignment, either side
 * of a logical one, and none for the compound ones, which make a number or a text; undefined of what
 * is no binary expression.
 */
function assignedOf(value: Expression): readonly Expression[] | undefined {
  if (!isBinaryExpression(value)) return undefined;
  const { kind } = value.operatorToken;
  if (kind === SyntaxKind.EqualsToken) return [value.right];
  return LOGICAL_ASSIGNMENTS.has(kind) ? [value.left, value.right] : [];
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
 * or a scalar the compile knows is one. A whole name the code writes as a scalar leads to what it is shown to
 * hold all the same (`shownOf`), and to nothing else: no array, whatever it starts as, a parameter included
 * (`let text = name` of a `name: string`).
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
  if (selected.keys.length === 0 && writtenScalar(selected.binding))
    return shownOf(selected.binding);
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
  return endsAtKinds(value, NO_ARRAY_KINDS, { strip: unwrapped, typed: false });
}

/** The written values whose type is a text, a number, a boolean or a bigint, whatever their operands are. */
const SCALAR_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntLiteral,
  SyntaxKind.DeleteExpression,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NumericLiteral,
  SyntaxKind.PostfixUnaryExpression,
  SyntaxKind.PrefixUnaryExpression,
  SyntaxKind.StringLiteral,
  SyntaxKind.TemplateExpression,
  SyntaxKind.TrueKeyword,
  SyntaxKind.TypeOfExpression,
]);

/**
 * Whether an expression is written as a text, a number, a boolean or a bigint: a literal of one, what
 * an operator makes of its operands, or a choice or a sequence that ends at such a value on every
 * path. The empty object, `null`, `undefined`, a function and a regular expression are no array, but
 * a name that starts as one is typed by it as any, or as `{}`, and TypeScript lets an array be
 * assigned to it later: they are not scalars. A cast (`'x' as unknown`) says the name is typed as
 * something else than what it starts as, and is read as no scalar: only parentheses are looked through.
 */
export function isScalarValue(value: Expression): boolean {
  return endsAtKinds(value, SCALAR_KINDS, { strip: withoutParentheses, typed: true });
}

/**
 * Whether the code writes a name as a text, a number, a boolean or a bigint: its annotation says so,
 * or, with none, it starts as a literal or an operator's scalar. TypeScript refuses to give such a
 * name an array, as the compile trusts a written type that excludes an error, so what it is given
 * is no array, a call result included (`text = JSON.stringify(value)`). A rest parameter is a list
 * whatever its annotation says, and is none.
 */
export function writtenScalar(binding: FrameBinding): boolean {
  if (isParameterDeclaration(binding) && binding.dotDotDotToken !== undefined) return false;
  if (binding.type !== undefined) return isScalarType(binding.type);
  return binding.initializer !== undefined && isScalarValue(binding.initializer);
}

/** `node` within the parentheses that wrap it. */
function withoutParentheses(node: Expression): Expression {
  let each = node;
  while (isParenthesizedExpression(each)) each = each.expression;
  return each;
}

/** Whether every path of a choice or a sequence ends at a value of one of these kinds or at a scalar operator. */
function endsAtKinds(
  value: Expression,
  kinds: ReadonlySet<SyntaxKind>,
  reading: { readonly strip: (node: Expression) => Expression; readonly typed: boolean },
): boolean {
  const pending = [value];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const written = reading.strip(each);
    if (kinds.has(written.kind)) continue;
    const ends =
      reading.typed && isAddition(written) ? [written.left, written.right] : endsOf(written);
    if (ends === undefined) return false;
    pending.push(...ends);
  }
  return true;
}

/**
 * An addition is typed by its operands where the type matters: a name that starts as `JSON.parse('0')
 * + 1` is typed any, not number, and TypeScript lets an array be assigned to it. Both operands are
 * read, so that only an addition of scalars is a scalar.
 */
function isAddition(value: Expression): value is BinaryExpression {
  return isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.PlusToken;
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
