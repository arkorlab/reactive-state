import {
  type BinaryExpression,
  type ElementAccessExpression,
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionLikeDeclaration,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type PropertyAccessExpression,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { overloadsOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { frameBindingOf, frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { type MemberWrite, patternMemberWrites } from './framed-pattern-members.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';

/** The assignments to a member of an object a constant holds: a constant does not freeze it. */

export interface HeldWrite {
  /** The member's name, none where it is computed and the compile cannot read it. */
  readonly key: string | undefined;
  readonly value: Expression;
}

/**
 * The values assigned, anywhere in the program, to a member of what the names hold, or of what a
 * name that stands for it for good holds: a constant, or a variable no assignment changes. The
 * object is made where the last name is declared, which a loop that holds that declaration makes
 * again; an alias declared in the loop does not.
 */
export function heldMemberWrites(
  first: Identifier,
  names: readonly Identifier[],
): readonly HeldWrite[] {
  const bindings = heldBindings(first, names);
  const declared = frameBindingOf(names.at(-1) ?? first)?.binding;
  const found: HeldWrite[] = [];
  const pending: Node[] = [first.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const written = heldWrite(node, bindings);
    if (declared !== undefined && written.length > 0 && mayPrecede(node, first, declared))
      found.push(...written);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return found;
}

/**
 * Whether a write may run before the descriptor named at `use` is read: it lies before the read,
 * in another function that is referenced, which may run first, or in a loop the use is in, whose
 * next turn follows it.
 */
function mayPrecede(write: Node, use: Identifier, declared: Node): boolean {
  const owner = executionOwner(use);
  const writer = executionOwner(write);
  if (writer !== owner) return !unreferencedLocalFunction(writer, owner);
  return repeatedFrameRead(write, use, declared, owner) || write.pos < readAt(use).end;
}

function isStatementKind(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstStatement && kind <= SyntaxKind.LastStatement;
}

/** The operators that hand over one of their operands. */
const LOGICAL: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * Where the object a descriptor names is read: by the call whose arguments hold the name, after
 * they are all evaluated; by the name itself, where it is spread, which copies it at once. A spread
 * of something that holds the name, a list of it, copies the reference only.
 */
function readAt(use: Identifier): Node {
  for (let at: Node = use.parent; !isSourceFile(at); at = at.parent) {
    if ((isSpreadAssignment(at) || isSpreadElement(at)) && spreads(at.expression, use)) return use;
    if (isCallExpression(at) || isNewExpression(at)) return at;
    if (isFunctionLikeDeclaration(at) || isStatementKind(at.kind)) break;
  }
  return use;
}

/** Whether what a spread copies may be the object the name stands for, whole. */
function spreads(copied: Expression, use: Identifier): boolean {
  const value = unwrapped(copied);
  if (value === use) return true;
  if (isConditionalExpression(value))
    return spreads(value.whenTrue, use) || spreads(value.whenFalse, use);
  const logical = isBinaryExpression(value) && LOGICAL.has(value.operatorToken.kind);
  return logical && (spreads(value.left, use) || spreads(value.right, use));
}

/** The values one assignment, or a destructuring one, gives the members of a held object. */
function heldWrite(node: Node, bindings: ReadonlySet<unknown>): readonly HeldWrite[] {
  const held = memberWrites(node).filter(({ member }) => writesHeld(member, bindings));
  if (held.length === 0 || !framedPossibleBranch(node)) return [];
  return held.flatMap(({ member, values }) =>
    values.map((value) => ({ key: frameMemberName(member), value })),
  );
}

/** The members an assignment, a destructuring one, or a loop head writes, with their values. */
function memberWrites(node: Node): readonly MemberWrite[] {
  if (!isAssignment(node)) return patternMemberWrites(node);
  const direct = unwrapped(node.left);
  return isMember(direct) ? [{ member: direct, values: [node.right] }] : patternMemberWrites(node);
}

function isMember(node: Node): node is PropertyAccessExpression | ElementAccessExpression {
  return isPropertyAccessExpression(node) || isElementAccessExpression(node);
}

/** The bindings of the names, and of each name a program gives them for good. */
function heldBindings(first: Identifier, names: readonly Identifier[]): ReadonlySet<unknown> {
  const bindings = new Set<unknown>(names.map((name) => frameBindingOf(name)?.binding));
  const declarations: VariableDeclaration[] = [];
  const reassigned = new Set<unknown>();
  const pending: Node[] = [first.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isVariableDeclaration(node) && node.initializer !== undefined) declarations.push(node);
    for (const each of writtenBindings(node)) reassigned.add(each);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  for (let grown = true; grown;) {
    const aliases = declarations.filter(
      (each) => !bindings.has(each) && namesHeld(each, bindings, reassigned),
    );
    for (const each of aliases) bindings.add(each);
    grown = aliases.length > 0;
  }
  return bindings;
}

/** What an assignment or a loop head gives a new value to: the names its target holds, no member. */
function writtenBindings(node: Node): readonly unknown[] {
  const target = writeTarget(node);
  const found: unknown[] = [];
  const pending: Node[] = target === undefined ? [] : [target];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (isPropertyAccessExpression(each) || isElementAccessExpression(each)) continue;
    if (isIdentifier(each)) found.push(frameBindingOf(each)?.binding);
    each.forEachChild((child) => {
      pending.push(child);
    });
  }
  return found;
}

/** The target an assignment of any kind, or a for-of or for-in head, gives a new value. */
function writeTarget(node: Node): Node | undefined {
  if (isBinaryExpression(node) && isAssignmentKind(node.operatorToken.kind)) return node.left;
  const head = isForOfStatement(node) || isForInStatement(node);
  return head && isExpression(node.initializer) ? node.initializer : undefined;
}

function isAssignmentKind(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
}

/**
 * Whether a declaration gives a name to what one of the bindings names, whole, for good: a
 * constant, or a variable no assignment gives another value.
 */
function namesHeld(
  declaration: VariableDeclaration,
  bindings: ReadonlySet<unknown>,
  reassigned: ReadonlySet<unknown>,
): boolean {
  if (!isConstant(declaration) && reassigned.has(declaration)) return false;
  const held =
    declaration.initializer === undefined ? undefined : unwrapped(declaration.initializer);
  const selected = held !== undefined && isIdentifier(held) ? frameBindingOf(held) : undefined;
  return selected?.keys.length === 0 && bindings.has(selected.binding);
}

/** The assignments that may give their left the value of their right: `=` and the logical ones. */
const VALUE_WRITES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** An assignment that may give its left the value of its right. */
function isAssignment(node: Node): node is BinaryExpression {
  return isBinaryExpression(node) && VALUE_WRITES.has(node.operatorToken.kind);
}

/** Whether a member is one of an object a held binding names, whole. */
function writesHeld(
  member: PropertyAccessExpression | ElementAccessExpression,
  bindings: ReadonlySet<unknown>,
): boolean {
  const receiver = unwrapped(member.expression);
  const selected = isIdentifier(receiver) ? frameBindingOf(receiver) : undefined;
  return selected?.keys.length === 0 && bindings.has(selected.binding);
}

/** Whether a variable is declared with `const`, which no later write changes. */
export function isConstant(declaration: Node): boolean {
  const list = declaration.parent;
  return isVariableDeclarationList(list) && /^const\b/u.test(list.getText(list.getSourceFile()));
}

/**
 * What a name holds: a function it declares, or the initializer of a constant it names whole; the
 * names it passes through are given back.
 */
export function heldValue(
  expression: Expression,
  names: Identifier[] = [],
): Expression | FunctionDeclaration {
  let value = unwrapped(expression);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    names.push(value);
    const declared = frameDeclarationOf(value);
    if (declared !== undefined && isFunctionDeclaration(declared))
      return implementationOf(declared);
    const selected = frameBindingOf(value);
    const held =
      selected?.keys.length === 0 &&
      isVariableDeclaration(selected.binding) &&
      isConstant(selected.binding)
        ? selected.binding.initializer
        : undefined;
    if (held === undefined) return value;
    value = unwrapped(held);
  }
  return value;
}

/** The declaration that has the body among those a function is declared over: its signatures. */
function implementationOf(declared: FunctionDeclaration): FunctionDeclaration {
  const written = overloadsOf(declared).find(
    (each): each is FunctionDeclaration => isFunctionDeclaration(each) && each.body !== undefined,
  );
  return written ?? declared;
}
