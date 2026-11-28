import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  type NewExpression,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedDescriptorEntries } from './framed-descriptor-entries.ts';
import {
  framedArgumentPrefix,
  framedKeyNames,
  framedMemberNames,
  framedPossibleArguments,
} from './framed-keys.ts';
import { isConstantDeclaration, sourceChanged } from './framed-source-changes.ts';
import { isTypeOnly } from './scope.ts';

/** What a module's code writes into the members of its variables, read once a module. */

/** The slots of `Object.defineProperty`: its target, its key and its descriptor. */
const DEFINED = { slots: 3 } as const;

/** The operators that write their right operand where the left one stands. */
const WRITES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * A source-written member write: the variable it writes into, through whole constant aliases, the
 * possible names of each member on its path, none of a computed key unread, and what it writes.
 */
export interface MemberWrite {
  readonly node: Node;
  readonly holder: VariableDeclaration;
  readonly path: readonly (readonly string[] | undefined)[];
  readonly value: Expression;
  /**
   * A later part of the same call, one the walk cannot read, may write the same name again: a
   * source it does not follow, a spread it does not expand. The write is then no definite last one.
   */
  readonly reopened: boolean;
}

/** The member writes of each module, read once. */
const WRITES_OF = new WeakMap<SourceFile, readonly MemberWrite[]>();

/** The natives that set their first argument's prototype to their second. */
const PROTOTYPE_SETTERS: ReadonlySet<string> = new Set([
  'Object.setPrototypeOf',
  'Reflect.setPrototypeOf',
]);

/** The prototype writes of each module, read once. */
const PROTOTYPES_OF = new WeakMap<SourceFile, readonly MemberWrite[]>();

/**
 * A change that may remove an own field of what a variable holds: a `delete` or
 * `Reflect.deleteProperty` of the path's last member (none of its names read for a computed key),
 * or a hand-off of the object at the path to code that may delete any field below it.
 */
export interface MemberDelete {
  readonly node: Node;
  readonly holder: VariableDeclaration;
  readonly path: readonly (readonly string[] | undefined)[];
  readonly handed: boolean;
}

/** The deletes and hand-offs of each module, read once. */
const DELETES_OF = new WeakMap<SourceFile, readonly MemberDelete[]>();

/** A plain assignment of a whole variable, `options = { … }`, and what it assigns. */
export interface VariableWrite {
  readonly node: BinaryExpression;
  readonly binding: VariableDeclaration;
  readonly value: Expression;
}

/** The plain variable assignments of each module, read once. */
const ASSIGNED_OF = new WeakMap<SourceFile, readonly VariableWrite[]>();

/** Member writes grouped by canonical holder declaration for each module. */
const HOLDER_WRITES_OF = new WeakMap<
  SourceFile,
  ReadonlyMap<VariableDeclaration, readonly MemberWrite[]>
>();

/** Plain variable assignments grouped by target declaration for each module. */
const BINDING_WRITES_OF = new WeakMap<
  SourceFile,
  ReadonlyMap<VariableDeclaration, readonly VariableWrite[]>
>();

/** Each member write of a module, by the variable it writes into through whole constant aliases. */
export function framedMemberWrites(file: SourceFile): readonly MemberWrite[] {
  const known = WRITES_OF.get(file);
  if (known !== undefined) return known;
  const writes: MemberWrite[] = [];
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isBinaryExpression(node) && WRITES.has(node.operatorToken.kind))
      writes.push(...assignedMember(node));
    else if (isCallExpression(node)) writes.push(...assignedEntries(node), ...definedEntry(node));
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  WRITES_OF.set(file, writes);
  return writes;
}

/**
 * Each prototype a module's code sets on what a variable holds on a member path, through whole
 * constant aliases — `Object.setPrototypeOf(holder, proto)`, `Reflect.setPrototypeOf(holder,
 * proto)`, `holder.__proto__ = proto` — with the object's own path and the prototype as its value.
 */
