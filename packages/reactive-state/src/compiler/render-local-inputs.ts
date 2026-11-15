import {
  type BindingElement,
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isIdentifier,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type PropertyAccessExpression,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { GLOBAL_OBJECTS, globalPathOf, isTakenApart, useOf } from './code-globals.ts';
import { sourceArrayFunction, sourceArrayMethod } from './framed-array-functions.ts';
import { frameBindingOf, frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { computedBindingContainer, framedKeyNames, framedMemberNames } from './framed-keys.ts';
import { framedNativeConstructor, framedSourceValues } from './framed-sources.ts';
import { framedAssignedSources } from './framed-writes.ts';
import { assignedNames, localDateOwnData, localDateOwnMethod } from './local-date-inputs.ts';
import { dateText, localNamed } from './local-reads.ts';
import { renderDateText } from './render-date-text.ts';
import { renderIntlInput } from './render-intl-inputs.ts';
import { reflectedRead } from './render-intl-reflections.ts';
import { bindingIdentifiers } from './scope.ts';

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

interface TagPath {
  readonly node: Expression;
  readonly suffix: readonly (string | undefined)[];
}

/** Locale-sensitive native render reads, with source-proven own functions and local date data retained. */
const LOCALE_MEMBERS: ReadonlySet<string> = new Set([
  'localeCompare',
  'toLocaleLowerCase',
  'toLocaleString',
  'toLocaleUpperCase',
]);
const RAW_TAGS: ReadonlySet<string> = new Set(['String.raw']);
const TAG_SEARCH = { limit: 64 } as const;

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
    const member = renderIntlInput(node) ?? memberLocaleInput(node);
    if (member !== undefined) return member;
  }
  return patternLocaleMember(node) ?? renderDateText(node) ?? localDateText(node);
}

/** Tagged templates pass Date substitutions raw unless a tag path can select native String.raw. */
function localDateText(node: Node): string | undefined {
  const text = dateText(node);
  if (
    text !== undefined &&
    isTemplateExpression(node) &&
    isTaggedTemplateExpression(node.parent) &&
    node.parent.template === node &&
    !maySelectNativeRaw(node.parent.tag)
  )
    return undefined;
  return text;
}

