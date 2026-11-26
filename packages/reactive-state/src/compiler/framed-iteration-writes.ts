/**
 * A written collection's native iteration is read as the collection holds it only where nothing
 * may replace how it iterates first: no write to an iterating method of the collection, through
 * the name it is read by or any alias of it, and no use that hands it to code that may write one,
 * runs before the read anywhere in the file.
 */

import {
  type BinaryExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isExpressionWithTypeArguments,
  isReturnStatement,
  isExpressionStatement,
  isClassStaticBlockDeclaration,
  isClassLikeDeclaration,
  isFunctionLikeDeclaration,
  isFunctionExpression,
  isArrowFunction,
  isConditionalExpression,
  isDeleteExpression,
  isDoStatement,
  isElementAccessExpression,
  isExportSpecifier,
  isForInStatement,
  isForOfStatement,
  isIdentifier,
  isIfStatement,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSourceFile,
  isSpreadElement,
  isArrayLiteralExpression,
  isCallExpression,
  isTypeNode,
  isTypeOfExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  isVoidExpression,
  isWhileStatement,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { DEFAULT_ITERATOR, iteratorMemberName } from './framed-iterator-guards.ts';
import { framedMapSet } from './framed-map-mutations.ts';
import { framedQuietOperand } from './framed-quiet-operands.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';
import { readsBinding } from './scope.ts';

/**
 * The members whose replacement changes what a native Map's or Set's iteration yields, or what its
 * mutations store.
 */
const ITERATING: ReadonlySet<string> = new Set([
  '__proto__',
  'add',
  'clear',
  DEFAULT_ITERATOR,
  'delete',
  'entries',
  'forEach',
  'keys',
  'set',
  'values',
]);

/**
 * Which members a scan reads replacements of, and whether a plain assignment of one counts as
 * read (`attributed`), as a reader that reads such an assignment itself has it.
 */
interface MethodScope {
  readonly members: ReadonlySet<string>;
  readonly attributed: ReadonlySet<string>;
}
/** Comparisons, which read a value without handing it on. */
const COMPARISONS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
  SyntaxKind.InstanceOfKeyword,
]);
/** The assignment operators, each of which writes its left operand. */
const ASSIGNMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.SlashEqualsToken,
]);

/**
 * Whether something may replace how the collection the names `bindings` hold iterates before
 * `read`: a use of one of them, or of an alias of one (`aliasesOf`), that may run first
 * (`runsBefore`) and is none the reader proves leaves its iterating methods alone (`quietUse`) —
 * a write to `values`, `keys`, `entries`, `forEach` or `Symbol.iterator`, to a mutator that stores
 * what the iteration yields, `set`, `add`, `delete` or `clear`, or to a member it cannot name,
 * `Object.defineProperty`, `Object.assign` and `Reflect.set` among the uses that hand it on. An
 * exported name may be written where the file cannot see.
 */
export function framedIterationWritten(bindings: ReadonlySet<FrameBinding>, read: Node): boolean {
  return framedMethodsWritten(bindings, read, { members: ITERATING, attributed: new Set() });
}

/**
 * Whether something may replace one of the `scope`'s members of the collection the names
 * `bindings` hold before `read`, as `framedIterationWritten` reads it; a plain assignment of an
 * `attributed` member, which the reader reads itself, does not count.
 */
