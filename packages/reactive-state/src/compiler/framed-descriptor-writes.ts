import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type SourceFile,
  type SpreadAssignment,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { destructuredFirst } from './destructuring-order.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { executionOwner, repeatsAround } from './framed-array-mutations.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedDescriptorEntries } from './framed-descriptor-entries.ts';
import { framedArgumentPrefix, framedMemberNames } from './framed-keys.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { isTypeOnly } from './scope.ts';

/** Source-written replacements of a native descriptor's mutable data value. */
export function framedDescriptorWrites(node: Expression): readonly Expression[] {
  const aliases = descriptorAliases(node);
  if (aliases.size === 0) return [];
  const values: Expression[] = [];
  const owner = executionOwner(node);
  const pending: Node[] = [node.getSourceFile()];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isTypeOnly(at)) continue;
    const written =
      isBinaryExpression(at) || isCallExpression(at) ? writtenValues(at, aliases) : [];
    if (
      written.length > 0 &&
      (executionOwner(at) !== owner ||
        at.pos < node.pos ||
        destructuredFirst(at, node) ||
        repeatsBefore(at, node, aliases, owner)) &&
      framedPossibleBranch(at)
    )
      values.push(...written);
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  return values;
}

/**
 * Whether a write after the read comes back to it: a loop around both passes again, or the function
 * that holds both is called again, with a descriptor made outside the repeated part as the last pass
 * left it. A descriptor made inside it is made anew each time, as `repeatedFrameRead` and
 * `repeatsAround` ask of each name that stands for it.
 */
function repeatsBefore(
  write: Node,
  read: Node,
  aliases: ReadonlySet<VariableDeclaration>,
  owner: Node,
): boolean {
  for (const alias of aliases)
    if (repeatedFrameRead(write, read, alias, owner) || repeatsAround(owner, alias)) return true;
  return false;
}

/** Whole const aliases preserve the same descriptor, including aliases used only for a write. */
function descriptorAliases(node: Expression): ReadonlySet<VariableDeclaration> {
  const aliases = new Set<VariableDeclaration>();
  let value = unwrapped(node);
  while (isIdentifier(value)) {
    const declared = frameDeclarationOf(value);
    if (declared === undefined || !wholeConstant(declared) || aliases.has(declared)) break;
    aliases.add(declared);
    value = unwrapped(declared.initializer);
  }
  const pending: Node[] = [node.getSourceFile()];
  const declarations: (VariableDeclaration & { readonly initializer: Expression })[] = [];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (isTypeOnly(at)) continue;
    if (wholeConstant(at)) declarations.push(at);
    at.forEachChild((child) => {
      pending.push(child);
    });
  }
  let count = -1;
  while (count !== aliases.size) {
    count = aliases.size;
    for (const declared of declarations) {
      const initializer = unwrapped(declared.initializer);
      if (sameDescriptor(initializer, aliases)) aliases.add(declared);
    }
  }
  return aliases;
}

/** Only whole immutable aliases keep their initial descriptor identity. */
function wholeConstant(
  node: Node,
): node is VariableDeclaration & { readonly initializer: Expression } {
  return (
    isVariableDeclaration(node) &&
    isIdentifier(node.name) &&
    isVariableDeclarationList(node.parent) &&
    /^const\s/u.test(node.parent.getText(node.getSourceFile())) &&
    node.initializer !== undefined
  );
}

/** A lexical descriptor alias, without equating unrelated names or destructured values. */
function sameDescriptor(value: Expression, aliases: ReadonlySet<VariableDeclaration>): boolean {
  if (!isIdentifier(value)) return false;
  const declared = frameDeclarationOf(value);
  return declared !== undefined && isVariableDeclaration(declared) && aliases.has(declared);
}

/** The assignments that may put their right side in place of what the target held. */
const VALUE_WRITES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * Direct value assignments and native Object.assign data entries keep their written RHS. The
 * `seen` objects are those whose own writes are being read: a source that writes another is read
 * through it once.
 */