/** Constant, multi-branch, reflected and destructured tag paths that can reach native String.raw. */
function maySelectNativeRaw(tag: Expression): boolean {
  const pending: TagPath[] = [{ node: tag, suffix: [] }];
  const seen = new Set<string>();
  let steps = 0;
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    steps += 1;
    if (steps > TAG_SEARCH.limit) return true;
    const value = unwrapped(current.node);
    const key = `${value.pos}:${value.end}:${current.suffix.map((part) => part ?? '*').join('.')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (matchesDirectRawTag(value, current.suffix)) return true;
    if (globalPathOf(value) === undefined) expandTagPath(value, current.suffix, pending);
  }
  return false;
}

/** Direct native String.raw references and global holders followed by remaining member segments. */
function matchesDirectRawTag(value: Expression, suffix: readonly (string | undefined)[]): boolean {
  if (suffix.length === 0 && framedNativeConstructor(value, RAW_TAGS)) return true;
  const direct = globalPathOf(value);
  return direct !== undefined && matchesNativeRawPath([...direct, ...suffix]);
}

/** Leading global-object segments collapse before checking the String.raw member pair. */
function matchesNativeRawPath(parts: readonly (string | undefined)[]): boolean {
  let index = 0;
  while (parts.length - index > 2 && isPossibleGlobalHolder(parts[index])) index += 1;
  while (parts.length - index > 1 && isKnownGlobalHolder(parts[index])) index += 1;
  if (parts.length - index !== 2) return false;
  const holder = parts[index];
  const member = parts[index + 1];
  return (
    (holder === undefined || holder === 'String') && (member === undefined || member === 'raw')
  );
}

function isKnownGlobalHolder(name: string | undefined): boolean {
  return name !== undefined && GLOBAL_OBJECTS.has(name);
}

function isPossibleGlobalHolder(name: string | undefined): boolean {
  return name === undefined || GLOBAL_OBJECTS.has(name);
}

/** Expands one non-global tag expression into the receiver or binding sources it may read. */
function expandTagPath(
  value: Expression,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
): void {
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    pushMemberTagPaths(value.expression, framedMemberNames(value), suffix, pending);
    return;
  }
  if (isCallExpression(value)) {
    pushReflectedTagPaths(value, suffix, pending);
    return;
  }
  const sources = framedSourceValues(value);
  if (sources !== undefined) {
    for (const source of sources) pending.push({ node: source, suffix });
    return;
  }
  if (isObjectLiteralExpression(value) && suffix.length > 0) {
    pushObjectTagPaths(value, suffix, pending);
    return;
  }
  if (isIdentifier(value)) pushIdentifierTagPaths(value, suffix, pending);
}

function pushReflectedTagPaths(
  call: CallExpression,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
): void {
  const read = reflectedRead(call);
  if (read === undefined) return;
  const names = read.key === undefined ? undefined : framedKeyNames(read.key);
  pushMemberTagPaths(read.target, names, suffix, pending);
}

function pushMemberTagPaths(
  receiver: Expression,
  names: readonly string[] | undefined,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
): void {
  if (names === undefined) {
    pending.push({ node: receiver, suffix: [undefined, ...suffix] });
    return;
  }
  for (const name of names) pending.push({ node: receiver, suffix: [name, ...suffix] });
}

function pushObjectTagPaths(
  literal: ObjectLiteralExpression,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
): void {
  const [head, ...rest] = suffix;
  for (const property of literal.properties) {
    if (isSpreadAssignment(property)) {
      pending.push({ node: property.expression, suffix });
    } else if (
      isPropertyAssignment(property) &&
      matchesObjectKey(assignedNames(property.name), head)
    ) {
      pending.push({ node: property.initializer, suffix: rest });
    } else if (
      isShorthandPropertyAssignment(property) &&
      isIdentifier(property.name) &&
      (head === undefined || head === property.name.text)
    ) {
      pending.push({ node: property.name, suffix: rest });
    }
  }
}

function matchesObjectKey(names: readonly string[] | undefined, head: string | undefined): boolean {
  return head === undefined || names === undefined || names.includes(head);
}

function pushIdentifierTagPaths(
  name: Identifier,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
): void {
  for (const source of framedAssignedSources(name)) {
    pending.push({ node: source.value, suffix: [...source.keys, ...suffix] });
  }
  const declared = frameDeclarationOf(name);
  if (
    declared === undefined ||
    (!isVariableDeclaration(declared) && !isParameterDeclaration(declared))
  )
    return;
  const bound = bindingElementOf(declared, name.text);
  if (bound?.initializer !== undefined) pending.push({ node: bound.initializer, suffix });
  const selected = frameBindingOf(name);
  if (selected !== undefined) {
    if (selected.binding.initializer !== undefined)
      pending.push({ node: selected.binding.initializer, suffix: [...selected.keys, ...suffix] });
    return;
  }
  if (bound !== undefined) pushComputedBindingTagPaths(bound, suffix, pending);
}

function bindingElementOf(
  declared: ParameterDeclaration | VariableDeclaration,
  text: string,
): BindingElement | undefined {
  const found = bindingIdentifiers(declared.name).find((identifier) => identifier.text === text);
  return found !== undefined && isBindingElement(found.parent) ? found.parent : undefined;
}

function pushComputedBindingTagPaths(
  bound: BindingElement,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
): void {
  const container = computedBindingContainer(bound);
  if (container?.binding.initializer === undefined) return;
  const source = container.binding.initializer;
  const names = framedMemberNames(bound);
  if (names === undefined) {
    pending.push({ node: source, suffix: [...container.keys, undefined, ...suffix] });
    return;
  }
  for (const name of names) {
    pending.push({ node: source, suffix: [...container.keys, name, ...suffix] });
  }
}

/** Direct, constant-key and multi-branch bracket reads retain native locale methods unless own. */
function memberLocaleInput(
  node: ElementAccessExpression | PropertyAccessExpression,
): string | undefined {
  const name = frameMemberName(node);
  if (name === undefined)
    return localeMemberOf(framedMemberNames(node), { keys: [], source: node.expression });
  if (!LOCALE_MEMBERS.has(name)) return undefined;
  return sourceArrayFunction(node) || localDateOwnData(node) ? undefined : localNamed(name);
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
