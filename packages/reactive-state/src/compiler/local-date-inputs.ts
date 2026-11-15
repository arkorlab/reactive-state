import {
  type BinaryExpression,
  type BindingElement,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrowFunction,
  isBinaryExpression,
  isBindingElement,
  isBlock,
  isComputedPropertyName,
  isDeleteExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type Node,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, isTakenApart, useOf } from './code-globals.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { computedBindingContainer, framedKeyNames, framedMemberNames } from './framed-keys.ts';
import { framedSourceValues } from './framed-sources.ts';
import { framedAssignedValues } from './framed-writes.ts';
import { localDateProjection } from './local-date-projections.ts';
import { LOCAL_METHODS } from './local-reads.ts';
import { reflectedRead } from './render-intl-reflections.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Source-known native date members that read the runtime's local time zone. */

const TEXT_METHODS: ReadonlySet<string> = new Set([
  'localeCompare',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
]);
/** The untracked input a native Date method of local time is, or a date made in local time. */
export const LOCAL_TIME = 'Date.localTime';
function dateMethod(name: string): boolean {
  return name === 'toString' || (LOCAL_METHODS.has(name) && !TEXT_METHODS.has(name));
}

/** Native local-time methods retain an untracked input even when construction used a fixed instant. */
export function localDateInput(node: Node): string | undefined {
  const reflected = reflectedDateInput(node) ?? boundDateInput(node);
  if (reflected !== undefined) return reflected;
  if (!isPropertyAccessExpression(node) && !isElementAccessExpression(node)) return undefined;
  if (writeOnly(node)) return undefined;
  const names = framedMemberNames(node);
  if (names?.every((name) => !dateMethod(name)) === true) return undefined;
  const receiver = unwrapped(node.expression);
  if (!sourceDate(receiver) || literalOwnMethod(receiver, names)) return undefined;
  return LOCAL_TIME;
}

/** A plain assignment or deletion does not read the function stored in that member. */
function writeOnly(node: Expression): boolean {
  const { at, parent } = useOf(node);
  return (
    isDeleteExpression(parent) ||
    (isBinaryExpression(parent) &&
      parent.operatorToken.kind === SyntaxKind.EqualsToken &&
      parent.left === at)
  );
}

/** Native constructions, transparent results and lexical source assignments retain possible dates. */
function sourceDate(node: Expression): boolean {
  if (localDateProjection(node)) return true;
  const pending: Expression[] = [node];
  const seen = new Set<Node>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapped(next);
    if (seen.has(value)) continue;
    seen.add(value);
    if (isNewExpression(value) && globalPathOf(unwrapped(value.expression))?.join('.') === 'Date')
      return true;
    const values = framedSourceValues(value);
    if (values !== undefined) {
      pending.push(...values);
      continue;
    }
    if (!isIdentifier(value)) continue;
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0) continue;
    if (selected.binding.initializer !== undefined) pending.push(selected.binding.initializer);
    pending.push(...framedAssignedValues(value));
  }
  return false;
}

/** One unexposed constant instance can keep an unconditional literal-returning own method. */
function literalOwnMethod(node: Expression, names: readonly string[] | undefined): boolean {
  if (!isIdentifier(node) || names?.length !== 1) return false;
  const selected = frameBindingOf(node);
  if (selected === undefined || selected.keys.length > 0) return false;
  const { binding } = selected;
  if (
    !isVariableDeclaration(binding) ||
    !isVariableDeclarationList(binding.parent) ||
    !/^const\s/u.test(binding.parent.getText(binding.getSourceFile())) ||
    binding.initializer === undefined
  )
    return false;
  const made = unwrapped(binding.initializer);
  if (!isNewExpression(made) || globalPathOf(unwrapped(made.expression))?.join('.') !== 'Date')
    return false;
  if (executionOwner(node) !== executionOwner(binding)) return false;
  const statement = binding.parent.parent;
  if (!isVariableStatement(statement)) return false;
  return singleLiteralOverride(node, binding, statement.parent, names[0]);
}