function writtenValues(
  node: Node,
  aliases: ReadonlySet<VariableDeclaration>,
  seen: ReadonlySet<VariableDeclaration> = new Set(),
): readonly Expression[] {
  if (isBinaryExpression(node) && VALUE_WRITES.has(node.operatorToken.kind)) {
    const target = unwrapped(node.left);
    if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) return [];
    if (!sameDescriptor(unwrapped(target.expression), aliases)) return [];
    const names = framedMemberNames(target);
    return names === undefined || names.includes('value') ? [node.right] : [];
  }
  if (
    !isCallExpression(node) ||
    globalPathOf(unwrapped(node.expression))?.join('.') !== 'Object.assign'
  )
    return [];
  const [target, ...sources] = callArguments(node);
  if (target === undefined || !sameDescriptor(unwrapped(target), aliases)) return [];
  if (framedArgumentPrefix(node).values[0] !== target) return [];
  return sources.flatMap((source) => sourceValues(source, seen));
}

/**
 * The arguments of a call in order, with the lists its spreads hold: a written list is read
 * through, nested spreads too, and a held list as far as the call's argument prefix reads it. A
 * spread the compile cannot expand leaves out what it holds and no more: the arguments after it are
 * still there, so a source written after it still writes its `value`, wherever it stands. Which
 * argument is the target is not told from here: a spread before it that is not expanded leaves
 * that unknown, and `writtenValues` asks the prefix, which never shifts arguments past one.
 */
function callArguments(call: CallExpression): readonly Expression[] {
  const values: Expression[] = [];
  const pending = call.arguments.toReversed();
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (!isSpreadElement(each)) {
      values.push(each);
      continue;
    }
    const list = unwrapped(each.expression);
    if (isArrayLiteralExpression(list)) pending.push(...list.elements.toReversed());
    else values.push(...framedArgumentPrefix(call, [each], Infinity).values);
  }
  return values;
}

/**
 * The values an `Object.assign` source may write under `value`: those of a literal, or of the
 * literal a whole constant alias chain ends in, and those written into that object through any
 * name that stands for it, wherever they stand. Where a part of the literal cannot be read (a
 * spread, a computed name), the entries that may be named `value` stay possible values: that part
 * adds nothing and takes nothing away. A source that is no such literal writes nothing the walk
 * knows, and neither does a change of the object that is no write the walk reads: a call that is
 * handed it, a pattern or a loop head that targets a member of it.
 */
function sourceValues(
  source: Expression,
  seen: ReadonlySet<VariableDeclaration>,
): readonly Expression[] {
  const held = constantLiteral(source);
  if (held === undefined) return [];
  const entries =
    framedDescriptorEntries(held.literal, ['value']) ?? possibleValues(held.literal, seen);
  return [...entries, ...writtenThrough(held.holders, seen)];
}

/** An object literal, and the constants of the alias chain that names it, from the first name on. */
interface HeldLiteral {
  readonly literal: ObjectLiteralExpression;
  readonly holders: readonly VariableDeclaration[];
}

/** The object literal an expression is, or a whole constant alias chain of it ends in. */
function constantLiteral(expression: Expression): HeldLiteral | undefined {
  let value = unwrapped(expression);
  const holders: VariableDeclaration[] = [];
  while (isIdentifier(value)) {
    const declared = frameDeclarationOf(value);
    if (declared === undefined || !wholeConstant(declared) || holders.includes(declared))
      return undefined;
    holders.push(declared);
    value = unwrapped(declared.initializer);
  }
  return isObjectLiteralExpression(value) ? { literal: value, holders } : undefined;
}

/**
 * Every data entry of a literal, and of the literals it spreads (each read once), whose name is
 * `value` or may be: a computed name the compile cannot read may name it. A spread it cannot read
 * is passed by.
 */
function possibleValues(
  literal: ObjectLiteralExpression,
  seen: ReadonlySet<VariableDeclaration>,
): readonly Expression[] {
  const values: Expression[] = [];
  const read = new Set([literal]);
  const pending = [literal];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    for (const property of at.properties) {
      if (!isSpreadAssignment(property)) {
        values.push(...valueEntry(property));
        continue;
      }
      const held = constantLiteral(property.expression);
      if (held === undefined || read.has(held.literal)) continue;
      read.add(held.literal);
      pending.push(held.literal);
      values.push(...writtenThrough(held.holders, seen));
    }
  }
  return values;
}

