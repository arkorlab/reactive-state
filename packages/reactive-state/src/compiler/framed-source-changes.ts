import {
  type Identifier,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isNewExpression,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTypeAssertion,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Whether a constant object may have changed where code copies it: any mention but a read says so. */

/** The answers for each constant, read once. */
const CHANGED = new WeakMap<VariableDeclaration, boolean>();

/** Whether a variable is declared whole with `const`, which nothing assigns anew. */
export function isConstantDeclaration(declared: VariableDeclaration): boolean {
  return (
    isVariableDeclarationList(declared.parent) &&
    /^const\s/u.test(declared.parent.getText(declared.getSourceFile()))
  );
}

/**
 * Whether the object a constant holds may be other than its literal wrote where it is copied. A
 * member write, a deletion, a loop head or a pattern that targets one of its members, a call of one
 * of its members, a call that is handed it, a variable that names it, a literal or a return that
 * holds it: any mention of it, or of a constant that names it, in the module, wherever it stands,
 * but a read of a member, a spread of it, a constant that names it, and a source of `Object.assign`.
 */
export function sourceChanged(holder: VariableDeclaration): boolean {
  const known = CHANGED.get(holder);
  if (known !== undefined) return known;
  const changed = mentionsChange(holder);
  CHANGED.set(holder, changed);
  return changed;
}

/** What a module mentions by name, and the variables declared as another variable, read once. */
interface Index {
  readonly mentions: ReadonlyMap<string, readonly Identifier[]>;
  readonly aliases: ReadonlyMap<string, readonly VariableDeclaration[]>;
  /** The mentions and the aliases of a name, once its declarations are told apart. */
  readonly mentioned: Map<string, Grouped<Identifier>>;
  readonly aliased: Map<string, Grouped<VariableDeclaration>>;
}

/** Items of a name by the declaration the name stands for; `open` are those no declaration is found for. */
interface Grouped<Item> {
  readonly declared: Map<Node, Item[]>;
  readonly open: Item[];
}

/** The index of each module. */
const INDEXES = new WeakMap<SourceFile, Index>();

/** The mentions of a module by their text, and its aliases by the text of the variable they name. */
function indexOf(file: SourceFile): Index {
  const known = INDEXES.get(file);
  if (known !== undefined) return known;
  const mentions = new Map<string, Identifier[]>();
  const aliases = new Map<string, VariableDeclaration[]>();
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isIdentifier(node) && readsBinding(node)) append(mentions, node.text, node);
    if (isVariableDeclaration(node)) {
      const named = aliasedName(node);
      if (named !== undefined) append(aliases, named.text, node);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const index = { mentions, aliases, mentioned: new Map(), aliased: new Map() };
  INDEXES.set(file, index);
  return index;
}

/** Adds a value to the list a key holds. */
function append<Key, Value>(lists: Map<Key, Value[]>, key: Key, value: Value): void {
  const list = lists.get(key);
  if (list === undefined) lists.set(key, [value]);
  else list.push(value);
}

/** The variable a declaration gives a new name to, none for another declaration. */
function aliasedName(declaration: VariableDeclaration): Identifier | undefined {
  const { name, initializer } = declaration;
  if (initializer === undefined || !isIdentifier(name)) return undefined;
  const value = unwrapped(initializer);
  return isIdentifier(value) ? value : undefined;
}

/**
 * The items that name a text, grouped by the declaration each of them stands for, which is looked
 * up once for each item however many declarations share the text.
 */
function groupedBy<Item>(
  cache: Map<string, Grouped<Item>>,
  items: ReadonlyMap<string, readonly Item[]>,
  text: string,
  nameOf: (item: Item) => Identifier | undefined,
): Grouped<Item> {
  const known = cache.get(text);
  if (known !== undefined) return known;
  const group: Grouped<Item> = { declared: new Map(), open: [] };
  const named = items.get(text);
  if (named !== undefined) {
    for (const item of named) {
      const name = nameOf(item);
      const declaration = name === undefined ? undefined : frameDeclarationOf(name);
      if (declaration === undefined) group.open.push(item);
      else append(group.declared, declaration, item);
    }
  }
  cache.set(text, group);
  return group;
}

/**
 * Whether a mention of the constant, or of a constant that names it, may change it. A mention that
 * names another declaration of the same text, a parameter or a variable of another scope, is none.
 */
function mentionsChange(holder: VariableDeclaration): boolean {
  if (!isIdentifier(holder.name)) return true;
  const index = indexOf(holder.getSourceFile());
  const known = new Set<Node>([holder]);
  const pending = [holder];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (mentionsOf(index, each).some((mention) => touches(mention))) return true;
    for (const alias of aliasesOf(index, each)) {
      if (known.has(alias)) continue;
      known.add(alias);
      pending.push(alias);
    }
  }
  return false;
}