/** Every other reference is the one literal override; no hidden alias or closure can change it. */
function singleLiteralOverride(
  node: Identifier,
  binding: VariableDeclaration,
  block: Node,
  name: string | undefined,
): boolean {
  let overrides = 0;
  const pending: Node[] = [binding.getSourceFile()];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isTypeOnly(at)) continue;
    if (
      at !== node &&
      at !== binding.name &&
      isIdentifier(at) &&
      at.text === node.text &&
      readsBinding(at) &&
      frameDeclarationOf(at) === binding
    ) {
      if (!literalOverride(at, name, node, block)) return false;
      overrides += 1;
    }
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return overrides === 1;
}

/** The only other instance use writes that literal method in the same unconditional prefix. */
function literalOverride(
  node: Identifier,
  name: string | undefined,
  read: Identifier,
  block: Node,
): boolean {
  const { at: receiver, parent: member } = useOf(node);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    member.expression !== receiver ||
    frameMemberName(member) !== name
  )
    return false;
  const { at, parent } = useOf(member);
  return (
    isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === at &&
    parent.pos < read.pos &&
    isExpressionStatement(parent.parent) &&
    parent.parent.parent === block &&
    literalFunction(parent.right)
  );
}

/** A zero-argument written function returning only primitive literal syntax has no local-time read. */
function literalFunction(node: Expression): boolean {
  const value = unwrapped(node);
  if (!isArrowFunction(value) && !isFunctionExpression(value)) return false;
  if (value.parameters.length > 0) return false;
  if (isFunctionExpression(value) && value.asteriskToken !== undefined) return false;
  if (value.modifiers?.some((each) => each.kind === SyntaxKind.AsyncKeyword) === true) return false;
  const body = value.body;
  if (!isBlock(body)) return literalValue(body);
  const [statement] = body.statements;
  return (
    body.statements.length === 1 &&
    statement !== undefined &&
    isReturnStatement(statement) &&
    statement.expression !== undefined &&
    literalValue(statement.expression)
  );
}

