import {
  type Expression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { isTakenApart, useOf } from './code-globals.ts';
import { sourceArrayFunction, sourceArrayMethod } from './framed-array-functions.ts';
import { frameMemberName } from './framed-bindings.ts';
import { computedBindingContainer, framedKeyNames, framedMemberNames } from './framed-keys.ts';
import { assignedNames, localDateOwnData, localDateOwnMethod } from './local-date-inputs.ts';
import { dateText, localNamed, localRead } from './local-reads.ts';
import { renderDateText } from './render-date-text.ts';
import { renderIntlInput } from './render-intl-inputs.ts';
import { reflectedRead } from './render-intl-reflections.ts';

/** What a read takes a method of, where the code shows it: the value, and the keys selected within it. */
interface Receiver {
  readonly source: Expression;
  readonly keys: readonly string[];
}

/** What a pattern's entry takes: the names it may take, and what it takes them of. */
interface Taken {
  readonly names: readonly string[] | undefined;
  readonly receiver: Receiver | undefined;
}

/** Locale-sensitive native render reads, with source-proven own functions and local date data retained. */
const LOCALE_MEMBERS: ReadonlySet<string> = new Set([
  'localeCompare',
  'toLocaleLowerCase',
  'toLocaleString',
  'toLocaleUpperCase',
]);

/**
 * Native locale members and a formatter's methods — read as a member, by `Reflect.get`, or taken
 * apart — and native Date text retain the render environment as an untracked input.
 */
export function renderLocalInput(node: Node): string | undefined {
  if (isBindingElement(node)) return renderIntlInput(node) ?? patternLocaleMember(node);
  if (isCallExpression(node))
    return (
      renderIntlInput(node) ?? reflectedLocaleMember(node) ?? renderDateText(node) ?? dateText(node)
    );
  if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
    if (writeOnly(node)) return undefined;
    const formatter = renderIntlInput(node);
    if (formatter !== undefined) return formatter;
    const name = frameMemberName(node);
    if (name !== undefined && LOCALE_MEMBERS.has(name))
      return sourceArrayFunction(node) || localDateOwnData(node) ? undefined : localRead(node);
  }
  return patternLocaleMember(node) ?? renderDateText(node) ?? dateText(node);
}

/**
 * A native locale member a source-known `Reflect.get` reads (`reflectedRead`), as its member read;
 * none by a key the compile cannot read.
 */
function reflectedLocaleMember(node: Node): string | undefined {
  const read = reflectedRead(node);
  if (read?.key === undefined) return undefined;
  return localeMemberOf(framedKeyNames(read.key), { keys: [], source: read.target });
}

/**
 * A native locale member an object pattern takes apart, as its member read: `const {
 * toLocaleString } = Number.prototype`, renamed, by a literal or constant key in brackets, within
 * another pattern, a parameter's or a loop's, or assigned, `({ toLocaleString: format } = value)`;
 * none of a rest, nor by a key the compile cannot read.
 */
function patternLocaleMember(node: Node): string | undefined {
  const taken = takenOf(node);
  return taken === undefined ? undefined : localeMemberOf(taken.names, taken.receiver);
}

/**
 * What an object pattern's entry takes, of what the code shows it takes it of — a variable's or a
 * parameter's initializer, with the keys of the patterns it is within, or what an assignment
 * assigns its pattern written whole — or of what the code does not show: an assignment's pattern
 * within another, an array's, a default's target or a loop's (`isTakenApart`); none of a rest.
 */
function takenOf(node: Node): Taken | undefined {
  if (isBindingElement(node)) {
    if (!isObjectBindingPattern(node.parent) || node.dotDotDotToken !== undefined) return undefined;
    const selected = computedBindingContainer(node);
    const source = selected?.binding.initializer;
    return {
      names: framedMemberNames(node),
      receiver: source === undefined ? undefined : { keys: selected?.keys ?? [], source },
    };
  }
  if (!isPropertyAssignment(node) && !isShorthandPropertyAssignment(node)) return undefined;
  const literal = node.parent;
  return isObjectLiteralExpression(literal) && isTakenApart(literal)
    ? { names: assignedNames(node.name), receiver: assignedReceiver(literal) }
    : undefined;
}

/**
 * What an assignment takes the pattern `literal` apart of, where it is the pattern written whole
 * on its left, `({ toLocaleString: format } = value)`: none where the assignment is itself a
 * pattern's default, whose value it holds where the value taken apart is none.
 */
function assignedReceiver(literal: ObjectLiteralExpression): Receiver | undefined {
  const { at, parent } = useOf(literal);
  return isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === at &&
    !isTakenApart(parent)
    ? { keys: [], source: parent.right }
    : undefined;
}

/**
 * The input of a locale member a read may take by `names`, of any receiver, as the member read's
 * rule says: none of a source-written method (`sourceArrayMethod`) or a date's literal own method
 * of a receiver the code shows.
 */
function localeMemberOf(
  names: readonly string[] | undefined,
  receiver: Receiver | undefined,
): string | undefined {
  const name = names?.find((each) => LOCALE_MEMBERS.has(each) && !ownMethod(receiver, each));
  return name === undefined ? undefined : localNamed(name);
}

/** Whether the code shows the method `receiver` holds by `name` its own: written, or a date's literal. */
function ownMethod(receiver: Receiver | undefined, name: string): boolean {
  if (receiver === undefined) return false;
  const { keys, source } = receiver;
  return (
    sourceArrayMethod(source, [...keys, name]) ||
    (keys.length === 0 && localDateOwnMethod(source, [name]))
  );
}

/** A plain target write or deletion does not read the method stored there. */
function writeOnly(node: Expression): boolean {
  const { at, parent } = useOf(unwrapped(node));
  return (
    isDeleteExpression(parent) ||
    (isBinaryExpression(parent) &&
      parent.operatorToken.kind === SyntaxKind.EqualsToken &&
      parent.left === at)
  );
}