/** The mentions of a variable's name that stand for it, and those no declaration is found for. */
function mentionsOf(index: Index, declaration: VariableDeclaration): readonly Identifier[] {
  const { name } = declaration;
  if (!isIdentifier(name)) return [];
  const group = groupedBy(index.mentioned, index.mentions, name.text, (each) => each);
  return [...(group.declared.get(declaration) ?? []), ...group.open];
}

/** The variables declared as another variable that names this declaration. */
function aliasesOf(index: Index, declaration: VariableDeclaration): readonly VariableDeclaration[] {
  const { name } = declaration;
  if (!isIdentifier(name)) return [];
  const group = groupedBy(index.aliased, index.aliases, name.text, aliasedName);
  return [...(group.declared.get(declaration) ?? []), ...group.open];
}

/** Whether a mention may change the object, or hand it to code that may: no read is such a use. */
function touches(mention: Identifier): boolean {
  if (isVariableDeclaration(mention.parent) && mention.parent.name === mention) return false;
  let node: Node = mention;
  while (transparent(node.parent)) node = node.parent;
  if (!memberReceiver(node)) return !readAsWhole(node);
  while (memberReceiver(node)) {
    node = node.parent;
    while (transparent(node.parent)) node = node.parent;
  }
  return writtenTarget(node) || called(node);
}

/** Uses of the object as a whole that change nothing: a spread, a constant alias, a copy's source. */
function readAsWhole(node: Node): boolean {
  const { parent } = node;
  if (isSpreadAssignment(parent)) return true;
  if (isVariableDeclaration(parent)) {
    const { initializer } = parent;
    return initializer !== undefined && initializer === node && isConstantAlias(parent);
  }
  if (!isCallExpression(parent)) return false;
  const copies = globalPathOf(unwrapped(parent.expression))?.join('.') === 'Object.assign';
  return copies && parent.arguments.some((each, index) => index > 0 && each === node);
}

/** Whether a member chain is called, as a method, a constructor or a tag, with the object as `this`. */
function called(node: Node): boolean {
  const { parent } = node;
  return (
    ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === node) ||
    (isTaggedTemplateExpression(parent) && parent.tag === node)
  );
}

/** Whether a chain is the target of an assignment of any kind, a pattern, a loop head or a deletion. */
function writtenTarget(node: Node): boolean {
  let target = node;
  while (patternPart(target)) target = target.parent;
  const { parent } = target;
  if (isBinaryExpression(parent) && parent.left === target) {
    const kind = parent.operatorToken.kind;
    return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
  }
  if (isForInStatement(parent) || isForOfStatement(parent)) return parent.initializer === target;
  if (isDeleteExpression(parent)) return true;
  return (
    (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    (parent.operator === SyntaxKind.PlusPlusToken || parent.operator === SyntaxKind.MinusMinusToken)
  );
}

/** Syntax an assignment pattern is made of, around the member it targets. */
function patternPart(target: Node): boolean {
  const { parent } = target;
  return (
    transparent(parent) ||
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === target) ||
    (isShorthandPropertyAssignment(parent) && parent.name === target)
  );
}

/** Whether a declaration names a constant of its own, the name an alias is read by. */
function isConstantAlias(declaration: VariableDeclaration): boolean {
  return isIdentifier(declaration.name) && isConstantDeclaration(declaration);
}

/** Whether a node is a member read of its expression, `object.name` or `object[key]`. */
function memberReceiver(node: Node): boolean {
  const { parent } = node;
  return (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

/** Syntax that keeps the identity of the expression it wraps. */
function transparent(node: Node): boolean {
  return (
    isAsExpression(node) ||
    isTypeAssertion(node) ||
    isParenthesizedExpression(node) ||
    isNonNullExpression(node) ||
    isSatisfiesExpression(node)
  );
}