export function framedPrototypeWrites(file: SourceFile): readonly MemberWrite[] {
  const known = PROTOTYPES_OF.get(file);
  if (known !== undefined) return known;
  const writes: MemberWrite[] = [];
  for (const write of framedMemberWrites(file)) {
    const { node, path } = write;
    const last = path.at(-1);
    if (
      isBinaryExpression(node) &&
      node.operatorToken.kind === SyntaxKind.EqualsToken &&
      last?.length === 1 &&
      last[0] === '__proto__'
    )
      writes.push({ ...write, path: path.slice(0, -1) });
  }
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isCallExpression(node)) writes.push(...prototypeSet(node));
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  PROTOTYPES_OF.set(file, writes);
  return writes;
}

/**
 * Each change of a module that may remove an own field of what a variable holds, through whole
 * constant aliases: `delete holder.x`, `delete holder[key]`, `Reflect.deleteProperty(holder, key)`,
 * and the object handed to a function other than a global's, as an argument or a method's receiver.
 */
export function framedMemberDeletes(file: SourceFile): readonly MemberDelete[] {
  const known = DELETES_OF.get(file);
  if (known !== undefined) return known;
  const deletes: MemberDelete[] = [];
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isDeleteExpression(node)) {
      const written = writtenPath(node.expression);
      if (written !== undefined && written.path.length > 0)
        deletes.push({ node, ...written, handed: false });
    } else if (isCallExpression(node) || isNewExpression(node)) deletes.push(...callDeletes(node));
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  DELETES_OF.set(file, deletes);
  return deletes;
}

/** `Reflect.deleteProperty(holder, key)`, or what a call hands to code that may delete its fields. */
function callDeletes(node: CallExpression | NewExpression): readonly MemberDelete[] {
  const callee = unwrapped(node.expression);
  const native = globalPathOf(callee)?.join('.');
  if (native === 'Reflect.deleteProperty' && isCallExpression(node)) {
    const [target, key] = framedArgumentPrefix(node, node.arguments).values;
    const written = target === undefined ? undefined : writtenPath(target);
    if (written === undefined) return [];
    const names = key === undefined ? undefined : framedKeyNames(key);
    return [{ node, ...written, path: [...written.path, names], handed: false }];
  }
  if (native !== undefined) return [];
  const handed = [...(node.arguments ?? [])].map((argument) =>
    isSpreadElement(argument) ? argument.expression : argument,
  );
  if (isPropertyAccessExpression(callee) || isElementAccessExpression(callee))
    handed.push(callee.expression);
  return handed.flatMap((each) => {
    const written = writtenPath(each);
    return written === undefined ? [] : [{ node, ...written, handed: true }];
  });
}

/** `Object.setPrototypeOf(holder, proto)` or its Reflect form, of a variable's member path. */
function prototypeSet(node: CallExpression): readonly MemberWrite[] {
  if (!PROTOTYPE_SETTERS.has(globalPathOf(unwrapped(node.expression))?.join('.') ?? '')) return [];
  const [target, prototype] = framedArgumentPrefix(node, node.arguments).values;
  const written = target === undefined ? undefined : writtenPath(target);
  return written === undefined || prototype === undefined
    ? []
    : [{ node, ...written, value: prototype, reopened: false }];
}

/** `holder.member = value`, and its logical forms, of a variable's member path. */
function assignedMember(node: BinaryExpression): readonly MemberWrite[] {
  const target = unwrapped(node.left);
  if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) return [];
  const written = writtenPath(target);
  return written === undefined ? [] : [{ node, ...written, value: node.right, reopened: false }];
}

/**
 * `Object.assign(holder, { member: value })`: each literal source's own written entries, in the
 * order the call writes them. What the walk cannot read of the call (a source that is not a
 * literal, a spread, an accessor, the arguments a spread it cannot follow ends) may write any name
 * after the entries before it, which are then no definite last write.
 */
function assignedEntries(node: Expression): readonly MemberWrite[] {
  if (
    !isCallExpression(node) ||
    globalPathOf(unwrapped(node.expression))?.join('.') !== 'Object.assign'
  )
    return [];
  const prefix = framedArgumentPrefix(node, node.arguments, Infinity);
  const [target, ...given] = prefix.values;
  const written = target === undefined ? undefined : writtenPath(target);
  if (written === undefined) return [];
  // Past a spread whose order is unknown, each value it may supply may be a source; past one the
  // walk cannot read, each source written after it still is one.
  const sources = [...given, ...framedPossibleArguments(prefix)];
  const entries = sources.flatMap((source) => sourceEntries(source));
  if (prefix.unknown) entries.push(undefined);
  const writes: MemberWrite[] = [];
  let reopened = false;
  for (const entry of entries.toReversed()) {
    if (entry === undefined) reopened = true;
    else
      writes.push({
        node,
        holder: written.holder,
        path: [...written.path, entry.names],
        value: entry.value,
        reopened,
      });
  }
  return writes.toReversed();
}

