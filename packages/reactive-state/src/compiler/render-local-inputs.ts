import {
  type BindingElement,
  type Block,
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  type GetAccessorDeclaration,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isComputedPropertyName,
  isDeleteExpression,
  isElementAccessExpression,
  isFunctionLikeDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type PropertyAccessExpression,
  type PropertyAssignment,
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
import { pushBoundTagPaths, tagPathKey, type TagPath } from './render-raw-tag-calls.ts';
import {
  pushArrayCallTagPaths,
  pushArrayIdentifierTagPaths,
  pushArrayLiteralTagPaths,
} from './render-raw-tag-paths.ts';
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

type ObjectStep = 'keep' | 'masked' | 'stop';

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

/** Constant, multi-branch, reflected, bound and destructured tag paths that can reach native String.raw. */
function maySelectNativeRaw(tag: Expression): boolean {
  const pending: TagPath[] = [{ node: tag, suffix: [] }];
  const seen = new Set<string>();
  let steps = 0;
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    steps += 1;
    if (steps > TAG_SEARCH.limit) return true;
    const value = unwrapped(current.node);
    const key = tagPathKey(value, current.suffix);
    if (seen.has(key)) continue;
    seen.add(key);
    if (matchesDirectRawTag(value, current.suffix)) return true;
    if (globalPathOf(value) === undefined && expandTagPath(value, current.suffix, tag, pending))
      return true;
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

/** Expands one non-global tag expression into the receiver, bound, array or binding sources it may read. */
function expandTagPath(
  value: Expression,
  suffix: readonly (string | undefined)[],
  rootRead: Expression,
  pending: TagPath[],
): boolean {
  if (
    isCallExpression(value) &&
    suffix.length === 0 &&
    pushBoundTagPaths(
      value,
      (inner, innerSuffix, nextPending) =>
        expandNonBoundTagPath(inner, innerSuffix, rootRead, nextPending),
      pending,
    )
  ) {
    return true;
  }
  return expandNonBoundTagPath(value, suffix, rootRead, pending);
}

function expandNonBoundTagPath(
  value: Expression,
  suffix: readonly (string | undefined)[],
  rootRead: Expression,
  pending: TagPath[],
): boolean {
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    pushMemberTagPaths(value.expression, framedMemberNames(value), suffix, pending);
    return false;
  }
  if (isCallExpression(value)) {
    pushReflectedTagPaths(value, suffix, pending);
    if (pushArrayCallTagPaths(value, suffix, pending)) return true;
  }
  const sources = framedSourceValues(value);
  if (sources !== undefined) {
    for (const source of sources) pending.push({ node: source, suffix });
    return false;
  }
  if (isArrayLiteralExpression(value) && suffix.length > 0) {
    pushArrayLiteralTagPaths(value, suffix, pending);
    return false;
  }
  if (isObjectLiteralExpression(value) && suffix.length > 0) {
    pushObjectTagPaths(value, suffix, pending);
    return false;
  }
  if (
    isNewExpression(value) &&
    suffix.length > 0 &&
    suffix[0] === undefined &&
    globalPathOf(unwrapped(value.expression))?.join('.') === 'Set' &&
    value.arguments?.[0] !== undefined
  ) {
    pending.push({ node: value.arguments[0], suffix });
    return false;
  }
  return isIdentifier(value) && pushIdentifierTagPaths(value, suffix, rootRead, pending);
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

/** Right-to-left own-property scan so unconditional later entries override earlier entries and spreads. */
function pushObjectTagPaths(
  literal: ObjectLiteralExpression,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
): void {
  let setterMasked = false;
  let prototype: Expression | undefined;
  for (const property of literal.properties.toReversed()) {
    if (isPropertyAssignment(property) && isPrototypeProperty(property)) {
      prototype ??= property.initializer;
      continue;
    }
    const outcome = stepObjectTagProperty(property, suffix, setterMasked, pending);
    if (outcome === 'stop') return;
    if (outcome === 'masked') setterMasked = true;
  }
  if (!setterMasked && prototype !== undefined) {
    pending.push({ node: prototype, suffix: prototypeSuffix(suffix) });
  }
}

function prototypeSuffix(suffix: readonly (string | undefined)[]): readonly (string | undefined)[] {
  return suffix[0] === '__proto__' ? suffix.slice(1) : suffix;
}

function isPrototypeProperty(property: PropertyAssignment): boolean {
  return (
    !isComputedPropertyName(property.name) && assignedNames(property.name)?.[0] === '__proto__'
  );
}

function stepObjectTagProperty(
  property: ObjectLiteralElementLike,
  suffix: readonly (string | undefined)[],
  setterMasked: boolean,
  pending: TagPath[],
): ObjectStep {
  const [head] = suffix;
  if (isSpreadAssignment(property)) {
    if (!setterMasked) pending.push({ node: property.expression, suffix });
    return 'keep';
  }
  if (isGetAccessorDeclaration(property)) return stepGetterProperty(property, suffix, pending);
  if (isSetAccessorDeclaration(property)) {
    return exactObjectKey(assignedNames(property.name), head) ? 'masked' : 'keep';
  }
  return stepDataProperty(property, suffix, setterMasked, pending);
}

function stepGetterProperty(
  getter: GetAccessorDeclaration,
  suffix: readonly (string | undefined)[],
  pending: TagPath[],
): ObjectStep {
  const [head, ...rest] = suffix;
  const names = assignedNames(getter.name);
  if (matchesObjectKey(names, head) && getter.body !== undefined) {
    for (const expression of returnedExpressions(getter.body)) {
      pending.push({ node: expression, suffix: rest });
    }
  }
  return exactObjectKey(names, head) ? 'stop' : 'keep';
}

function returnedExpressions(body: Block): readonly Expression[] {
  const expressions: Expression[] = [];
  const pending: Node[] = [...body.statements];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isFunctionLikeDeclaration(node)) continue;
    if (isReturnStatement(node)) {
      if (node.expression !== undefined) expressions.push(node.expression);
      continue;
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return expressions;
}

function stepDataProperty(
  property: ObjectLiteralElementLike,
  suffix: readonly (string | undefined)[],
  setterMasked: boolean,
  pending: TagPath[],
): ObjectStep {
  const [head, ...rest] = suffix;
  if (isShorthandPropertyAssignment(property)) {
    return isIdentifier(property.name)
      ? stepShorthandProperty(property.name, suffix, setterMasked, pending)
      : 'keep';
  }
  if (isMethodDeclaration(property)) {
    return exactObjectKey(assignedNames(property.name), head) ? 'stop' : 'keep';
  }
  if (!isPropertyAssignment(property)) return 'keep';
  const names = assignedNames(property.name);
  if (!setterMasked && matchesObjectKey(names, head)) {
    pending.push({ node: property.initializer, suffix: rest });
  }
  return exactObjectKey(names, head) ? 'stop' : 'keep';
}

function stepShorthandProperty(
  name: Identifier,
  suffix: readonly (string | undefined)[],
  setterMasked: boolean,
  pending: TagPath[],
): ObjectStep {
  const [head, ...rest] = suffix;
  if (!setterMasked && (head === undefined || head === name.text)) {
    pending.push({ node: name, suffix: rest });
  }
  return head === name.text ? 'stop' : 'keep';
}

function matchesObjectKey(names: readonly string[] | undefined, head: string | undefined): boolean {
  return head === undefined || names === undefined || names.includes(head);
}

function exactObjectKey(names: readonly string[] | undefined, head: string | undefined): boolean {
  return head !== undefined && names?.length === 1 && names[0] === head;
}

function pushIdentifierTagPaths(
  name: Identifier,
  suffix: readonly (string | undefined)[],
  rootRead: Expression,
  pending: TagPath[],
): boolean {
  for (const source of framedAssignedSources(name)) {
    pending.push({ node: source.value, suffix: [...source.keys, ...suffix] });
  }
  if (pushArrayIdentifierTagPaths(name, suffix, rootRead, pending)) return true;
  const declared = frameDeclarationOf(name);
  if (
    declared === undefined ||
    (!isVariableDeclaration(declared) && !isParameterDeclaration(declared))
  )
    return false;
  const bound = bindingElementOf(declared, name.text);
  if (bound?.initializer !== undefined) pending.push({ node: bound.initializer, suffix });
  const selected = frameBindingOf(name);
  if (selected !== undefined) {
    if (selected.binding.initializer !== undefined)
      pending.push({ node: selected.binding.initializer, suffix: [...selected.keys, ...suffix] });
    return false;
  }
  if (bound !== undefined) pushComputedBindingTagPaths(bound, suffix, pending);
  return false;
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
