import {
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isArrowFunction,
  isCallExpression,
  isConditionalExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExpression,
  isExpressionStatement,
  isForInStatement,
  isForOfStatement,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTemplateSpan,
  isTypeNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type PropertyAccessExpression,
  type ObjectLiteralExpression,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import {
  ARRAY_METHODS,
  borrowedMethod,
  ELEMENT_RETURNING,
  DESCRIPTOR_FIELDS,
  callsBack,
  handsArray,
  isFirstArgument,
  LIST_FIELDS,
  NO_FIELDS,
  READERS,
  readsWithoutCallback,
  type Borrowed,
} from './framed-array-callbacks.ts';
import { arrayIdentity } from './framed-array-identity.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { iterates } from './framed-iterated-uses.ts';
import {
  coercesArgument,
  mutatorInvocation,
  nativePath,
  type MutatorInvocation,
} from './framed-mutator-calls.ts';
import { tested } from './framed-tested-uses.ts';
import { readsBinding } from './scope.ts';

/**
 * The uses of an array, a descriptor, a map or a list that the compile follows, and nothing else.
 *
 * The compile reads what a native object mutator installs from the objects it is handed, and takes
 * each of them as the source wrote it. An object is followed only where every mention of it, and of
 * each name that stands for it, is a use this module knows: a declaration, a constant that names it,
 * a member read that no call or write follows, a spread or a destructuring of it, a test, an
 * argument of a native mutator it knows, a write to one of its own members that the readers of
 * writes collect. Any other mention may write it in a way no reader follows (an unknown callee, a
 * literal that holds it, a return, a destructured alias, a write through a member of a member), and
 * the compile refuses what it cannot show safe. A program that uses these forms is refused too.
 *
 * Not covered: `eval` and `Function`, a `Proxy` whose trap runs application code, a `with` scope,
 * and code of other files. What a getter or a setter of a written literal runs is read by the
 * readers of that literal.
 */

/**
 * What is followed: an array whose methods and elements are read, a held object that feeds one, or a
 * held list, whose entries a spread places by position and whose writes no reader of a spread collects.
 */
export type Subject = 'array' | 'box' | 'held' | 'list';

/** What a mention is: a use the compile knows or not, and the constant it names the same, if any. */
export interface Use {
  readonly known: boolean;
  readonly alias?: VariableDeclaration;
  /** The name holds the mention in a literal: a member of it, or a name that takes it apart, is the mention. */
  readonly contained?: boolean;
}

const KNOWN: Use = { known: true };
const UNKNOWN: Use = { known: false };

/** The operators that hand over one of their operands. */
const LOGICAL: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** The methods of an array that answer the array itself. */
const SELF_RETURNING: ReadonlySet<string> = new Set(['copyWithin', 'fill', 'reverse', 'sort']);

/** The node that stands for the same value as `node`, through parentheses and assertions. */
export function outermost(node: Node): Node {
  let at = node;
  while (isExpression(at.parent) && unwrapped(at.parent) === node) at = at.parent;
  return at;
}

/**
 * Whether every mention of the constant, and of each constant that only names it, is a use the
 * compile knows for the subject, among those `relevant` keeps. A name that is written as a whole
 * elsewhere is not followed.
 */
export function knownUsesOnly(
  declaration: VariableDeclaration,
  subject: Subject,
  relevant: (name: Identifier) => boolean = () => true,
): boolean {
  const kinds = new Map<VariableDeclaration, Subject>([[declaration, subject]]);
  const pending: VariableDeclaration[] = [declaration];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const base = kinds.get(at) ?? subject;
    const kind = base === 'held' && holdsList(at) ? 'list' : base;
    const uses = usesOf(at, kind, relevant);
    if (uses === undefined) return false;
    for (const { alias, contained } of uses) {
      if (alias === undefined || kinds.has(alias)) continue;
      kinds.set(alias, contained === true ? 'box' : kind);
      pending.push(alias);
    }
  }
  return true;
}