/** Primitive literal returns do not call application code or read an environment. */
function literalValue(node: Expression): boolean {
  const value = unwrapped(node);
  return (
    isNumericLiteral(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.NullKeyword
  );
}

/** Whether this selected native date method already has the narrow literal own-data proof. */
export function localDateOwnData(node: Node): boolean {
  if (!isPropertyAccessExpression(node) && !isElementAccessExpression(node)) return false;
  return localDateOwnMethod(node.expression, framedMemberNames(node));
}

/** Whether a source-known native date `receiver` has the narrow literal own-data proof of `names`. */
export function localDateOwnMethod(
  receiver: Expression,
  names: readonly string[] | undefined,
): boolean {
  const value = unwrapped(receiver);
  return sourceDate(value) && literalOwnMethod(value, names);
}

/**
 * A reflected native Date method retains its local-time input before later invocation: of a
 * source-known native `Reflect.get` (`reflectedRead`), written, a whole immutable alias, borrowed by
 * `call` or `apply`, or applied by `Reflect.apply`; by a key the compile cannot read too.
 */
function reflectedDateInput(node: Node): string | undefined {
  const read = reflectedRead(node);
  if (read === undefined || !sourceDate(read.target)) return undefined;
  const { key, target } = read;
  const names = key === undefined ? undefined : framedKeyNames(key);
  if (
    names?.every((name) => !dateMethod(name)) === true ||
    literalOwnMethod(unwrapped(target), names)
  )
    return undefined;
  return LOCAL_TIME;
}

/** What a pattern may take a method apart of: a value, and the keys selected within it. */
interface Source {
  readonly source: Expression;
  readonly keys: readonly string[];
}

/** What a pattern's entry takes apart: each value it may take it of, and the entry's names. */
interface TakenApart {
  readonly sources: readonly Source[];
  readonly names: readonly string[] | undefined;
}

/**
 * A native Date method a pattern takes apart retains its local-time input as a member read does,
 * before it is called: `const { getHours } = date`, renamed, by a key in brackets, of a stored date
 * through a pattern within another, of a pattern's default, or assigned, `({ getHours: hours } =
 * date)` — of any value it may take it of (`takenApart`).
 */
function boundDateInput(node: Node): string | undefined {
  const taken = takenApart(node);
  if (taken === undefined || taken.names?.every((name) => !dateMethod(name)) === true)
    return undefined;
  const { names, sources } = taken;
  return sources.some((each) => localSource(each, names)) ? LOCAL_TIME : undefined;
}

/** Whether `each` holds a source-known native Date, of no literal own method by `names`. */
function localSource({ keys, source }: Source, names: readonly string[] | undefined): boolean {
  if (keys.length > 0) return localDateProjection(source, keys);
  const receiver = unwrapped(source);
  return sourceDate(receiver) && !literalOwnMethod(receiver, names);
}

/**
 * What an object pattern's entry takes apart: a variable's or a parameter's initializer, with the
 * keys of the patterns it is within, and the default of each pattern it is within, which it takes
 * apart where the value is none (`patternDefaults`); or what an assignment's pattern may take
 * apart (`assignedSources`). None of a rest, which copies own entries alone.
 */
function takenApart(node: Node): TakenApart | undefined {
  if (isBindingElement(node) && isObjectBindingPattern(node.parent)) {
    if (node.dotDotDotToken !== undefined) return undefined;
    const selected = computedBindingContainer(node);
    const source = selected?.binding.initializer;
    const sources = [
      ...(selected === undefined || source === undefined ? [] : [{ keys: selected.keys, source }]),
      ...patternDefaults(node),
    ];
    return sources.length === 0 ? undefined : { names: framedMemberNames(node), sources };
  }
  if (!isPropertyAssignment(node) && !isShorthandPropertyAssignment(node)) return undefined;
  const literal = node.parent;
  const sources = isObjectLiteralExpression(literal) ? assignedSources(literal) : [];
  return sources.length === 0 ? undefined : { names: assignedNames(node.name), sources };
}

/**
 * The default of each pattern `element` is within, with the keys it takes `element` apart by below
 * it: `fallback` of `const { a: { getHours } = fallback } = holder`, which it takes apart where
 * `holder.a` is none.
 */
function patternDefaults(element: BindingElement): readonly Source[] {
  const found: Source[] = [];
  const keys: string[] = [];
  for (let owner = element.parent.parent; isBindingElement(owner); owner = owner.parent.parent) {
    if (owner.initializer !== undefined) found.push({ keys: [...keys], source: owner.initializer });
    const pattern = owner.parent;
    const key = isArrayBindingPattern(pattern)
      ? String(pattern.elements.indexOf(owner))
      : frameMemberName(owner);
    if (key === undefined) break;
    keys.unshift(key);
  }
  return found;
}

/**
 * What an assignment's pattern `literal` may take apart: what the assignment assigns, where it is
 * the pattern written whole on its left; where that assignment is a pattern's default
 * (`isTakenApart`) — `({ a: { getHours: hours } = fallback } = holder)` — the default, and what the
 * pattern it is within takes apart at its key, where that one is written whole so; none of another.
 */
function assignedSources(literal: ObjectLiteralExpression): readonly Source[] {
  const assigned = assignmentOf(literal);
  if (assigned === undefined) return [];
  const own = { keys: [], source: assigned.right };
  if (!isTakenApart(assigned)) return [own];
  const { at, parent: entry } = useOf(assigned);
  const names =
    isPropertyAssignment(entry) && entry.initializer === at ? assignedNames(entry.name) : undefined;
  const outer =
    names?.length === 1 && isObjectLiteralExpression(entry.parent)
      ? assignmentOf(entry.parent)
      : undefined;
  return outer === undefined || isTakenApart(outer)
    ? [own]
    : [own, { keys: names ?? [], source: outer.right }];
}

/** The assignment `literal` is the left of, past what wraps it alike. */
function assignmentOf(literal: ObjectLiteralExpression): BinaryExpression | undefined {
  const { at, parent } = useOf(literal);
  return isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === at
    ? parent
    : undefined;
}

/** The names an assignment pattern's entry reads: its written name, or a key in brackets read. */
export function assignedNames(name: PropertyName): readonly string[] | undefined {
  if (isComputedPropertyName(name)) return framedKeyNames(name.expression);
  return isIdentifier(name) || isStringLiteral(name) || isNumericLiteral(name)
    ? [name.text]
    : undefined;
}
