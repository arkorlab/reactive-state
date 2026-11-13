import {
  type BinaryExpression,
  type ElementAccessExpression,
  type Expression,
  type GetAccessorDeclaration,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isFunctionLikeDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTypeNode,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type PropertyName,
  type SetAccessorDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedPossibleBranch } from './framed-branches.ts';
import { readsBinding } from './scope.ts';

/** What a getter the copy of a spread runs writes into the object it runs on. */

/** Thrown where what a source holds cannot be followed: a getter may change it in a way not written out. */
export class UnfollowableError extends Error {
  override name = 'UnfollowableError';
}

/** The assignments that may give their left the value of their right: `=` and the logical ones. */
const VALUE_WRITES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** A value a getter writes to a member of `this`, and the name of the member, none where it is computed. */
export interface GetterWrite {
  readonly name: string | undefined;
  readonly value: Expression;
}

/**
 * The values a getter writes through `this`, each a value a field of the object may hold when the
 * copy reaches it: the right of an assignment to a member of `this`, under the name of the member. A
 * deletion writes none, and an arithmetic assignment or an increment writes a number or a text, which
 * is no object (it runs a setter all the same: `accessorWrites` counts the names). None where `this`
 * is given to anything else: a call, a method, a pattern, a loop head, a list, the result of the
 * getter. None where `super` is used: what a member of `super` reads or sets is a getter or a setter
 * of the prototype that runs with the same receiver, which the compile does not follow.
 */
export function getterWrites(getter: {
  readonly body?: Node | undefined;
}): readonly GetterWrite[] | undefined {
  return thisUses(getter)?.writes;
}

/** What a body does with `this`: the values it writes, and every name it assigns to, which runs a setter. */
interface ThisUses {
  readonly writes: readonly GetterWrite[];
  readonly named: readonly (string | undefined)[];
  /** The names it deletes from the object, none known where the name is computed. */
  readonly deleted: readonly (string | undefined)[];
}

const NOTHING: ThisUses = { writes: [], named: [], deleted: [] };

/** What the mentions of `this` in a body come to; none where `this` is given on. */
function thisUses(getter: { readonly body?: Node | undefined }): ThisUses | undefined {
  const writes: GetterWrite[] = [];
  const named: (string | undefined)[] = [];
  const deleted: (string | undefined)[] = [];
  const pending: Node[] = getter.body === undefined ? [] : [getter.body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (!framedPossibleBranch(node)) continue;
    if (node.kind === SyntaxKind.SuperKeyword) return undefined;
    if (node.kind === SyntaxKind.ThisKeyword) {
      const used = use(node);
      if (used === undefined) return undefined;
      writes.push(...used.writes);
      named.push(...used.named);
      deleted.push(...used.deleted);
    }
    const rebinds =
      (isFunctionLikeDeclaration(node) && !isArrowFunction(node)) ||
      isClassDeclaration(node) ||
      isClassExpression(node);
    if (!rebinds)
      node.forEachChild((child) => {
        pending.push(child);
      });
  }
  return { writes, named, deleted };
}

/** The name a field of a written object is set under, none where it is computed. */
function accessorName(name: PropertyName): string | undefined {
  if (isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name))
    return name.text;
  return isNumericLiteral(name) ? String(Number(name.text)) : undefined;
}

/**
 * What running a getter of a written object writes into it: its own writes, and those of the
 * setters of the object that its writes run, and of the setters those run in turn. Any assignment
 * to a member of `this` runs a setter: `=`, an arithmetic or a logical one, an increment. A write
 * that may name any field runs every setter. The objects a getter that is inherited runs on are
 * the `receivers`, the nearest first, and their setters may run as well; a write the object does not
 * hold itself may run a setter of the prototype it sets. None where any of them gives `this` on, or where a setter that cannot be
 * read may run.
 */