/** The uses the mentions of a constant make, none where one is not known or the name is no constant. */
function usesOf(
  declaration: VariableDeclaration,
  kind: Subject,
  relevant: (name: Identifier) => boolean,
): readonly Use[] | undefined {
  if (!constant(declaration)) return undefined;
  const seen = mentions(declaration).filter((each) => relevant(each));
  const uses = seen.map((name) => classify(name, kind));
  return uses.every((use) => use.known) ? uses : undefined;
}

/** Whether a constant starts as a written list. */
function holdsList(declaration: VariableDeclaration): boolean {
  const { initializer } = declaration;
  return initializer !== undefined && isArrayLiteralExpression(unwrapped(initializer));
}

/** Whether a declaration is a constant, which no later write gives another value. */
function constant(declaration: VariableDeclaration): boolean {
  const list = declaration.parent;
  return isVariableDeclarationList(list) && /^const\b/u.test(list.getText(list.getSourceFile()));
}

/** The identifiers that read the binding, apart from the name that declares it. */
function mentions(declaration: VariableDeclaration): Identifier[] {
  const found: Identifier[] = [];
  const pending: Node[] = [declaration.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (isIdentifier(node) && node !== declaration.name && readsBinding(node)) {
      const selected = frameBindingOf(node);
      if (selected?.binding === declaration && selected.keys.length === 0) found.push(node);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return found;
}

/** What one mention of a name is. */
export function classify(name: Identifier, subject: Subject): Use {
  let at = outermost(name);
  let handed = false;
  while (passed(at)) {
    at = outermost(at.parent);
    handed = true;
  }
  const { parent } = at;
  if ((handed || subject === 'held' || subject === 'box') && iterates(at)) return UNKNOWN;
  if (isVariableDeclaration(parent)) return handed ? UNKNOWN : aliased(parent, at, subject);
  if (isSpreadAssignment(parent) || isExpressionStatement(parent)) return KNOWN;
  if (subject === 'array' && readsArray(at)) return KNOWN;
  const taken = patternSource(parent, at, subject);
  if (taken !== undefined) return taken;
  if (tested(at)) return KNOWN;
  const member = isPropertyAccessExpression(parent) || isElementAccessExpression(parent);
  if (member && parent.expression === at) return memberUse(parent, handed ? 'box' : subject);
  return flowUse(at, subject);
}

/** Whether an expression hands its value on as the value of the one that holds it: a branch, an operand. */
function passed(at: Node): boolean {
  const { parent } = at;
  if (isConditionalExpression(parent)) return parent.condition !== at;
  if (!isBinaryExpression(parent)) return false;
  const { kind } = parent.operatorToken;
  return LOGICAL.has(kind) || (kind === SyntaxKind.CommaToken && parent.right === at);
}

/** A constant that a mention is the initializer of names the same thing; a pattern takes it apart. */
function aliased(declaration: VariableDeclaration, at: Node, subject: Subject): Use {
  const initializer: Node | undefined = declaration.initializer;
  if (initializer !== at) return KNOWN;
  if (isIdentifier(declaration.name)) return { known: true, alias: declaration };
  return subject === 'box' ? UNKNOWN : KNOWN;
}

/**
 * A mention that an assignment takes apart by a pattern: known, but where a literal holds a followed
 * object, whose members are the objects themselves. Another operator is no pattern (`({}) + held`
 * coerces the object, which runs its methods).
 */
function patternSource(parent: Node, at: Node, subject: Subject): Use | undefined {
  if (!isBinaryExpression(parent) || parent.right !== at) return undefined;
  if (parent.operatorToken.kind !== SyntaxKind.EqualsToken) return undefined;
  const left = isExpression(parent.left) ? unwrapped(parent.left) : parent.left;
  if (!isObjectLiteralExpression(left) && !isArrayLiteralExpression(left)) return undefined;
  return subject === 'box' ? UNKNOWN : KNOWN;
}

/**
 * Whether a mention of an array is read: converted to text by a template, an operator or a native
 * that does with it as its first argument (a later one is coerced, and runs the methods of what it is), spread into a list, or iterated by a loop. The array's own methods run through the
 * conversion, and what a read gives is followed by the readers.
 */
function readsArray(at: Node): boolean {
  const { parent } = at;
  if (isTemplateSpan(parent) || (isForOfStatement(parent) && parent.expression === at)) return true;
  if (
    isSpreadElement(parent) &&
    !isCallExpression(parent.parent) &&
    !isNewExpression(parent.parent)
  )
    return true;
  if (isBinaryExpression(parent) && parent.operatorToken.kind === SyntaxKind.PlusToken) return true;
  if (!isFirstArgument(parent, at)) return false;
  const path = nativePath(parent.expression);
  return path !== undefined && readsWithoutCallback(parent, path);
}

/** The name a member reads, where it is written out. */
function memberName(access: Node): string | undefined {
  return isPropertyAccessExpression(access) || isElementAccessExpression(access)
    ? frameMemberName(access)
    : undefined;
}

/**
 * What a member of a mention is used for. A call runs it with the object as its receiver, which the
 * compile follows only for a native method of an array; a write to a member of the mention itself
 * is a write the readers collect, one to a member of a member is not; a read is known where what it
 * gives goes no further than a read does.
 */
function memberUse(first: Node, subject: Subject): Use {
  let access = first;
  for (let depth = 1; ; depth += 1) {
    const result = outermost(access);
    const { parent: user } = result;
    const deeper =
      (isPropertyAccessExpression(user) || isElementAccessExpression(user)) &&
      user.expression === result;
    if (!deeper) return memberResult(access, result, { subject, depth });
    access = user;
  }
}

/** What a member read, called or written at the end of a chain of members is used for. */
function memberResult(
  access: Node,
  result: Node,
  { subject, depth }: { readonly subject: Subject; readonly depth: number },
): Use {
  const { parent: user } = result;
  if (isTaggedTemplateExpression(user)) return UNKNOWN;
  if ((isCallExpression(user) || isNewExpression(user)) && user.expression === result)
    return methodCall(access, user, subject);
  if (written(result))
    return depth === 1 && subject !== 'list' && subject !== 'box' ? KNOWN : UNKNOWN;
  return subject === 'array' ? KNOWN : resultUse(result, memberName(access), { depth, subject });
}

/** A method called on a mention: a native method of an array, whose answer goes where it is known. */
function methodCall(access: Node, call: Node, subject: Subject): Use {
  const name = memberName(access);
  if (subject !== 'array' || name === undefined || !ARRAY_METHODS.has(name)) return UNKNOWN;
  if (isCallExpression(call) && handsArray(call, name)) return UNKNOWN;
  if (ELEMENT_RETURNING.has(name) && elementWritten(call)) return UNKNOWN;
  return SELF_RETURNING.has(name) ? answerUse(call) : KNOWN;
}

/**
 * Whether the element a method answers is written or called through a member (`array.at(0).x = value`):
 * a member of a member of the array, which no reader of writes collects, as for an index.
 */
function elementWritten(call: Node): boolean {
  const start = outermost(call);
  let at = start;
  for (let { parent } = at; isMemberOf(parent, at); { parent } = at) at = outermost(parent);
  const { parent } = at;
  const called = (isCallExpression(parent) || isNewExpression(parent)) && parent.expression === at;
  return at !== start && (written(at) || called);
}

/** Whether a node is a member read of the expression: `at.name` or `at[key]`. */
function isMemberOf(
  node: Node,
  at: Node,
): node is PropertyAccessExpression | ElementAccessExpression {
  return (
    (isPropertyAccessExpression(node) || isElementAccessExpression(node)) && node.expression === at
  );
}

/**
 * Where what an expression answers goes, where the array itself is what it answers: discarded, tested,
 * the target of another native mutator of a written array, or a field of a literal that such a mutator
 * is handed, which the compile reads as it reads any operand.
 */
function answerUse(answer: Node): Use {
  let at = outermost(answer);
  for (;;) {
    const { parent } = at;
    if (isExpressionStatement(parent) || tested(at)) return KNOWN;
    const comma = isBinaryExpression(parent) && parent.operatorToken.kind === SyntaxKind.CommaToken;
    if (!comma) break;
    if (parent.left === at) return KNOWN;
    at = outermost(parent);
  }
  const { parent } = at;
  const member = isPropertyAccessExpression(parent) || isElementAccessExpression(parent);
  if (member && parent.expression === at) return memberUse(parent, 'array');
  return chained(at);
}

/** An answer that is the target of a native mutator of a written array, or a field of what it is handed. */
function chained(at: Node): Use {
  const flowing = containing(at);
  const user = flowing.top.parent;
  if (!isCallExpression(user) || !onArray(user)) return UNKNOWN;
  if (flowing.inLiteral) return KNOWN;
  const first = mutatorInvocation(user)?.args[0];
  const target: Node | undefined = first === undefined ? undefined : outermost(first);
  return target !== undefined && target === flowing.top ? answerUse(user) : UNKNOWN;
}

/**
 * What a member read hands over: a field of a descriptor, the length of a list, a read, or nothing
 * the compile follows. A literal that holds a followed object holds it under any name, `value` and
 * `length` among them: what its members give is that object.
 */
function resultUse(
  result: Node,
  field: string | undefined,
  { depth, subject }: { readonly depth: number; readonly subject: Subject },
): Use {
  const { parent } = result;
  if (isExpressionStatement(parent) || tested(result) || isTemplateSpan(parent)) return KNOWN;
  if (isVariableDeclaration(parent)) {
    const initializer: Node | undefined = parent.initializer;
    const direct = initializer === result && depth === 1 && field !== undefined;
    return direct && dataFields(subject).has(field) ? KNOWN : UNKNOWN;
  }
  return readerArgument(result) ? KNOWN : UNKNOWN;
}

/** The fields of a subject whose values are functions and data, no object the compile follows. */
function dataFields(subject: Subject): ReadonlySet<string> {
  if (subject === 'held') return DESCRIPTOR_FIELDS;
  return subject === 'list' ? LIST_FIELDS : NO_FIELDS;
}

/** Whether a node is an argument of a native that reads and runs no application code. */
function readerArgument(at: Node): boolean {
  const { parent } = at;
  if (!isFirstArgument(parent, at)) return false;
  const path = nativePath(parent.expression);
  return path !== undefined && READERS.has(path);
}

/** Whether a node is written: the left of an assignment, a pattern's place, a loop head, `delete`, `++`. */
export function written(node: Node): boolean {
  let at = node;
  for (;;) {
    const { parent } = at;
    if (isBinaryExpression(parent)) {
      const { kind } = parent.operatorToken;
      return (
        parent.left === at &&
        kind >= SyntaxKind.FirstAssignment &&
        kind <= SyntaxKind.LastAssignment
      );
    }
    if (isForInStatement(parent) || isForOfStatement(parent)) return parent.initializer === at;
    if (isDeleteExpression(parent)) return true;
    if (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent))
      return (
        parent.operator === SyntaxKind.PlusPlusToken ||
        parent.operator === SyntaxKind.MinusMinusToken
      );
    const inside =
      isObjectLiteralExpression(parent) ||
      isArrayLiteralExpression(parent) ||
      isPropertyAssignment(parent) ||
      isShorthandPropertyAssignment(parent) ||
      isSpreadElement(parent) ||
      isSpreadAssignment(parent) ||
      isParenthesizedExpression(parent);
    if (!inside) return false;
    at = parent;
  }
}

/** Where a mention goes that is no member read: an argument of a call, in a literal or not. */
function flowUse(at: Node, subject: Subject): Use {
  const flowing = containing(at);
  const user = flowing.top.parent;
  if (isCallExpression(user) || isNewExpression(user)) return argumentUse(user, flowing, subject);
  return container(user, flowing);
}

/**
 * A literal that holds the mention: discarded where a statement is all it is, kept by the constant it
 * is the initializer of, which holds the mention in turn.
 */
function container(user: Node, flowing: Flowing): Use {
  if (!flowing.inLiteral) return UNKNOWN;
  if (isExpressionStatement(user)) return KNOWN;
  if (!isVariableDeclaration(user) || !isIdentifier(user.name)) return UNKNOWN;
  const initializer: Node | undefined = user.initializer;
  if (initializer !== flowing.top) return UNKNOWN;
  return flowing.direct
    ? { known: true, alias: user, contained: true }
    : { known: true, alias: user };
}

/**
 * Where a node goes: the outermost literal it is written in, through fields, entries and spreads, and
 * whether that literal holds the node itself, not only what a spread copies out of it.
 */
interface Flowing {
  readonly top: Node;
  readonly inLiteral: boolean;
  readonly direct: boolean;
}

/** The outermost literal a node is written in, through fields, entries and spreads. */
function containing(node: Node): Flowing {
  let top: Node = node;
  let literals = 0;
  const copied = isSpreadElement(node.parent) || isSpreadAssignment(node.parent);
  for (;;) {
    const { parent } = top;
    const within =
      (isPropertyAssignment(parent) && parent.initializer === top) ||
      isShorthandPropertyAssignment(parent) ||
      isSpreadElement(parent) ||
      isSpreadAssignment(parent) ||
      isParenthesizedExpression(parent);
    const literal = isObjectLiteralExpression(parent) || isArrayLiteralExpression(parent);
    if (!within && !literal)
      return { top: outermost(top), inLiteral: literals > 0, direct: !copied || literals > 1 };
    if (literal) literals += 1;
    top = parent;
  }
}

/** Whether a call is a native mutator of a written array: its target names one. */
function onArray(call: Node): boolean {
  if (!isCallExpression(call)) return false;
  const target = mutatorInvocation(call)?.args[0];
  return target !== undefined && arrayIdentity(target) !== undefined;
}

/**
 * A borrowed method called on the array: the array is the receiver the readers of mutations follow, and a
 * method that calls back hands it to a function unless the callback is written out and takes no
 * parameter for it. The arguments of `apply` are a list, which may hold any callback.
 */
function borrowedUse(call: CallExpression, borrowed: Borrowed, subject: Subject): Use {
  const { name, apply } = borrowed;
  if (subject !== 'array') return UNKNOWN;
  if (apply ? callsBack(name) : handsArray(call, name, 1)) return UNKNOWN;
  return SELF_RETURNING.has(name) ? answerUse(call) : KNOWN;
}

/**
 * A mention in the arguments of a call. A native mutator of a written array follows its target, its
 * sources, its descriptors and its maps; a mutator of any other object copies or writes, which the
 * compile does not follow for a held object. Another call may do anything with it, but for a native
 * that reads.
 */
function argumentUse(call: Node, flowing: Flowing, subject: Subject): Use {
  if (!isCallExpression(call)) return UNKNOWN;
  const borrowed = borrowedMethod(call);
  if (borrowed !== undefined && !flowing.inLiteral && outermost(borrowed.receiver) === flowing.top)
    return borrowedUse(call, borrowed, subject);
  const invoked = mutatorInvocation(call);
  if (invoked === undefined)
    return !flowing.inLiteral && readerArgument(flowing.top) ? KNOWN : UNKNOWN;
  const position = invoked.args.findIndex((each) => outermost(each) === flowing.top);
  if (position === -1) return UNKNOWN;
  if (position === 0) return subject === 'array' && !flowing.inLiteral ? answerUse(call) : UNKNOWN;
  return subject === 'array' || followedArgument(invoked, position) ? KNOWN : UNKNOWN;
}

/** Whether a mutator of a written array reads the argument at the place for its fields, and coerces it to nothing. */
function followedArgument(invoked: MutatorInvocation, position: number): boolean {
  const target = invoked.args[0];
  const toArray = target !== undefined && arrayIdentity(target) !== undefined;
  return toArray && !coercesArgument(invoked.path, position);
}

/**
 * What the reader of a form takes it for: a source whose fields are values, a descriptor, a map of
 * descriptors, or a pattern's source, every field of which the compile reads (a member of another
 * object, a call or a method there is no value it follows).
 */
export type Role = 'descriptor' | 'map' | 'pattern' | 'source';

/** An argument a form stands for, read in a role. */
interface Consulted {
  readonly node: Expression;
  readonly role: Role;
}

/** What a consultation has met: the constants it followed, and who is told of those that hold objects. */
interface Context {
  readonly seen: Set<Node>;
  readonly held?: ((declaration: VariableDeclaration) => void) | undefined;
}

/**
 * Whether an argument of a native mutator of an array is written in a form the compile follows: an
 * object or list literal, whose spreads are followed and whose entries are descriptors where it is a
 * map; a constant that holds such a form and has only known mentions; a choice between them. The
 * values a field holds are read as values. A member of another object, a call, a destructured
 * name or a variable written as a whole may hold anything, and no reader follows it.
 */
export function consultedKnown(
  expression: Expression,
  role: Role,
  held?: (declaration: VariableDeclaration) => void,
): boolean {
  const pending: Consulted[] = [{ node: expression, role }];
  const context: Context = { seen: new Set(), held };
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const next = consult(unwrapped(at.node), at.role, context);
    if (next === undefined) return false;
    pending.push(...next);
  }
  return true;
}

