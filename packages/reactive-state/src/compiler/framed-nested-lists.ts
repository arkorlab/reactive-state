import {
  type ArrayLiteralExpression,
  type BindingName,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isConditionalExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isLiteralTypeNode,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isParenthesizedTypeNode,
  isPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTemplateLiteralTypeNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVariableDeclaration,
  type Node,
  type TypeNode,
  type VariableDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import type { WrittenArrayElement } from './framed-array-elements.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { writtenAsWhole } from './framed-array-identity.ts';
import { isNoArray } from './framed-array-starts.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedWrittenTargets } from './framed-written-targets.ts';
import { bindingIdentifiers } from './scope.ts';

/**
 * Arrays that hold arrays. A list an array holds is the list itself, not a copy: a copy of the array
 * (a spread, `slice`, `Array.from`, a callback's parameter, a pattern) hands the list on, and a write
 * through the copy is a write to it, by no name a reader follows. An array whose elements may be lists
 * is followed by the uses that hand no element out; one whose elements are texts, numbers and error
 * words is followed as before.
 */

/** How many names a chain of constants may pass before its end is taken for unknown. */
const CHAIN = 32;

/** The types that are no list: the keyword types, literals, the errors, and a union of them. */
const SCALAR_TYPES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.NeverKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.VoidKeyword,
]);

/** The names of the built-in types of objects that are no lists. */
const SCALAR_NAMES: ReadonlySet<string> = new Set([
  'AggregateError',
  'Date',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'RegExp',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

/** Whether a declared type says its value is no list. */
function scalarType(type: TypeNode): boolean {
  const pending = [type];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (isParenthesizedTypeNode(each)) pending.push(each.type);
    else if (isUnionTypeNode(each)) pending.push(...each.types);
    else if (!scalarLeaf(each)) return false;
  }
  return true;
}

/** Whether a type that is no union or parenthesis says its value is no list. */
function scalarLeaf(type: TypeNode): boolean {
  if (SCALAR_TYPES.has(type.kind) || isLiteralTypeNode(type) || isTemplateLiteralTypeNode(type))
    return true;
  return isTypeReferenceNode(type) && SCALAR_NAMES.has(type.typeName.getText(type.getSourceFile()));
}

/** Whether the value an element is written as is, or holds, an array: where it is no scalar the compile knows. */
export function mayBeList(
  element: Expression,
  scalar: (value: Expression, keys: readonly string[]) => boolean,
): boolean {
  const pending: { readonly value: Expression; readonly links: number }[] = [
    { value: element, links: 0 },
  ];
  const seen = new Set<unknown>();
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const next = leads(each.value, scalar, each.links, seen);
    if (next === undefined) return true;
    pending.push(...next.map((value) => ({ value, links: each.links + 1 })));
  }
  return false;
}

/** The values an element stands for in turn, none known for a value that may be a list. */
function leads(
  value: Expression,
  scalar: (value: Expression, keys: readonly string[]) => boolean,
  links: number,
  seen: Set<unknown>,
): readonly Expression[] | undefined {
  const written = unwrapped(value);
  if (links > CHAIN || isArrayLiteralExpression(written)) return undefined;
  if (scalar(written, []) || isNoArray(written)) return [];
  if (isConditionalExpression(written)) return [written.whenTrue, written.whenFalse];
  if (isBinaryExpression(written)) return binaryLeads(written);
  if (!isIdentifier(written)) return undefined;
  return named(written, seen);
}

/** The operands a choice, a sequence or an assignment hands over. */
function binaryLeads(
  written: Expression & { readonly kind: SyntaxKind },
): readonly Expression[] | undefined {
  if (!isBinaryExpression(written)) return undefined;
  const { kind } = written.operatorToken;
  if (kind === SyntaxKind.CommaToken || kind === SyntaxKind.EqualsToken) return [written.right];
  const hands =
    kind === SyntaxKind.AmpersandAmpersandToken ||
    kind === SyntaxKind.BarBarToken ||
    kind === SyntaxKind.QuestionQuestionToken;
  return hands ? [written.left, written.right] : undefined;
}

/**
 * What a name stands for: its initializer, none known where it is a parameter (a default is only what a
 * call that gives none leaves), a pattern, or a name that is written as a whole elsewhere, which may be
 * given a list there. A name typed as a scalar is one, whatever it is given.
 */
function named(name: Identifier, seen: Set<unknown>): readonly Expression[] | undefined {
  if (['Infinity', 'NaN', 'undefined'].includes(name.text) && frameBindingOf(name) === undefined)
    return [];
  const selected = frameBindingOf(name);
  if (selected === undefined || selected.keys.length > 0) return undefined;
  const { binding } = selected;
  if (binding.type !== undefined && scalarType(binding.type)) return [];
  if (isParameterDeclaration(binding)) return undefined;
  if (seen.has(binding)) return [];
  seen.add(binding);
  if (writtenAsWhole(binding) || binding.initializer === undefined) return undefined;
  return [binding.initializer];
}

/** What the check of an array asks of its reader: which elements are no lists, the literal a name stands for, what is written to it. */
export interface Holding {
  /** Whether an element is known to be no list (an error word), by the path it is selected under. */
  readonly scalar: (value: Expression, keys: readonly string[]) => boolean;
  /** The array literal an array expression stands for, through the names that only hold it. */
  readonly literal: (value: Expression) => ArrayLiteralExpression | undefined;
  /** The elements written to the array an expression names after its literal. */
  readonly written: (value: Expression) => readonly WrittenArrayElement[];
}