/** The writes of a module that can put a value under a name, and the constants that alias one. */
interface FileWrites {
  readonly writes: ReadonlyMap<string, readonly Node[]>;
  readonly aliases: ReadonlyMap<
    string,
    readonly (VariableDeclaration & { readonly initializer: Expression })[]
  >;
}

/** What each module's writes and constant aliases are, read once. */
const FILE_WRITES = new WeakMap<SourceFile, FileWrites>();

/**
 * The values written into the object a chain of constants names, through any name that stands for
 * it: `object.value = error`, `object[key] = error`, `object.value ??= error`, and a source of an
 * `Object.assign` into it, wherever they stand (a write after the copy comes back in a loop or a
 * call made again, so it counts). The writes are found by the variable a name resolves to, among
 * the writes of the module that name a variable of that text, and an object being read is read once.
 */
function writtenThrough(
  holders: readonly VariableDeclaration[],
  seen: ReadonlySet<VariableDeclaration>,
): readonly Expression[] {
  const root = holders.at(-1);
  if (root === undefined || seen.has(root)) return [];
  const index = fileWrites(root.getSourceFile());
  const aliases = new Set(holders);
  const pending = [...holders];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const named = index.aliases.get(holderName(at));
    if (named === undefined) continue;
    for (const alias of named) {
      if (aliases.has(alias) || !sameDescriptor(unwrapped(alias.initializer), new Set([at])))
        continue;
      aliases.add(alias);
      pending.push(alias);
    }
  }
  const reading = new Set(seen);
  for (const alias of aliases) reading.add(alias);
  const names = new Set([...aliases].map((each) => holderName(each)));
  return [...names]
    .flatMap((name) => index.writes.get(name) ?? [])
    .flatMap((node) => writtenValues(node, aliases, reading));
}

/** The text of a constant's name; none of a pattern's. */
function holderName(declared: VariableDeclaration): string {
  return isIdentifier(declared.name) ? declared.name.text : '';
}

/** The writes of a module by the text of the name they write into, and its constant aliases. */
function fileWrites(file: SourceFile): FileWrites {
  const known = FILE_WRITES.get(file);
  if (known !== undefined) return known;
  const writes = new Map<string, Node[]>();
  const aliases = new Map<string, (VariableDeclaration & { readonly initializer: Expression })[]>();
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const written = writtenName(node);
    if (written !== undefined) writes.set(written, [...(writes.get(written) ?? []), node]);
    const named = wholeConstant(node) ? unwrapped(node.initializer) : undefined;
    if (named !== undefined && isIdentifier(named) && wholeConstant(node))
      aliases.set(named.text, [...(aliases.get(named.text) ?? []), node]);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const indexed = { writes, aliases };
  FILE_WRITES.set(file, indexed);
  return indexed;
}

/** The text of the name an assignment of a member, or an `Object.assign`, writes into. */
function writtenName(node: Node): string | undefined {
  let receiver: Expression | undefined;
  if (isBinaryExpression(node) && VALUE_WRITES.has(node.operatorToken.kind)) {
    const target = unwrapped(node.left);
    receiver =
      isPropertyAccessExpression(target) || isElementAccessExpression(target)
        ? unwrapped(target.expression)
        : undefined;
  } else if (
    isCallExpression(node) &&
    globalPathOf(unwrapped(node.expression))?.join('.') === 'Object.assign'
  ) {
    const [first] = framedArgumentPrefix(node).values;
    receiver = first === undefined ? undefined : unwrapped(first);
  }
  return receiver !== undefined && isIdentifier(receiver) ? receiver.text : undefined;
}

/** A data entry that is, or may be, named `value`: an accessor or a method holds no data. */
function valueEntry(
  property: Exclude<ObjectLiteralElementLike, SpreadAssignment>,
): readonly Expression[] {
  const name = writtenArrayKey(property.name);
  if (name !== undefined && name !== 'value') return [];
  if (isPropertyAssignment(property)) return [property.initializer];
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? [property.name]
    : [];
}