/**
 * The entries of an `Object.assign` source in the order it writes them: those of a literal, or of
 * the literal a whole constant alias chain ends in, and of the literals it spreads, each read once
 * (a second spread of one is a part the walk does not read). A part it cannot read is `undefined`,
 * and so is the end of a constant that code may have changed (`sourceChanged`): it may hold other
 * entries than its literal wrote.
 */
function sourceEntries(source: Expression): readonly (WrittenEntry | undefined)[] {
  const first = constantLiteral(source);
  if (first === undefined) return [undefined];
  const entries: (WrittenEntry | undefined)[] = [];
  const seen = new Set([first.literal]);
  const pending = [{ properties: first.literal.properties.values(), changed: first.changed }];
  for (let at = pending.at(-1); at !== undefined; at = pending.at(-1)) {
    const next = at.properties.next();
    if (next.done === true) {
      pending.pop();
      if (at.changed) entries.push(undefined);
      continue;
    }
    const property = next.value;
    if (!isSpreadAssignment(property)) {
      entries.push(writtenEntry(property));
      continue;
    }
    const spread = constantLiteral(property.expression);
    if (spread === undefined || seen.has(spread.literal)) {
      entries.push(undefined);
    } else {
      seen.add(spread.literal);
      pending.push({ properties: spread.literal.properties.values(), changed: spread.changed });
    }
  }
  return entries;
}

/** An object literal a source is, with whether code may have changed the constant it was named by. */
interface SourceLiteral {
  readonly literal: ObjectLiteralExpression;
  readonly changed: boolean;
}

/** The object literal an expression is, or a whole constant alias chain of it ends in. */
function constantLiteral(expression: Expression): SourceLiteral | undefined {
  const value = unwrapped(expression);
  if (isObjectLiteralExpression(value)) return { literal: value, changed: false };
  const declared = isIdentifier(value) ? frameDeclarationOf(value) : undefined;
  if (declared === undefined || !isVariableDeclaration(declared)) return undefined;
  const holder = framedHeldVariable(declared);
  const initial = holder.initializer === undefined ? undefined : unwrapped(holder.initializer);
  if (initial === undefined || !isObjectLiteralExpression(initial)) return undefined;
  if (!isIdentifier(holder.name) || !isConstantDeclaration(holder)) return undefined;
  return { literal: initial, changed: sourceChanged(holder) };
}

/** `Object.defineProperty(holder, key, { value })`: the descriptor's written value under the key. */
function definedEntry(node: CallExpression): readonly MemberWrite[] {
  if (globalPathOf(unwrapped(node.expression))?.join('.') !== 'Object.defineProperty') return [];
  const prefix = framedArgumentPrefix(node, node.arguments, DEFINED.slots);
  const [target, key, descriptor] = prefix.values;
  const written = target === undefined ? undefined : writtenPath(target);
  if (written === undefined || (key === undefined && !prefix.unknown)) return [];
  // A descriptor past a spread whose order is unknown is any value that spread may supply, and past
  // one the walk cannot read any argument written after it: each is possible there, none the
  // definite last write. A key past one is not shown, and the write is then under any name.
  const descriptors = descriptor === undefined ? framedPossibleArguments(prefix) : [descriptor];
  const names = key === undefined ? undefined : framedKeyNames(key);
  return descriptors.flatMap((each) => {
    return (framedDescriptorEntries(each, ['value']) ?? []).map((value) => {
      return {
        node,
        holder: written.holder,
        path: [...written.path, names],
        value,
        reopened: descriptor === undefined,
      };
    });
  });
}