export function framedMethodsWritten(
  bindings: ReadonlySet<FrameBinding>,
  read: Node,
  scope: { readonly members: ReadonlySet<string>; readonly attributed: ReadonlySet<string> },
): boolean {
  if (bindings.size === 0) return false;
  const file = read.getSourceFile();
  const aliases = aliasesOf(bindings, file);
  if ([...aliases].some((binding) => exported(binding))) return true;
  const reader = executionOwner(read);
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    // A class's `extends` entry runs as the class is declared; only its type arguments are erased.
    if (isTypeNode(node) && !isExpressionWithTypeArguments(node)) continue;
    if (isExportSpecifier(node) && exportsAlias(node.propertyName ?? node.name, aliases))
      return true;
    if (
      isIdentifier(node) &&
      aliasRead(node, aliases) &&
      runsBefore(node, read, reader) &&
      !quietUse(node, aliases, scope)
    )
      return true;
    // An own method's receiver is the collection: no assignment of it is the reader's to read.
    if (
      node.kind === SyntaxKind.ThisKeyword &&
      receiverOf(node, aliases) &&
      !quietUse(node as Expression, aliases, { members: scope.members, attributed: new Set() })
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * The names that may hold the collection: `bindings`, and each name a whole declaration or a
 * plain assignment gives one of them, in turn.
 */
function aliasesOf(bindings: ReadonlySet<FrameBinding>, file: SourceFile): Set<FrameBinding> {
  const aliases = new Set(bindings);
  for (let grown = true; grown;) {
    grown = false;
    const pending: Node[] = [file];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      const alias = aliasMade(node, aliases);
      if (alias !== undefined && !aliases.has(alias)) {
        aliases.add(alias);
        grown = true;
      }
      node.forEachChild((child) => {
        pending.push(child);
      });
    }
  }
  return aliases;
}

/** The name a whole declaration or a plain assignment makes hold one of `aliases`. */
function aliasMade(node: Node, aliases: ReadonlySet<FrameBinding>): FrameBinding | undefined {
  if (isVariableDeclaration(node))
    return node.initializer !== undefined && holdsAlias(node.initializer, aliases)
      ? node
      : undefined;
  if (
    !isBinaryExpression(node) ||
    node.operatorToken.kind !== SyntaxKind.EqualsToken ||
    !holdsAlias(node.right, aliases)
  )
    return undefined;
  const target = unwrapped(node.left);
  const selected = isIdentifier(target) ? frameBindingOf(target) : undefined;
  return selected?.keys.length === 0 ? selected.binding : undefined;
}

/**
 * Whether a value is one of `aliases`, or the receiver of an own method of one (`receiverOf`), read
 * whole past what wraps it and quiet commas.
 */
function holdsAlias(value: Expression, aliases: ReadonlySet<FrameBinding>): boolean {
  const held = framedQuietOperand(value);
  if (held.kind === SyntaxKind.ThisKeyword) return receiverOf(held, aliases);
  if (!isIdentifier(held)) return false;
  const selected = frameBindingOf(held);
  return selected?.keys.length === 0 && aliases.has(selected.binding);
}

/** Whether a name is declared by an exported statement, which other modules may write through. */
function exported(binding: FrameBinding): boolean {
  if (!isVariableDeclaration(binding) || !isVariableDeclarationList(binding.parent)) return false;
  const statement = binding.parent.parent;
  return (
    isVariableStatement(statement) &&
    (statement.modifiers ?? []).some((each) => each.kind === SyntaxKind.ExportKeyword)
  );
}

/** Whether an export specifier hands on one of `aliases`. */
function exportsAlias(name: Node, aliases: ReadonlySet<FrameBinding>): boolean {
  const selected = isIdentifier(name) ? frameBindingOf(name) : undefined;
  return selected !== undefined && aliases.has(selected.binding);
}

/** Whether a name reads one of `aliases` whole, other than where it is declared. */
function aliasRead(name: Identifier, aliases: ReadonlySet<FrameBinding>): boolean {
  if (!readsBinding(name)) return false;
  const selected = frameBindingOf(name);
  return (
    selected?.keys.length === 0 && name !== selected.binding.name && aliases.has(selected.binding)
  );
}

/**
 * Whether a use may run before `read`: in another execution owner, unless an unreferenced local
 * function's; earlier in the same one; or later in a loop around both, on its next pass. A use in
 * a branch the source proves unselected never runs.
 */
function runsBefore(use: Identifier, read: Node, reader: Node): boolean {
  if (!framedPossibleBranch(use)) return false;
  const owner = executionOwner(use);
  if (owner !== reader) return !unreferencedLocalFunction(owner, reader);
  if (use.pos < read.pos) return true;
  const selected = frameBindingOf(use);
  return selected !== undefined && repeatedFrameRead(use, read, selected.binding, reader);
}

/**
 * A use the reader proves leaves the collection's iterating methods alone and hands it to nothing
 * that may write one: what makes an alias, tracked with the others; a member read or a call of
 * one by a name, but a call of `forEach`, which hands the collection to its callback; a write of a
 * member it names that is no iterating one (`ITERATING`); a spread or a loop over it; and a test,
 * `typeof`, `void`, `!` or a comparison of it.
 */
function quietUse(
  name: Expression,
  aliases: ReadonlySet<FrameBinding>,
  scope: MethodScope,
  seen = new Set<Node>(),
): boolean {
  const { at, parent } = useOf(name);
  if (isVariableDeclaration(parent))
    return (
      parent.initializer !== undefined &&
      unwrapped(parent.initializer) === name &&
      aliases.has(parent)
    );
  if (isBinaryExpression(parent)) return quietOperand(parent, at, aliases);
  if (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === at
  )
    return quietMember(parent, scope);
  if (isReturnStatement(parent) || (isArrowFunction(parent) && parent.body === at))
    return quietReturn(at, aliases, scope, seen);
  return borrowedSet(parent, at) || quietPlace(parent, at);
}

/**
 * Whether a use hands the collection to a native Map's or WeakMap's `set` as its receiver, by
 * `call`, `apply` or `Reflect.apply` (`framedMapSet`): the native writes an entry, which the Map
 * readers read as a write, a value it cannot read among them, and replaces no method. A `set` the
 * file may install on the prototype is the prototype scan's to read.
 */
function borrowedSet(parent: Node, at: Node): boolean {
  if (!isCallExpression(parent)) return false;
  const source = framedMapSet(parent);
  return source?.borrowed === true && unwrapped(source.receiver) === at;
}

/**
 * A place that hands a value to nothing: a statement that drops it, a spread or a loop over it, and
 * a test, `typeof`, `void` or `!` of it.
 */
function quietPlace(parent: Node, at: Node): boolean {
  if (isExpressionStatement(parent) || isSpreadElement(parent)) return true;
  if (isTypeOfExpression(parent) || isVoidExpression(parent)) return true;
  if (isPrefixUnaryExpression(parent)) return parent.operator === SyntaxKind.ExclamationToken;
  if (isForOfStatement(parent) || isForInStatement(parent)) return parent.expression === at;
  if (isIfStatement(parent) || isWhileStatement(parent) || isDoStatement(parent))
    return parent.expression === at;
  return isConditionalExpression(parent) && parent.condition === at;
}

/**
 * Whether what an own method of the collection returns, the collection here, reaches only quiet
 * uses: each call of that method on it, `values.set(…)` or `this.set(…)`, uses what it answers as
 * `quietUse` allows. A method none of whose calls the reader can find is quiet; one it is still
 * reading, as a call of it returns into it, is not.
 */
function quietReturn(
  returned: Node,
  aliases: ReadonlySet<FrameBinding>,
  scope: MethodScope,
  seen: Set<Node>,
): boolean {
  const method = returningMethod(returned, aliases);
  if (method === undefined || seen.has(method.fn)) return false;
  seen.add(method.fn);
  return methodCalls(returned.getSourceFile(), method.member, aliases).every((call) =>
    quietUse(call, aliases, scope, seen),
  );
}

/** The own method of the collection a returned value leaves, and the member it is assigned to. */
function returningMethod(
  returned: Node,
  aliases: ReadonlySet<FrameBinding>,
): { readonly fn: Node; readonly member: string } | undefined {
  let fn: Node = returned.parent;
  while (!isSourceFile(fn) && !isArrowFunction(fn) && !isFunctionLike(fn)) fn = fn.parent;
  if (!isArrowFunction(fn) && !isFunctionExpression(fn)) return undefined;
  const { at, parent } = useOf(fn);
  if (
    !isBinaryExpression(parent) ||
    parent.right !== at ||
    parent.operatorToken.kind !== SyntaxKind.EqualsToken
  )
    return undefined;
  const target = unwrapped(parent.left);
  if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) return undefined;
  const member = iteratorMemberName(target);
  return member !== undefined && collectionReceiver(target.expression, aliases)
    ? { fn, member }
    : undefined;
}