export function accessorWrites(
  object: ObjectLiteralExpression,
  getter: GetAccessorDeclaration,
  receivers: readonly ObjectLiteralExpression[] = [],
): readonly GetterWrite[] | undefined {
  return accessorUses(object, getter, receivers)?.writes;
}

/**
 * What running a getter does to the object it runs on, the setters its assignments run included. A
 * value assigned to a field that has a setter is the setter's argument, and is stored nowhere, where
 * the setter is known to apply (no field of an object the write meets first may hold the name, and no
 * later field of its own object may replace it) and no getter or setter deletes members (a deletion
 * may have removed the setter).
 */
function accessorUses(
  object: ObjectLiteralExpression,
  getter: GetAccessorDeclaration,
  receivers: readonly ObjectLiteralExpression[],
): ThisUses | undefined {
  const receiving = receivers.flatMap((each) => each.properties);
  const setters = [
    ...object.properties.filter((each, at, all) => isLiveSetter(each, all.slice(at + 1))),
    ...receiving,
  ].filter((each) => isSetAccessorDeclaration(each));
  const applying = setters.filter((each) => appliesTo(each, object, receivers));
  const found: ThisUses[] = [];
  const run = new Set<Node>([getter]);
  const pending: { readonly body?: Node | undefined }[] = [getter];
  for (let accessor = pending.pop(); accessor !== undefined; accessor = pending.pop()) {
    const uses = thisUses(accessor);
    if (uses === undefined || runsPrototypeSetter(object, uses.named)) return undefined;
    found.push(uses);
    for (const setter of setters) {
      const name = accessorName(setter.name);
      const invoked = uses.named.some(
        (each) => each === undefined || name === undefined || each === name,
      );
      if (invoked && !run.has(setter)) {
        if (readsArgument(setter)) return undefined;
        run.add(setter);
        pending.push(setter);
      }
    }
  }
  const keep = found.some((each) => each.deleted.length > 0) || deletedNames(object).length > 0;
  const deleting = receivers.some((each) => deletedNames(each).length > 0);
  const consumed = new Set(
    applying.flatMap((each) => {
      const name = accessorName(each.name);
      return name === undefined ? [] : [name];
    }),
  );
  return {
    writes: found.flatMap((each) =>
      keep || deleting ? each.writes : each.writes.filter((write) => !consumedBy(consumed, write)),
    ),
    named: found.flatMap((each) => each.named),
    deleted: found.flatMap((each) => each.deleted),
  };
}

/** What the accessors of each written object delete from it, judged once. */
const DELETED = new WeakMap<ObjectLiteralExpression, readonly (string | undefined)[]>();

/**
 * The names the getters and the setters of a written object delete from it (`delete this.name`),
 * none known where a name is computed or an accessor gives `this` on. Any of them may run before
 * another reads or writes the object, and take away the accessor that the other's assignment was to
 * run, so the assignment makes a field of the object.
 */
export function deletedNames(object: ObjectLiteralExpression): readonly (string | undefined)[] {
  const known = DELETED.get(object);
  if (known !== undefined) return known;
  const names = object.properties.flatMap((each) => {
    if (!isGetAccessorDeclaration(each) && !isSetAccessorDeclaration(each)) return [];
    return thisUses(each)?.deleted ?? [undefined];
  });
  DELETED.set(object, names);
  return names;
}

/**
 * What may be deleted from a written object where something reads the fields it inherits (a
 * conversion of a descriptor): the names its own accessors delete, and those the accessors of the
 * prototype it sets delete on it, any name where the prototype is no written object.
 */
export function inheritedDeletions(
  object: ObjectLiteralExpression,
): readonly (string | undefined)[] {
  const inherited = object.properties.find(
    (each) => isPropertyAssignment(each) && setsProto(each) && !nullPrototype(each),
  );
  if (inherited === undefined || !isPropertyAssignment(inherited)) return deletedNames(object);
  const proto = unwrapped(inherited.initializer);
  return [
    ...deletedNames(object),
    ...(isObjectLiteralExpression(proto) ? inheritedDeletions(proto) : [undefined]),
  ];
}