/** Each plain whole-variable assignment of a module. */
export function framedVariableWrites(file: SourceFile): readonly VariableWrite[] {
  const known = ASSIGNED_OF.get(file);
  if (known !== undefined) return known;
  const writes: VariableWrite[] = [];
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isBinaryExpression(node)) {
      const binding = assignedVariable(node);
      if (binding !== undefined) writes.push({ node, binding, value: node.right });
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  ASSIGNED_OF.set(file, writes);
  return writes;
}

/** Member writes in `file` targeting `holder`, indexed once per module. */
export function framedMemberWritesOf(
  file: SourceFile,
  holder: VariableDeclaration,
): readonly MemberWrite[] {
  let byHolder = HOLDER_WRITES_OF.get(file);
  if (byHolder === undefined) {
    const grouped = new Map<VariableDeclaration, MemberWrite[]>();
    for (const write of framedMemberWrites(file)) {
      const existing = grouped.get(write.holder);
      if (existing === undefined) grouped.set(write.holder, [write]);
      else existing.push(write);
    }
    byHolder = grouped;
    HOLDER_WRITES_OF.set(file, byHolder);
  }
  return byHolder.get(holder) ?? [];
}

/** Plain whole-variable assignments in `file` targeting `binding`, indexed once per module. */
export function framedVariableWritesOf(
  file: SourceFile,
  binding: VariableDeclaration,
): readonly VariableWrite[] {
  let byBinding = BINDING_WRITES_OF.get(file);
  if (byBinding === undefined) {
    const grouped = new Map<VariableDeclaration, VariableWrite[]>();
    for (const write of framedVariableWrites(file)) {
      const existing = grouped.get(write.binding);
      if (existing === undefined) grouped.set(write.binding, [write]);
      else existing.push(write);
    }
    byBinding = grouped;
    BINDING_WRITES_OF.set(file, byBinding);
  }
  return byBinding.get(binding) ?? [];
}

/** The variable a plain `name = value` assigns. */
function assignedVariable(node: BinaryExpression): VariableDeclaration | undefined {
  if (node.operatorToken.kind !== SyntaxKind.EqualsToken) return undefined;
  const target = unwrapped(node.left);
  const declared = isIdentifier(target) ? frameDeclarationOf(target) : undefined;
  return declared !== undefined && isVariableDeclaration(declared) ? declared : undefined;
}

/** A literal's data entry: its possible names, none of a computed one unread, and its value. */
interface WrittenEntry {
  readonly names: readonly string[] | undefined;
  readonly value: Expression;
}

/** The data entry a literal's property writes; a spread, an accessor or a method is not one. */
function writtenEntry(
  property: ObjectLiteralExpression['properties'][number],
): WrittenEntry | undefined {
  let value: Expression | undefined;
  if (isPropertyAssignment(property)) value = property.initializer;
  else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name))
    value = property.name;
  if (value === undefined || isSpreadAssignment(property)) return undefined;
  const name = writtenArrayKey(property.name);
  return { names: name === undefined ? undefined : [name], value };
}

/** The variable a member chain writes into, and the possible names of each member on its path. */
function writtenPath(node: Expression): Pick<MemberWrite, 'holder' | 'path'> | undefined {
  let value = unwrapped(node);
  const path: (readonly string[] | undefined)[] = [];
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    path.unshift(framedMemberNames(value));
    value = unwrapped(value.expression);
  }
  if (!isIdentifier(value)) return undefined;
  const declared = frameDeclarationOf(value);
  return declared !== undefined && isVariableDeclaration(declared) && isIdentifier(declared.name)
    ? { holder: framedHeldVariable(declared), path }
    : undefined;
}

/** The variable a whole constant alias holds, through its own aliases; another as it is. */
export function framedHeldVariable(declared: VariableDeclaration): VariableDeclaration {
  let holder = declared;
  const seen = new Set<Node>();
  while (!seen.has(holder)) {
    seen.add(holder);
    const value = holder.initializer === undefined ? undefined : unwrapped(holder.initializer);
    if (
      value === undefined ||
      !isIdentifier(value) ||
      !isIdentifier(holder.name) ||
      !isConstantDeclaration(holder)
    )
      return holder;
    const next = frameDeclarationOf(value);
    if (next === undefined || !isVariableDeclaration(next)) return holder;
    holder = next;
  }
  return holder;
}