/** Each call of `member` on the collection: through one of `aliases`, or an own method's `this`. */
function methodCalls(
  file: SourceFile,
  member: string,
  aliases: ReadonlySet<FrameBinding>,
): readonly Expression[] {
  const calls: Expression[] = [];
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isCallExpression(node)) {
      const callee = unwrapped(node.expression);
      if (
        (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
        iteratorMemberName(callee) === member &&
        collectionReceiver(callee.expression, aliases)
      )
        calls.push(node);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return calls;
}

/** Whether an expression reads the collection: one of `aliases` whole, or an own method's `this`. */
function collectionReceiver(node: Expression, aliases: ReadonlySet<FrameBinding>): boolean {
  const value = unwrapped(node);
  if (value.kind === SyntaxKind.ThisKeyword) return receiverOf(value, aliases);
  const selected = isIdentifier(value) ? frameBindingOf(value) : undefined;
  return selected?.keys.length === 0 && aliases.has(selected.binding);
}

/**
 * Whether `this` here may be the collection: the receiver of a function a plain assignment makes an
 * own method of one of `aliases`, `values.set = function () { … }`, read past the arrows inside it,
 * which keep their function's receiver.
 */
function receiverOf(node: Node, aliases: ReadonlySet<FrameBinding>): boolean {
  let fn: Node = node.parent;
  while (!isSourceFile(fn) && (isArrowFunction(fn) || !isFunctionLike(fn))) fn = fn.parent;
  if (!isFunctionExpression(fn)) return false;
  const { at, parent } = useOf(fn);
  if (
    !isBinaryExpression(parent) ||
    parent.right !== at ||
    parent.operatorToken.kind !== SyntaxKind.EqualsToken
  )
    return false;
  const target = unwrapped(parent.left);
  if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) return false;
  const receiver = unwrapped(target.expression);
  const selected = isIdentifier(receiver) ? frameBindingOf(receiver) : undefined;
  return selected?.keys.length === 0 && aliases.has(selected.binding);
}

