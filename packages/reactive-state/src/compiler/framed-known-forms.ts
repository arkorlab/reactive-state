import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isConditionalExpression,
  isForInStatement,
  isForOfStatement,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { writtenAsWhole } from './framed-array-identity.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { knownUsesOnly } from './framed-known-mentions.ts';
import { LOGICAL } from './framed-known-uses.ts';
import { fieldNamesThis } from './framed-this-functions.ts';
import { readsBinding } from './scope.ts';

/**
 * The forms of the arguments of a native mutator that the compile follows, read in the role the
 * mutator gives them. The mentions of a constant that such a form names are judged by
 * `framed-known-uses`; this module judges what is written where the argument stands.
 */

/**
 * What the reader of a form takes it for: a source whose fields are values, a descriptor, a map of
 * descriptors, or a pattern's source, every field of which the compile reads (a member of another
 * object, a call or a method there is no value it follows).
 */
export type Role = 'descriptor' | 'map' | 'pattern' | 'source';

/** An argument a form stands for, read in a role. */
interface Consulted {
  readonly node: Expression;
  readonly role: Role;
}

/** What a consultation has met: the constants it followed, and who is told of those that hold objects. */
interface Context {
  readonly seen: Set<Node>;
  readonly held?: ((declaration: VariableDeclaration) => void) | undefined;
}

/**
 * Whether an argument of a native mutator of an array is written in a form the compile follows: an
 * object or list literal, whose spreads are followed and whose entries are descriptors where it is a
 * map; a constant that holds such a form and has only known mentions; a choice between them. The
 * values a field holds are read as values. A member of another object, a call, a destructured
 * name or a variable written as a whole may hold anything, and no reader follows it.
 */
export function consultedKnown(
  expression: Expression,
  role: Role,
  held?: (declaration: VariableDeclaration) => void,
): boolean {
  const pending: Consulted[] = [{ node: expression, role }];
  const context: Context = { seen: new Set(), held };
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const next = consult(unwrapped(at.node), at.role, context);
    if (next === undefined) return false;
    pending.push(...next);
  }
  return true;
}

/** The arguments an argument stands for in turn, none where it is a form the compile does not follow. */
function consult(
  value: Expression,
  role: Role,
  context: Context,
): readonly Consulted[] | undefined {
  if (isObjectLiteralExpression(value)) return objectOf(value, role);
  if (isArrayLiteralExpression(value))
    return value.elements.flatMap((each) => entryOf(each, role === 'map' ? 'descriptor' : role));
  if (isConditionalExpression(value))
    return [
      { node: value.whenTrue, role },
      { node: value.whenFalse, role },
    ];
  if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.CommaToken)
    return [{ node: value.right, role }];
  if (isBinaryExpression(value) && LOGICAL.has(value.operatorToken.kind))
    return [
      { node: value.left, role },
      { node: value.right, role },
    ];
  if (isIdentifier(value)) return named(value, role, context);
  return atom(value) ? [] : undefined;
}

/** A value that is no object: `null`, a literal, a function, a class. */
function atom(value: Expression): boolean {
  return (
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    isNumericLiteral(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value)
  );
}

/** The fields of a descriptor that hold what the array keeps: its getter, its setter and its value. */
const KEPT: ReadonlySet<string> = new Set(['get', 'set', 'value']);

/**
 * Whether a field is a function that names `this` and is kept by the array, so that it runs with the
 * array as `this`: any field of a source, the getter, the setter or the value of a descriptor. Another
 * field of a descriptor is only read, with the descriptor as `this`.
 */
function runsOnArray(field: ObjectLiteralElementLike, role: Role): boolean {
  if (isSpreadAssignment(field) || !fieldNamesThis(field)) return false;
  if (role !== 'descriptor') return true;
  const { name } = field;
  return !(isIdentifier(name) || isStringLiteral(name)) || KEPT.has(name.text);
}

/**
 * What a literal object stands for: none for a method of a pattern's source, which no reader follows,
 * nor for a function that names `this`, which runs with the array as `this`.
 */
function objectOf(value: ObjectLiteralExpression, role: Role): readonly Consulted[] | undefined {
  if (value.properties.some((each) => runsOnArray(each, role))) return undefined;
  if (role === 'pattern' && value.properties.some((each) => isMethodDeclaration(each)))
    return undefined;
  const inner: Role = role === 'map' ? 'descriptor' : role;
  return value.properties.flatMap((each): Consulted[] => {
    if (isSpreadAssignment(each)) return [{ node: each.expression, role }];
    if (role !== 'map' && role !== 'pattern') return [];
    if (isPropertyAssignment(each)) return [{ node: each.initializer, role: inner }];
    return isShorthandPropertyAssignment(each) && isIdentifier(each.name)
      ? [{ node: each.name, role: inner }]
      : [];
  });
}

/** The argument an element of a list stands for: a spread is a list in the role, an entry a descriptor of a map. */
function entryOf(element: Expression, role: Role): readonly Consulted[] {
  if (isOmittedExpression(element)) return [];
  if (isSpreadElement(element)) return [{ node: element.expression, role }];
  return role === 'descriptor' || role === 'pattern' ? [{ node: element, role }] : [];
}

/**
 * Whether a declaration without an initializer is given a value elsewhere: a loop head gives it one
 * for each turn, and an assignment, a pattern or a declaration again gives the others one. A value
 * given so is no form the compile has read.
 */
function givenLater(declaration: VariableDeclaration): boolean {
  const list = declaration.parent;
  const head =
    isVariableDeclarationList(list) &&
    (isForOfStatement(list.parent) || isForInStatement(list.parent));
  return head || writtenAsWhole(declaration);
}

/** The initializer a name stands for, once, where it is a constant followed and read as known. */
function named(name: Identifier, role: Role, context: Context): readonly Consulted[] | undefined {
  if (!readsBinding(name)) return name.text === 'undefined' ? [] : undefined;
  const selected = frameBindingOf(name);
  if (selected === undefined) return [];
  if (selected.keys.length > 0) return undefined;
  const declaration = selected.binding;
  if (!isVariableDeclaration(declaration) || context.seen.has(declaration)) return [];
  context.seen.add(declaration);
  const { initializer } = declaration;
  if (initializer === undefined) return givenLater(declaration) ? undefined : [];
  if (atom(unwrapped(initializer))) return [];
  if (!knownUsesOnly(declaration, 'held')) return undefined;
  context.held?.(declaration);
  return [{ node: initializer, role }];
}
