import {
  type BinaryExpression,
  type ElementAccessExpression,
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBindingElement,
  isDeleteExpression,
  isFunctionExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isVoidExpression,
  type ObjectLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isExpression,
  isForInStatement,
  isForOfStatement,
  isGetAccessorDeclaration,
  isFunctionDeclaration,
  isFunctionLikeDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isSourceFile,
  isSpreadAssignment,
  isSetAccessorDeclaration,
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
import { globalPathOf } from './code-globals.ts';
import { executionOwner } from './framed-array-mutations.ts';
import { assignmentPatternDefault } from './framed-assignment-patterns.ts';
import { frameBindingOf, frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { classify } from './framed-known-uses.ts';
import { type MemberWrite, patternMemberWrites } from './framed-pattern-members.ts';
import { framedPossibleBranch, repeatedFrameRead } from './framed-writes.ts';

/** The assignments to a member of an object a constant holds: a constant does not freeze it. */

export interface HeldWrite {
  /** The member's name, none where it is computed and the compile cannot read it. */
  readonly key: string | undefined;
  /** What is assigned: the value held at the path, or the whole of it where the path is none. */
  readonly value: Expression;
  readonly keys: readonly string[];
  /** The names a rest left out of the copy it gives the member. */
  readonly without?: readonly string[] | undefined;
  /** The member is given a list of entries, an array rest: no getter, and no descriptor. */
  readonly list?: boolean | undefined;
  /** The assignment or loop head that writes it: what it selects is read where it runs. */
  readonly node: Node;
  /** Where a rest copies its source, whose later changes the copy does not hold. */
  readonly copiedAt?: Node | undefined;
  /** What the member must be for a logical assignment to run its right side. */
  readonly runsIf?: 'falsy' | 'nullish' | 'truthy' | undefined;
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
  consumedAt?: Node,
): readonly HeldWrite[] {
  const bindings = heldBindings(first, names);
  const declared = frameBindingOf(names.at(-1) ?? first)?.binding;
  const found: Written[] = [];
  const recorded: Written[] = [];
  const changed: (string | undefined)[] = [];
  let handed = false;
  const pending: Node[] = [first.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const writes = heldWrite(node, bindings);
    if (writes.length > 0) recorded.push({ node, writes });
    changed.push(...otherChanges(node, bindings));
    handed ||= handedToChange(node, bindings);
    if (
      declared !== undefined &&
      writes.length > 0 &&
      mayPrecede(node, first, declared, consumedAt)
    )
      found.push({ node, writes });
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const initial = heldValue(first);
  return found.flatMap(({ node, writes }) =>
    writes.filter((write) => !skipsRight(write, node, { recorded, changed, initial, handed })),
  );
}

/** The writes one node makes, with the node. */
interface Written {
  readonly node: Node;
  readonly writes: readonly HeldWrite[];
}

/**
 * Whether a write may run before the descriptor named at `use` is read: it lies before the read,
 * in another function that is referenced, which may run first, or in a loop the use is in, whose
 * next turn follows it.
 */
function mayPrecede(write: Node, use: Identifier, declared: Node, consumedAt?: Node): boolean {
  const owner = executionOwner(use);
  const writer = executionOwner(write);
  if (writer !== owner) return !unreferencedLocalFunction(writer, owner);
  return repeatedFrameRead(write, use, declared, owner) || write.pos < readAt(use, consumedAt).end;
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
 * of something that holds the name, a list of it, copies the reference only. A name a constant
 * holds, in a map or a list, is read where that is consumed.
 */
function readAt(use: Identifier, consumedAt: Node = use): Node {
  for (let at: Node = use.parent; !isSourceFile(at); at = at.parent) {
    if ((isSpreadAssignment(at) || isSpreadElement(at)) && spreads(at.expression, use)) return use;
    if (isCallExpression(at) || isNewExpression(at)) return at;
    if (isFunctionLikeDeclaration(at) || isStatementKind(at.kind)) break;
  }
  return consumedAt;
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
  return held.flatMap(({ member, values }) => {
    return values.map(({ value, keys, without, list }) => {
      return {
        key: frameMemberName(member),
        value,
        keys,
        without,
        list,
        node,
        copiedAt: without === undefined ? undefined : node,
        runsIf: runsIf(node),
      };
    });
  });
}

/** What the member must be for a logical assignment to run its right side; none for another. */
function runsIf(node: Node): HeldWrite['runsIf'] {
  if (!isBinaryExpression(node)) return undefined;
  const kind = node.operatorToken.kind;
  if (kind === SyntaxKind.QuestionQuestionEqualsToken) return 'nullish';
  if (kind === SyntaxKind.BarBarEqualsToken) return 'falsy';
  return kind === SyntaxKind.AmpersandAmpersandEqualsToken ? 'truthy' : undefined;
}

/**
 * The members an assignment, a destructuring one, or a loop head writes, with their values. A
 * default inside a pattern is the pattern's to route: it runs only where the value is missing.
 */
function memberWrites(node: Node): readonly MemberWrite[] {
  if (!isAssignment(node)) return patternMemberWrites(node);
  if (assignmentPatternDefault(node)) return [];
  const direct = unwrapped(node.left);
  return isMember(direct)
    ? [{ member: direct, values: [{ value: node.right, keys: [] }] }]
    : patternMemberWrites(node);
}

/** The assignments that may give their left the value of their right: `=` and the logical ones. */
const VALUE_WRITES: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * The names of the held members a node changes without giving them a value to read: an arithmetic
 * assignment, an increment, a deletion. None of them is a write the compile follows, and each leaves
 * what the member held unknown to a logical assignment.
 */
function otherChanges(node: Node, bindings: ReadonlySet<unknown>): readonly (string | undefined)[] {
  let changed: Expression | undefined;
  const compound =
    isBinaryExpression(node) &&
    isAssignmentKind(node.operatorToken.kind) &&
    !VALUE_WRITES.has(node.operatorToken.kind);
  if (compound) changed = node.left;
  else if (isDeleteExpression(node)) changed = node.expression;
  else if (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node))
    changed =
      node.operator === SyntaxKind.PlusPlusToken || node.operator === SyntaxKind.MinusMinusToken
        ? node.operand
        : undefined;
  const member = changed === undefined ? undefined : unwrapped(changed);
  return member !== undefined && isMember(member) && writesHeld(member, bindings)
    ? [frameMemberName(member)]
    : [];
}

/**
 * Whether a node is a mention of a held object that may change it: any mention that is no use the
 * compile knows. The uses are named in `framed-known-uses`: the same for every reader of a held
 * object.
 */
function handedToChange(node: Node, bindings: ReadonlySet<unknown>): boolean {
  if (!isIdentifier(node) || isDeclaredName(node)) return false;
  if (!bindings.has(frameBindingOf(node)?.binding)) return false;
  return !classify(node, 'held').known;
}

/** Whether an identifier only names: a property, a parameter, a variable, a binding. */
function isDeclaredName(node: Identifier): boolean {
  const { parent } = node;
  if (isBindingElement(parent)) return parent.name === node || parent.propertyName === node;
  if (isPropertyAccessExpression(parent)) return parent.name === node;
  const named =
    isVariableDeclaration(parent) ||
    isParameterDeclaration(parent) ||
    isPropertyAssignment(parent) ||
    isMethodDeclaration(parent) ||
    isGetAccessorDeclaration(parent) ||
    isSetAccessorDeclaration(parent);
  return named && parent.name === node;
}

/** What a held descriptor holds, and what has changed it, when a logical assignment is asked to run. */
interface Holding {
  readonly recorded: readonly Written[];
  readonly changed: readonly (string | undefined)[];
  readonly initial: Expression | FunctionDeclaration;
  /** Whether the object is handed to a call that may change it. */
  readonly handed: boolean;
}

/**
 * Whether a logical assignment never runs its right side: no other write or change of the member
 * is made, so the member holds what the constant's literal wrote, and that is a value the
 * assignment's condition rules out. Anything else leaves the right side possible.
 */
function skipsRight(
  write: HeldWrite,
  node: Node,
  { recorded, changed, initial, handed }: Holding,
): boolean {
  if (handed || write.runsIf === undefined || write.key === undefined) return false;
  const others = recorded.some((each) => {
    return (
      each.node !== node &&
      each.writes.some((other) => other.key === undefined || other.key === write.key)
    );
  });
  if (others || changed.some((key) => key === undefined || key === write.key)) return false;
  const state = isObjectLiteralExpression(initial) ? fieldState(initial, write.key) : undefined;
  if (state === undefined) return false;
  if (write.runsIf === 'nullish') return !state.nullish;
  return write.runsIf === 'falsy' ? state.truthy : !state.truthy;
}

/** What a written value is as a condition and as a test for null or undefined. */
interface State {
  readonly truthy: boolean;
  readonly nullish: boolean;
}

const NULLISH: State = { truthy: false, nullish: true };
const PRESENT: State = { truthy: true, nullish: false };

/** The state of a field an object literal writes: none where a spread, a prototype or a name is unknown. */
function fieldState(object: ObjectLiteralExpression, key: string): State | undefined {
  for (const property of object.properties.toReversed()) {
    if (isSpreadAssignment(property)) return undefined;
    const name =
      isPropertyAssignment(property) || isShorthandPropertyAssignment(property)
        ? propertyKey(property.name)
        : undefined;
    if (name === undefined || name === '__proto__') return undefined;
    if (name !== key) continue;
    return isPropertyAssignment(property) ? stateOf(property.initializer) : undefined;
  }
  return { truthy: false, nullish: true };
}

/** The name of a field written as an identifier, a string or a number. */
function propertyKey(name: Node): string | undefined {
  if (isIdentifier(name) || isStringLiteral(name)) return name.text;
  return isNumericLiteral(name) ? String(Number(name.text)) : undefined;
}

/** The state of a value written out: a function, a literal, null, undefined; none for any other. */
function stateOf(expression: Expression): State | undefined {
  const value = unwrapped(expression);
  if (value.kind === SyntaxKind.NullKeyword || isVoidExpression(value)) return NULLISH;
  if (isIdentifier(value))
    return globalPathOf(value)?.join('.') === 'undefined' ? NULLISH : undefined;
  if (value.kind === SyntaxKind.FalseKeyword) return { truthy: false, nullish: false };
  if (value.kind === SyntaxKind.TrueKeyword) return PRESENT;
  if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value))
    return { truthy: value.text !== '', nullish: false };
  if (isNumericLiteral(value)) return { truthy: Number(value.text) !== 0, nullish: false };
  const written =
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value);
  return written ? PRESENT : undefined;
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
