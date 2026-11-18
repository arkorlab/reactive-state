import {
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { framedAccessorTakes, framedLiteralAccessor } from './framed-member-accessors.ts';
import {
  framedHeldVariable,
  framedMemberDeletes,
  framedMemberWritesOf,
  framedPrototypeWrites,
  framedVariableWritesOf,
  type MemberDelete,
  type MemberWrite,
} from './framed-member-writes.ts';
import { framedLiteralPrototypes, framedObjectSources } from './framed-object-members.ts';
import { framedProxyValues } from './framed-receivers.ts';
import { framedReflectedObjectValues } from './framed-reflected-objects.ts';
import { framedSourceValues } from './framed-sources.ts';
import { framedAssignedSources, framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';

/** A member path read of what a variable holds, or of what an expression answers as it is given. */

/** Native calls that answer a fresh ordinary object or array, whose members a plain write replaces. */
const FRESH_RESULTS: ReadonlySet<string> = new Set(['Array.from', 'Array.of', 'Object.create']);

/** Native constructions that may answer an object they are given, a Proxy among them. */
const HANDING_CONSTRUCTORS: ReadonlySet<string> = new Set(['Object', 'Proxy']);

/** A value a read may meet on its path, with the member keys left after it. */
export interface Held {
  readonly value: Expression;
  readonly keys: readonly string[];
}

/** What a variable may hold on a member path where a read evaluates. */
export interface HeldValues {
  /** What its initializer holds there, unless a definite earlier change replaced it. */
  readonly initial: Held | undefined;
  /** The values assigned to it and written on the path that reach the read. */
  readonly held: readonly Held[];
}

/**
 * A source-written change reaching a read: where it stands and what it leaves on the path. The
 * writes of one call stand at one node and run in turn, in the order of their `order`.
 */
interface Change {
  readonly node: Node;
  readonly held: Held;
  readonly order: number;
}

/** The settings a definite change is looked for in. */
interface DefiniteSearch {
  readonly holder: VariableDeclaration;
  readonly path: readonly string[];
  readonly point: Node;
  readonly direct: boolean;
  readonly assigned: number;
}

/**
 * Whether a member path read of a variable, or of what a condition, a native identity or a Proxy
 * without an intercepting `get` answers, may select an error: `box.x` of `const box = { x: error }`
 * reads what the variable's initializer and the values assigned to it hold there, and what code
 * writes into that member (`framedHeldValues`); `new Proxy({ x: error }, {}).x` and
 * `new Object({ x: error }).x` read what the target holds there.
 */
export function framedHeldMember(
  node: Expression,
  keys: readonly string[],
  error: (value: Expression, path: readonly string[]) => boolean,
  point?: Node,
): boolean {
  let value = unwrapped(node);
  let path = keys;
  let walked = false;
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const key = frameMemberName(value);
    if (key === undefined) return false;
    path = [key, ...path];
    value = unwrapped(value.expression);
    walked = true;
  }
  if (path.length === 0) return false;
  if (isIdentifier(value)) {
    const values = framedHeldValues(value, path, node);
    const all = [
      ...(values?.held ?? []),
      ...heldPrototypes(value, path, node),
      ...deletedPrototypes(value, path, node),
    ];
    if (values?.initial !== undefined) all.push(values.initial);
    return all.some((each) => error(each.value, each.keys));
  }
  if (!walked) return false;
  const answered =
    framedSourceValues(value) ??
    framedReflectedObjectValues(value) ??
    framedProxyValues(value, point);
  return answered?.some((each) => error(each, path)) === true;
}

/**
 * What a variable may hold on a member path where a read evaluates `point`: what its initializer
 * holds there, the values assigned to it, and what code writes into that member — `box.x = error`,
 * `Object.assign(box, { x: error })`, `Object.defineProperty(box, 'x', { value })`, through whole
 * constant aliases too — before the read in the same function, from another function, or later in
 * a loop that repeats the read. A definite earlier change in the same function — a statement of a
 * block around the read, or an argument of the call that reads — replaces what came before it: a
 * plain assignment of the variable, or a write of the path into the fresh ordinary object it holds.
 */
export function framedHeldValues(
  name: Identifier,
  path: readonly string[],
  point: Node,
): HeldValues | undefined {
  const selected = frameBindingOf(name);
  if (selected === undefined || !isVariableDeclaration(selected.binding)) return undefined;
  const assigned: Change[] = framedAssignedSources(name).map((each) => {
    return {
      node: each.value,
      held: { value: each.value, keys: [...each.keys, ...path] },
      order: 0,
    };
  });
  const { initializer } = selected.binding;
  if (selected.keys.length > 0) {
    const keys = [...selected.keys, ...path];
    return {
      initial: initializer === undefined ? undefined : { value: initializer, keys },
      held: assigned.map((each) => each.held),
    };
  }
  const holder = framedHeldVariable(selected.binding);
  const changes = [...assigned, ...memberChanges(name, holder, path, point)];
  const made = capturedFrom(selected.binding, holder);
  const captured = made === undefined ? undefined : framedHeldValues(made, path, made);
  if (captured !== undefined) {
    return {
      initial: captured.initial,
      held: [...captured.held, ...changes.map((each) => each.held)],
    };
  }
  const direct = holder === selected.binding;
  const cut =
    direct || constantVariable(holder)
      ? lastDefinite({ holder, path, point, direct, assigned: assigned.length })
      : undefined;
  if (cut === undefined) {
    const initial =
      holder.initializer === undefined ? undefined : { value: holder.initializer, keys: path };
    return { initial, held: changes.map((each) => each.held) };
  }
  const later = changes.filter((each) => !replacedBy(each, cut, point));
  return { initial: undefined, held: [cut.held, ...later.map((each) => each.held)] };
}

/**
 * The names a variable's members are written by, and what writes under a key the compile cannot
 * read put there, reaching a read that evaluates `point`; the names of the literals assigned to it.
 */
export function framedHeldFields(
  name: Identifier,
  point: Node,
): { readonly names: ReadonlySet<string>; readonly unknown: readonly Held[] } | undefined {
  const selected = frameBindingOf(name);
  if (selected === undefined || !isVariableDeclaration(selected.binding)) return undefined;
  const holder = framedHeldVariable(selected.binding);
  const names = assignedFieldNames(name);
  const unknown: Held[] = [];
  const made = capturedFrom(selected.binding, holder);
  const captured = made === undefined ? undefined : framedHeldFields(made, made);
  if (captured !== undefined) {
    for (const each of captured.names) names.add(each);
    unknown.push(...captured.unknown);
  }
  for (const write of framedMemberWritesOf(name.getSourceFile(), holder)) {
    if (write.path.length !== 1 || !reaches(write.node, name, point)) continue;
    const [first] = write.path;
    if (first === undefined) unknown.push({ value: write.value, keys: [] });
    else for (const each of first) names.add(each);
  }
  return { names, unknown };
}

/**
 * Where a constant alias takes its object from a variable that is assigned again, the alias holds
 * what that variable held where the alias was made, which is read there: its initializer, what was
 * assigned to it before, and what code wrote into it. The identifier the alias names is returned.
 */
function capturedFrom(
  alias: VariableDeclaration,
  holder: VariableDeclaration,
): Identifier | undefined {
  if (alias === holder || alias.initializer === undefined || constantVariable(holder))
    return undefined;
  const made = unwrapped(alias.initializer);
  return isIdentifier(made) ? made : undefined;
}

/**
 * The prototypes code sets on what a variable holds along a read path (`framedPrototypeWrites`),
 * each read past the object it is set on, where that object's own fields may not define the rest.
 */
function heldPrototypes(name: Identifier, path: readonly string[], point: Node): readonly Held[] {
  const selected = frameBindingOf(name);
  if (selected === undefined || selected.keys.length > 0) return [];
  if (!isVariableDeclaration(selected.binding)) return [];
  const holder = framedHeldVariable(selected.binding);
  return framedPrototypeWrites(name.getSourceFile())
    .filter((write) => {
      return (
        write.holder === holder &&
        write.path.length < path.length &&
        write.path.every((names, index) => names?.includes(path[index] ?? '') !== false) &&
        reaches(write.node, name, point)
      );
    })
    .map((write) => ({ value: write.value, keys: path.slice(write.path.length) }));
}

/**
 * Where a delete, an unread-key delete or a hand-off (`framedMemberDeletes`) may remove an own field
 * a read selects, the prototype its object's initializer gives — a literal's `__proto__` entry,
 * `Object.create`'s first argument — is read for that field again, past the object.
 */
function deletedPrototypes(
  name: Identifier,
  path: readonly string[],
  point: Node,
): readonly Held[] {
  const selected = frameBindingOf(name);
  if (selected === undefined || selected.keys.length > 0) return [];
  if (!isVariableDeclaration(selected.binding)) return [];
  const holder = framedHeldVariable(selected.binding);
  const { initializer } = holder;
  if (initializer === undefined) return [];
  const deletes = framedMemberDeletes(name.getSourceFile()).filter(
    (each) => each.holder === holder && reaches(each.node, name, point),
  );
  const held: Held[] = [];
  for (const depth of path.keys()) {
    if (deletes.every((each) => !removesAt(each, path, depth))) continue;
    const prototypes = prototypesAt(initializer, path.slice(0, depth));
    for (const prototype of prototypes) held.push({ value: prototype, keys: path.slice(depth) });
  }
  return held;
}

/** Whether a change may remove the field a read path selects at a depth of its objects. */
function removesAt(change: MemberDelete, path: readonly string[], depth: number): boolean {
  const reached = change.handed ? change.path.length <= depth : change.path.length === depth + 1;
  return (
    reached && change.path.every((names, index) => names?.includes(path[index] ?? '') !== false)
  );
}

/** The prototypes of the objects a written initializer holds at a path. */
function prototypesAt(initializer: Expression, keys: readonly string[]): readonly Expression[] {
  const objects =
    keys.length === 0
      ? [initializer]
      : (framedObjectSources(initializer, keys) ?? [])
          .filter((each) => each.keys.length === 0)
          .map((each) => each.value);
  return objects.flatMap((each) => {
    const object = unwrapped(each);
    if (isObjectLiteralExpression(object)) return framedLiteralPrototypes(object);
    if (!isCallExpression(object) || globalPathOf(object.expression)?.join('.') !== 'Object.create')
      return [];
    const prototype = object.arguments[0];
    return prototype === undefined || unwrapped(prototype).kind === SyntaxKind.NullKeyword
      ? []
      : [prototype];
  });
}

/** The entry names of the object literals assigned to a variable. */
function assignedFieldNames(name: Identifier): Set<string> {
  const names = new Set<string>();
  for (const each of framedAssignedSources(name)) {
    const value = unwrapped(each.value);
    if (each.keys.length > 0 || !isObjectLiteralExpression(value)) continue;
    for (const property of value.properties) {
      const key = isSpreadAssignment(property) ? undefined : writtenArrayKey(property.name);
      if (key !== undefined) names.add(key);
    }
  }
  return names;
}

/** The member writes on the path that reach the read, with the keys each leaves. */
function memberChanges(
  name: Identifier,
  holder: VariableDeclaration,
  path: readonly string[],
  point: Node,
): readonly Change[] {
  if (path.length === 0) return [];
  const reached: Change[] = [];
  for (const [order, write] of framedMemberWritesOf(name.getSourceFile(), holder).entries()) {
    if (write.path.length > path.length) continue;
    if (write.path.some((names, index) => names?.includes(path[index] ?? '') === false)) continue;
    if (!reaches(write.node, name, point)) continue;
    reached.push({
      node: write.node,
      held: { value: write.value, keys: path.slice(write.path.length) },
      order,
    });
  }
  return reached;
}

/** Whether a write can come before a read: from another function, before it, or in a loop again. */
function reaches(write: Node, name: Identifier, point: Node): boolean {
  if (!framedPossibleBranch(write)) return false;
  const owner = executionOwner(point);
  if (executionOwner(write) !== owner || write.pos < point.end || destructuredFirst(write, point))
    return true;
  const declared = frameBindingOf(name)?.binding;
  return declared !== undefined && repeatedFrameRead(write, name, declared, owner);
}

/** The last definite change before the read: an assignment of the variable, or a member write. */
function lastDefinite(search: DefiniteSearch): Change | undefined {
  let last: Change | undefined;
  const candidates: readonly Change[] = [...reassignments(search), ...overwrites(search)];
  for (const candidate of candidates) {
    if (!definitelyBefore(candidate.node, search.point)) continue;
    if (last === undefined || stands(candidate, last)) last = candidate;
  }
  return last;
}

/** Plain assignments of the variable read directly, each replacing the object it holds. */
function reassignments({ holder, path, point, direct }: DefiniteSearch): readonly Change[] {
  if (!direct) return [];
  const writes = framedVariableWritesOf(point.getSourceFile(), holder);
  return writes.map(({ node, value }) => ({ node, held: { value, keys: path }, order: 0 }));
}

/** Member writes on the path into the fresh ordinary object a variable assigned nothing anew holds. */
function overwrites({ holder, path, point, assigned }: DefiniteSearch): readonly Change[] {
  const { initializer } = holder;
  if (initializer === undefined || assigned > 0 || !ordinaryObject(initializer)) return [];
  const writes = framedMemberWritesOf(point.getSourceFile(), holder);
  return [...writes.entries()]
    .filter(([, write]) => exactPrefix(write, path) && replacesMember(initializer, write, writes))
    .map(([order, write]) => {
      return {
        node: write.node,
        held: { value: write.value, keys: path.slice(write.path.length) },
        order,
      };
    });
}

/**
 * Whether a write puts its value in place of the member it names: a definition does; an assignment
 * or `Object.assign` does only where no accessor of the fresh object, or of the prototype
 * `Object.create` gave it, may take the name (a setter leaves its getter), along written literal
 * members that no other write may replace.
 */
function replacesMember(
  initializer: Expression,
  write: MemberWrite,
  writes: readonly MemberWrite[],
): boolean {
  const keys = write.path.map((names) => names?.[0]);
  if (keys.length > 1 && writes.some((other) => replacesPrefix(other, keys))) return false;
  const { node } = write;
  const defined =
    isCallExpression(node) &&
    globalPathOf(unwrapped(node.expression))?.join('.') === 'Object.defineProperty';
  let value = unwrapped(initializer);
  for (const [index, key] of keys.entries()) {
    if (key === undefined || key === '__proto__') return false;
    if (index === keys.length - 1) return defined || !framedAccessorTakes(value, key);
    const member = isObjectLiteralExpression(value) ? plainMember(value, key) : undefined;
    if (member === undefined) return false;
    value = unwrapped(member);
  }
  return false;
}

/** Whether another write may replace an object on a nested write's path, before it or after. */
function replacesPrefix(other: MemberWrite, keys: readonly (string | undefined)[]): boolean {
  return (
    other.path.length < keys.length &&
    other.path.every((names, index) => names === undefined || names.includes(keys[index] ?? ''))
  );
}

/** What a fresh literal's own data member holds where it is the name's last written definition. */
function plainMember(literal: ObjectLiteralExpression, key: string): Expression | undefined {
  if (framedLiteralAccessor(literal, key)) return undefined;
  let found: Expression | undefined;
  for (const property of literal.properties) {
    const name = isSpreadAssignment(property) ? undefined : writtenArrayKey(property.name);
    if (name === undefined) found = undefined;
    else if (name === key)
      found = isPropertyAssignment(property) ? property.initializer : undefined;
  }
  if (found === undefined) return undefined;
  const value = unwrapped(found);
  return isObjectLiteralExpression(value) || isArrayLiteralExpression(value) ? value : undefined;
}

/**
 * A plain assignment, `Object.assign` entry or definition of known names on the read path, that
 * nothing the walk cannot read in its own call may write over.
 */
function exactPrefix(write: MemberWrite, path: readonly string[]): boolean {
  const { node } = write;
  return (
    !write.reopened &&
    write.path.length <= path.length &&
    write.path.every((names, index) => names?.length === 1 && names[0] === path[index]) &&
    (isCallExpression(node) ||
      (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken))
  );
}

/** A fresh ordinary object or array, written there or answered by a native construction. */
function ordinaryObject(node: Expression): boolean {
  const value = unwrapped(node);
  if (isObjectLiteralExpression(value) || isArrayLiteralExpression(value)) return true;
  if (!isNewExpression(value) && !isCallExpression(value)) return false;
  const name = globalPathOf(value.expression)?.join('.') ?? '';
  return isNewExpression(value)
    ? name !== '' && !HANDING_CONSTRUCTORS.has(name)
    : FRESH_RESULTS.has(name);
}

/**
 * Whether a change certainly runs before the read, in the same function: as an earlier statement of
 * a block around it, or as an argument of the call that reads.
 */
function definitelyBefore(change: Node, point: Node): boolean {
  if (executionOwner(change) !== executionOwner(point)) return false;
  if (change.parent === point && (isCallExpression(point) || isNewExpression(point))) return true;
  const statement = change.parent;
  if (!isExpressionStatement(statement)) return false;
  const block = statement.parent;
  if (!isBlock(block) && !isSourceFile(block)) return false;
  for (let at: Node = point; !isSourceFile(at); at = at.parent) {
    if (at.parent === block) return at.pos > statement.pos;
  }
  return false;
}

/** Whether a definite change comes after another: later in the file, or later in one call. */
function stands(change: Change, other: Change): boolean {
  return change.node === other.node ? change.order > other.order : change.node.pos > other.node.pos;
}

/**
 * The definite change itself, the writes of its own call that ran before it, and same-function
 * changes before it, do not reach past it; what the same call writes after it does.
 */
function replacedBy(change: Change, cut: Change, point: Node): boolean {
  if (change.node === cut.node) return change.order <= cut.order;
  return change.node.pos < cut.node.pos && executionOwner(change.node) === executionOwner(point);
}

/** Whether a variable is declared whole with `const`, which nothing assigns anew. */
function constantVariable(declared: VariableDeclaration): boolean {
  return (
    isIdentifier(declared.name) &&
    isVariableDeclarationList(declared.parent) &&
    /^const\s/u.test(declared.parent.getText(declared.getSourceFile()))
  );
}