/**
 * Whether a setter reads the value it is given: a name its parameter binds, or `arguments`. What the
 * write that ran it assigned goes where the setter takes it, which the compile does not follow.
 */
function readsArgument(setter: SetAccessorDeclaration): boolean {
  const names = new Set(['arguments']);
  const binding: Node[] = setter.parameters.map((each) => each.name);
  for (let node = binding.pop(); node !== undefined; node = binding.pop()) {
    if (isIdentifier(node)) names.add(node.text);
    node.forEachChild((child) => {
      binding.push(child);
    });
  }
  const pending: Node[] = setter.body === undefined ? [] : [setter.body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (isIdentifier(node) && names.has(node.text) && readsBinding(node)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * Whether the setter is certain to take an assignment to its name from the getter that runs: the
 * name is known; no field after it in its own object may replace it with a value; and no field of an
 * object the assignment meets first, the nearer receivers where the setter is a prototype's or the
 * receivers all where it is the getter's own, may hold the name, which hides the setter.
 */
function appliesTo(
  setter: SetAccessorDeclaration,
  object: ObjectLiteralExpression,
  receivers: readonly ObjectLiteralExpression[],
): boolean {
  const name = accessorName(setter.name);
  const owner = setter.parent;
  if (name === undefined || !isObjectLiteralExpression(owner)) return false;
  const after = owner.properties.slice(owner.properties.indexOf(setter) + 1);
  if (after.some((each) => mayReplace(each, name))) return false;
  const nearer = owner === object ? receivers : receivers.slice(0, receivers.indexOf(owner));
  return nearer.every((each) => !mayOwn(each, name));
}

/** Whether a field after a setter may give its name a value: an accessor of the name does not. */
function mayReplace(property: ObjectLiteralElementLike, name: string): boolean {
  if (isGetAccessorDeclaration(property) || isSetAccessorDeclaration(property)) return false;
  return mayName(property, name);
}

/** Whether a written object may hold a field of the name: its own, a computed one, or a spread of what may. */
function mayOwn(object: ObjectLiteralExpression, name: string): boolean {
  return object.properties.some((each) => mayName(each, name));
}

/**
 * Whether a field may set the name: one written with it, one with a name that is computed, or a
 * spread of what is no written object or of one that may. A written `__proto__: value` sets the
 * prototype and no field.
 */
function mayName(property: ObjectLiteralElementLike, name: string): boolean {
  if (isSpreadAssignment(property)) {
    const copied = unwrapped(property.expression);
    return !isObjectLiteralExpression(copied) || mayOwn(copied, name);
  }
  if (isPropertyAssignment(property) && setsProto(property)) return false;
  const own = accessorName(property.name);
  return own === undefined || own === name;
}

/** Whether a write is certain to be the argument of a setter: its name is known, and a setter has it. */
function consumedBy(consumed: ReadonlySet<string>, write: GetterWrite): boolean {
  return write.name !== undefined && consumed.has(write.name);
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** What `surelyCopied` found for each written object: judged once, as nested literals judge their children. */
const COPIED = new WeakMap<ObjectLiteralExpression, ReadonlySet<string>>();

/**
 * The names a spread of an expression surely copies as own fields of its own: those of a written
 * object, a setter's among them (a spread reads it as `undefined`), and those of the spreads it holds,
 * but for the names a getter among its fields may delete before the copy reaches them. Another getter
 * than the ones written out, or a getter that gives `this` on, may delete any: none is sure.
 */
export function surelyCopied(copied: Expression): ReadonlySet<string> {
  const value = unwrapped(copied);
  if (!isObjectLiteralExpression(value)) return NO_NAMES;
  const known = COPIED.get(value);
  if (known !== undefined) return known;
  const found = copiedBy(value);
  COPIED.set(value, found);
  return found;
}

/** The names a spread of a written object surely copies. */
function copiedBy(value: ObjectLiteralExpression): ReadonlySet<string> {
  const names = new Set<string>();
  const deleted: (string | undefined)[] = [];
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) {
      for (const each of surelyCopied(property.expression)) names.add(each);
      continue;
    }
    if (isGetAccessorDeclaration(property))
      deleted.push(...(accessorUses(value, property, [])?.deleted ?? [undefined]));
    const name =
      isPropertyAssignment(property) && setsProto(property)
        ? undefined
        : accessorName(property.name);
    if (name !== undefined) names.add(name);
  }
  return deleted.includes(undefined)
    ? new Set()
    : new Set([...names].filter((each) => !deleted.includes(each)));
}

/** Whether a field sets the prototype to `null`: an assignment to a new property meets no setter. */
function nullPrototype(property: ObjectLiteralElementLike): boolean {
  return (
    isPropertyAssignment(property) &&
    unwrapped(property.initializer).kind === SyntaxKind.NullKeyword
  );
}

/** Whether a written field sets the prototype of the object: `__proto__: value`. */
function setsProto(property: ObjectLiteralElementLike): boolean {
  return (
    isPropertyAssignment(property) &&
    (isIdentifier(property.name) || isStringLiteral(property.name)) &&
    property.name.text === '__proto__'
  );
}

/** The last array index: a larger integer names an ordinary property. */
const LAST_INDEX = 4_294_967_294;

/**
 * The names of a written object in the order a copy reaches them: an array index first, in order, then
 * the others as they were first written. None where a spread of what is no written object, or a name
 * that is computed, leaves the order unknown.
 */
export function copyOrder(object: ObjectLiteralExpression): readonly string[] | undefined {
  const names: string[] = [];
  for (const property of object.properties) {
    if (setsProto(property)) continue;
    const found = isSpreadAssignment(property)
      ? spreadOrder(property.expression)
      : namesOf(property);
    if (found === undefined) return undefined;
    for (const each of found) if (!names.includes(each)) names.push(each);
  }
  return [
    ...names.filter((each) => isIndex(each)).toSorted((one, two) => Number(one) - Number(two)),
    ...names.filter((each) => !isIndex(each)),
  ];
}

/** Whether a name is the text of an array index. */
function isIndex(name: string): boolean {
  return /^(?:0|[1-9]\d*)$/u.test(name) && Number(name) <= LAST_INDEX;
}

/** The name of a written field, none known where it is computed. */
function namesOf(property: ObjectLiteralElementLike): readonly string[] | undefined {
  if (isSpreadAssignment(property)) return undefined;
  const name = accessorName(property.name);
  return name === undefined ? undefined : [name];
}

/** The names a spread of a written object puts among the fields, none known for any other. */
function spreadOrder(copied: Expression): readonly string[] | undefined {
  const value = unwrapped(copied);
  return isObjectLiteralExpression(value) ? copyOrder(value) : undefined;
}

/**
 * Whether a copy reaches the field after the getter named `getter` has run: the field is among the
 * names, and comes after it. Any, where the order is unknown or the getter's name is computed.
 */
export function copiedAfter(
  order: readonly string[] | undefined,
  getter: string | undefined,
  field: string,
): boolean {
  if (order === undefined || getter === undefined) return true;
  const at = order.indexOf(field);
  return at !== -1 && at > order.indexOf(getter);
}

/** Whether a field is a setter that no field after it replaces with a value or a method. */
function isLiveSetter(
  property: ObjectLiteralElementLike,
  after: readonly ObjectLiteralElementLike[],
): boolean {
  if (!isSetAccessorDeclaration(property)) return false;
  const name = accessorName(property.name);
  return name === undefined || after.every((each) => !replaces(each, name));
}

/** Whether a field gives the name a value that is no accessor: a field, a method, a spread that surely copies it. */
function replaces(property: ObjectLiteralElementLike, name: string): boolean {
  if (isSpreadAssignment(property)) return surelyCopied(property.expression).has(name);
  if (isGetAccessorDeclaration(property) || isSetAccessorDeclaration(property)) return false;
  return !setsProto(property) && accessorName(property.name) === name;
}

/** Whether a written object sets a prototype that is not `null`: an assignment to a name it lacks may meet a setter of it. */
export function settingPrototype(object: ObjectLiteralExpression): boolean {
  return object.properties.some((each) => setsProto(each) && !nullPrototype(each));
}

/** Whether a write the object does not hold may reach a setter of the prototype the object sets. */
function runsPrototypeSetter(
  object: ObjectLiteralExpression,
  named: readonly (string | undefined)[],
): boolean {
  if (!settingPrototype(object)) return false;
  const own = new Set(
    object.properties.flatMap((each) => {
      if (isSpreadAssignment(each)) return [...surelyCopied(each.expression)];
      const name = accessorName(each.name);
      return name === undefined ? [] : [name];
    }),
  );
  return named.some((each) => each === undefined || !own.has(each));
}

/** The node that stands for the same value as `node`, through parentheses and assertions. */
function outermost(node: Node): Node {
  let at = node;
  while (isExpression(at.parent) && unwrapped(at.parent) === node) at = at.parent;
  return at;
}

/** What one mention of `this` does; none where it is given to anything but a member. */
function use(node: Node): ThisUses | undefined {
  const at = outermost(node);
  const { parent } = at;
  const member = isPropertyAccessExpression(parent) || isElementAccessExpression(parent);
  if (!member || parent.expression !== at) return undefined;
  return memberUse(outermost(parent), parent);
}

/** What a member of `this` is used for: a call runs it, a deletion or an assignment changes it. */
function memberUse(
  member: Node,
  access: PropertyAccessExpression | ElementAccessExpression,
): ThisUses | undefined {
  const user = member.parent;
  if (isTaggedTemplateExpression(user)) return user.tag === member ? undefined : NOTHING;
  if ((isCallExpression(user) || isNewExpression(user)) && user.expression === member)
    return undefined;
  if (isDeleteExpression(user))
    return { writes: [], named: [], deleted: [frameMemberName(access)] };
  if (isPrefixUnaryExpression(user) || isPostfixUnaryExpression(user))
    return changes(user.operator)
      ? { writes: [], named: [frameMemberName(access)], deleted: [] }
      : NOTHING;
  if (isBinaryExpression(user) && user.left === member) return assignment(user, access);
  return isTarget(member) ? undefined : NOTHING;
}

/** Whether a unary operator assigns to its operand. */
function changes(operator: SyntaxKind): boolean {
  return operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken;
}

/** What an assignment to a member of `this` writes; none where it takes a pattern's place. */
function assignment(
  user: BinaryExpression,
  access: PropertyAccessExpression | ElementAccessExpression,
): ThisUses | undefined {
  if (isTarget(user)) return undefined;
  const { kind } = user.operatorToken;
  if (kind < SyntaxKind.FirstAssignment || kind > SyntaxKind.LastAssignment) return NOTHING;
  const name = frameMemberName(access);
  return VALUE_WRITES.has(kind)
    ? { writes: [{ name, value: user.right }], named: [name], deleted: [] }
    : { writes: [], named: [name], deleted: [] };
}

/** Whether a node is a place in a pattern that is assigned, or the head of a loop. */
function isTarget(node: Node): boolean {
  let at = node;
  for (;;) {
    const { parent } = at;
    if (isBinaryExpression(parent)) {
      return parent.left === at && parent.operatorToken.kind === SyntaxKind.EqualsToken;
    }
    if (isForOfStatement(parent) || isForInStatement(parent)) return parent.initializer === at;
    const inside =
      isObjectLiteralExpression(parent) ||
      isArrayLiteralExpression(parent) ||
      isPropertyAssignment(parent) ||
      isShorthandPropertyAssignment(parent) ||
      isSpreadElement(parent) ||
      isSpreadAssignment(parent);
    if (!inside) return false;
    at = parent;
  }
}