/** Whether a node binds a receiver of its own: a function, a method, an accessor or a class. */
function isFunctionLike(node: Node): boolean {
  return (
    isFunctionLikeDeclaration(node) ||
    isClassLikeDeclaration(node) ||
    isClassStaticBlockDeclaration(node)
  );
}

/**
 * A binary operand that hands the collection to nothing: the value of an assignment that makes an
 * alias, or a side of a comparison or the object of `in`.
 */
function quietOperand(
  parent: BinaryExpression,
  at: Node,
  aliases: ReadonlySet<FrameBinding>,
): boolean {
  const operator = parent.operatorToken.kind;
  if (operator === SyntaxKind.EqualsToken && parent.right === at) {
    const target = unwrapped(parent.left);
    const selected = isIdentifier(target) ? frameBindingOf(target) : undefined;
    return selected?.keys.length === 0 && aliases.has(selected.binding);
  }
  return COMPARISONS.has(operator) || (operator === SyntaxKind.InKeyword && parent.right === at);
}

/**
 * A member of the collection read or written by a name: a write leaves its iteration alone where
 * the name is no iterating one; a read does, but a call of `forEach`.
 */
function quietMember(member: Expression, scope: MethodScope): boolean {
  const name = iteratorMemberName(member);
  if (writtenMember(member)) {
    if (name === undefined) return false;
    if (!scope.members.has(name)) return true;
    return scope.attributed.has(name) && plainlyAssigned(member);
  }
  if (name !== 'forEach') return true;
  const { at, parent } = useOf(member);
  return !isCallExpression(parent) || parent.expression !== at;
}

/** Whether a member is the target of a plain assignment, `member = value`. */
function plainlyAssigned(member: Expression): boolean {
  const { at, parent } = useOf(member);
  return (
    isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === at
  );
}

/**
 * Whether a member read is written: an assignment's target, one a destructuring assignment or a
 * loop's head writes, or the operand of `delete`, `++` or `--`.
 */
function writtenMember(member: Expression): boolean {
  let { at, parent } = useOf(member);
  for (;;) {
    if (isBinaryExpression(parent))
      return ASSIGNMENTS.has(parent.operatorToken.kind) && parent.left === at;
    if (isForOfStatement(parent) || isForInStatement(parent)) return parent.initializer === at;
    if (isDeleteExpression(parent)) return true;
    if (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent))
      return (
        parent.operator === SyntaxKind.PlusPlusToken ||
        parent.operator === SyntaxKind.MinusMinusToken
      );
    if (isPropertyAssignment(parent) && parent.initializer === at)
      ({ at, parent } = useOf(parent.parent));
    else if (isSpreadElement(parent) || isArrayLiteralExpression(parent))
      ({ at, parent } = useOf(parent));
    else return false;
  }
}