/** The arguments an argument stands for in turn, none where it is a form the compile does not follow. */
function consult(
  value: Expression,
  role: Role,
  context: Context,
): readonly Consulted[] | undefined {
  if (isObjectLiteralExpression(value)) return objectOf(value, role);
  if (isArrayLiteralExpression(value))
    return value.elements.flatMap((each) => entryOf(each, role === 'map' ? 'descriptor' : role));
  if (isConditionalExpression(value))
    return [
      { node: value.whenTrue, role },
      { node: value.whenFalse, role },
    ];
  if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.CommaToken)
    return [{ node: value.right, role }];
  if (isBinaryExpression(value) && LOGICAL.has(value.operatorToken.kind))
    return [
      { node: value.left, role },
      { node: value.right, role },
    ];
  if (isIdentifier(value)) return named(value, role, context);
  return atom(value) ? [] : undefined;
}

/** A value that is no object: `null`, a literal, a function, a class. */
function atom(value: Expression): boolean {
  return (
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    isNumericLiteral(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value)
  );
}

/** What a literal object stands for: none for a method of a pattern's source, which no reader follows. */
function objectOf(value: ObjectLiteralExpression, role: Role): readonly Consulted[] | undefined {
  if (role === 'pattern' && value.properties.some((each) => isMethodDeclaration(each)))
    return undefined;
  const inner: Role = role === 'map' ? 'descriptor' : role;
  return value.properties.flatMap((each): Consulted[] => {
    if (isSpreadAssignment(each)) return [{ node: each.expression, role }];
    if (role !== 'map' && role !== 'pattern') return [];
    if (isPropertyAssignment(each)) return [{ node: each.initializer, role: inner }];
    return isShorthandPropertyAssignment(each) && isIdentifier(each.name)
      ? [{ node: each.name, role: inner }]
      : [];
  });
}

/** The argument an element of a list stands for: a spread is a list in the role, an entry a descriptor of a map. */
function entryOf(element: Expression, role: Role): readonly Consulted[] {
  if (isOmittedExpression(element)) return [];
  if (isSpreadElement(element)) return [{ node: element.expression, role }];
  return role === 'descriptor' || role === 'pattern' ? [{ node: element, role }] : [];
}

/** The initializer a name stands for, once, where it is a constant followed and read as known. */
function named(name: Identifier, role: Role, context: Context): readonly Consulted[] | undefined {
  if (!readsBinding(name)) return name.text === 'undefined' ? [] : undefined;
  const selected = frameBindingOf(name);
  if (selected === undefined) return [];
  if (selected.keys.length > 0) return undefined;
  const declaration = selected.binding;
  if (!isVariableDeclaration(declaration) || context.seen.has(declaration)) return [];
  context.seen.add(declaration);
  const { initializer } = declaration;
  if (initializer === undefined || atom(unwrapped(initializer))) return [];
  if (!knownUsesOnly(declaration, 'held')) return undefined;
  context.held?.(declaration);
  return [{ node: initializer, role }];
}