/**
 * Whether the elements of an array may be lists: those its literal is written with, those a spread
 * gives it (the spread array is asked in turn, once), and what is written to it afterwards. An array
 * the compile cannot read as a literal holds what it holds: it may be lists.
 */
export function holdsLists(
  array: Expression,
  holding: Holding,
  seen = new Set<ArrayLiteralExpression>(),
): boolean {
  const literal = holding.literal(array);
  if (literal === undefined) return true;
  if (seen.has(literal)) return false;
  seen.add(literal);
  const written = (): boolean => {
    return holding.written(array).some((each) => {
      if (each.array === true) return true;
      return each.keys.length > 0
        ? !holding.scalar(each.value, each.keys)
        : mayBeList(each.value, holding.scalar);
    });
  };
  const elements = literal.elements.filter((each) => !isOmittedExpression(each));
  return elements.some((each) => elementMayBeList(each, holding, seen)) || written();
}

/** Whether an element of an array literal may be a list: a spread holds the elements of its operand. */
function elementMayBeList(
  element: Expression,
  holding: Holding,
  seen: Set<ArrayLiteralExpression>,
): boolean {
  if (!isSpreadElement(element)) return mayBeList(element, holding.scalar);
  return (
    !isStringLiteral(unwrapped(element.expression)) && holdsLists(element.expression, holding, seen)
  );
}

/**
 * Whether a name that a pattern takes apart from a literal written beside it holds a list: a name is
 * taken from a written object or array, and what is written through it is no write any reader of the
 * array follows (`const [item] = [[]]; item.push(error)`). A name of a parameter, a call or a loop is an
 * input of the program, and left as it was.
 */
export function destructuredList(
  name: Identifier,
  scalar: (value: Expression, keys: readonly string[]) => boolean,
): boolean {
  const declared = frameDeclarationOf(name);
  if (declared === undefined || !isVariableDeclaration(declared)) return false;
  if (isIdentifier(declared.name)) return false;
  if (rewritten(declared)) return true;
  if (declared.initializer === undefined) return false;
  const source = literalSource(declared.initializer);
  if (source === undefined) return false;
  const selected = frameBindingOf(name);
  if (selected === undefined || defaultMayBeList(name, declared.name, scalar)) return true;
  const value = selection(source, selected.keys);
  return value === undefined || mayBeList(value, scalar);
}

/** What a written literal holds at the end of a path of keys, none known where a step may be anything. */
function selection(source: Expression, keys: readonly string[]): Expression | undefined {
  let value: Expression | undefined = source;
  for (const key of keys) {
    if (value === undefined) return undefined;
    value = picked(value, key);
  }
  return value;
}

/** Whether a name of the declaration is written as a whole elsewhere: the declaration stands for every name of its pattern. */
function rewritten(declared: VariableDeclaration): boolean {
  const pending: Node[] = [declared.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const target of framedWrittenTargets(node)) {
      const name = unwrapped(target);
      if (isIdentifier(name) && frameDeclarationOf(name) === declared) return true;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** The literal a constant's initializer is, or ends at, through the names that only hold it. */
function literalSource(initializer: Expression): Expression | undefined {
  let value = unwrapped(initializer);
  for (let links = 0; links <= CHAIN; links += 1) {
    if (isArrayLiteralExpression(value) || isObjectLiteralExpression(value)) return value;
    if (!isIdentifier(value)) return undefined;
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0) return undefined;
    if (selected.binding.initializer === undefined) return undefined;
    value = unwrapped(selected.binding.initializer);
  }
  return undefined;
}

/** What a written array or object holds under a key, none known where a spread, a getter or a name unread may give it. */
function picked(value: Expression, key: string): Expression | undefined {
  const written = unwrapped(value);
  if (isArrayLiteralExpression(written)) return pickedElement(written, key);
  if (!isObjectLiteralExpression(written)) return undefined;
  for (const each of written.properties.toReversed()) {
    if (isSpreadAssignment(each) || isGetAccessorDeclaration(each)) return undefined;
    const field = writtenArrayKey(each.name);
    if (field === undefined) return undefined;
    if (field === key) return isPropertyAssignment(each) ? each.initializer : undefined;
  }
  return undefined;
}

/** What a written array holds at an index, none known where a spread or a hole may move it. */
function pickedElement(array: ArrayLiteralExpression, key: string): Expression | undefined {
  const at = Number(key);
  if (Number.isNaN(at)) return undefined;
  const before = array.elements.slice(0, at + 1);
  const unsure = before.some((each) => isSpreadElement(each) || isOmittedExpression(each));
  return unsure ? undefined : array.elements[at];
}

/** Whether a default written in the pattern, on the way to a name, may be a list. */
function defaultMayBeList(
  name: Identifier,
  pattern: BindingName,
  scalar: (value: Expression, keys: readonly string[]) => boolean,
): boolean {
  let at = bindingIdentifiers(pattern).find((each) => each.text === name.text)?.parent;
  while (at !== undefined && isBindingElement(at)) {
    if (at.initializer !== undefined && mayBeList(at.initializer, scalar)) return true;
    at = at.parent.parent;
  }
  return false;
}
