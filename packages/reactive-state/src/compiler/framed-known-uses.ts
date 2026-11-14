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
  isForStatement,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateSpan,
  isVariableDeclaration,
  type Node,
  type PropertyAccessExpression,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import {
  ARRAY_METHODS,
  borrowedMethod,
  ELEMENT_RETURNING,
  DESCRIPTOR_FIELDS,
  callsBack,
  copiesElements,
  handsArray,
  isFirstArgument,
  LIST_FIELDS,
  NO_FIELDS,
  READERS,
  readsWithoutCallback,
  type Borrowed,
} from './framed-array-callbacks.ts';
import { arrayIdentity } from './framed-array-identity.ts';
import { invokedAtOnce } from './framed-array-mutations.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { iterates } from './framed-iterated-uses.ts';
import {
  coercesArgument,
  mutatorInvocation,
  nativePath,
  type MutatorInvocation,
} from './framed-mutator-calls.ts';
import { tested } from './framed-tested-uses.ts';
import { namesThis } from './framed-this-functions.ts';

/**
 * The uses of an array, a descriptor, a map or a list that the compile follows, and nothing else.
 *
 * The compile reads what a native object mutator installs from the objects it is handed, and takes
 * each of them as the source wrote it. An object is followed only where every mention of it, and of
 * each name that stands for it, is a use this module knows: a declaration, a constant that names it,
 * a member read that no call or write follows, a spread or a destructuring of it, a test, an
 * argument of a native mutator it knows, a call of a native method of an array that hands the array
 * to no function of the program, a write to one of its own members that the readers of writes
 * collect. Any other mention may write it in a way no reader follows (an unknown callee, a literal
 * that holds it, a return, a destructured alias, a callback that is given it, a choice between it
 * and another value, a write through a member of a member), and the compile refuses what it cannot
 * show safe. A program that uses these forms is refused too. The names that stand for an object are
 * walked by `framed-known-mentions`, the arguments of a native mutator are judged by
 * `framed-known-forms`.
 *
 * Not covered: `eval` and `Function`, a `Proxy` whose trap runs application code, a `with` scope,
 * code of other files, and `Array.prototype` or `Object.prototype` written by the program. A function
 * that names `this` is refused where it is written out as a method, an accessor or a value stored on
 * the array (it runs with the array as `this`); one the program reaches by a name (a declared
 * function, a constant) is not followed. What a getter or a setter of a written literal runs is
 * read by the readers of that literal.
 */

/**
 * What is followed: an array whose methods and elements are read, a held object that feeds one, or a
 * held list, whose entries a spread places by position and whose writes no reader of a spread collects.
 * An `echo` is a name that stands for an array without being the name the readers of writes follow (a
 * constant an answer of a mutator is kept in): what is written through it is not collected. A `carrier`
 * is an array that holds itself, so that a member of it may be the array. A `box` is a literal that holds
 * one of the objects followed, so that a member of it, or a name that takes one apart, is such an object.
 */
export type Subject = 'array' | 'box' | 'carrier' | 'echo' | 'held' | 'list';

/**
 * What a mention is: a use the compile knows or not, and the constant it names the same, if any. A
 * name that `contains` the mention holds it in a literal; one that is an `echo` holds the array itself,
 * and a use that `carries` stores the array in itself.
 */
export interface Use {
  readonly known: boolean;
  readonly alias?: VariableDeclaration;
  readonly contained?: boolean;
  readonly echo?: boolean;
  readonly carries?: boolean;
  /** A spread, a loop, a native or a callback takes the mention's elements: an array that holds itself hands itself on. */
  readonly spreads?: boolean;
}

const KNOWN: Use = { known: true };
const UNKNOWN: Use = { known: false };
const CARRIES: Use = { known: true, carries: true };
const SPREADS: Use = { known: true, spreads: true };

/** Whether the subject is an array, however it is named. */
export function isArray(subject: Subject): boolean {
  return subject === 'array' || subject === 'carrier' || subject === 'echo';
}

/** The operators that hand over one of their operands. */
export const LOGICAL: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** The methods of an array that change it in place: a name that is no name the readers follow may not call them. */
const MUTATING: ReadonlySet<string> = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

/**
 * The natives that give the elements of an array to a new object: a new list, or the descriptors of its
 * fields, whose `value` is the element itself.
 */
const COPIERS: ReadonlySet<string> = new Set([
  'Array.from',
  'Object.entries',
  'Object.getOwnPropertyDescriptor',
  'Object.getOwnPropertyDescriptors',
  'Object.values',
]);

/** The methods of an array that answer the array itself. */
const SELF_RETURNING: ReadonlySet<string> = new Set(['copyWithin', 'fill', 'reverse', 'sort']);

/** The subjects whose writes to their own members the readers of writes collect. */
const FOLLOWED: ReadonlySet<Subject> = new Set(['array', 'carrier', 'held']);

/** The nodes that a `return` leaves: a function, a method, an accessor, a constructor, a static block. */
const FUNCTIONS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrowFunction,
  SyntaxKind.ClassStaticBlockDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.GetAccessor,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.SetAccessor,
]);

/** The node that stands for the same value as `node`, through parentheses and assertions. */
export function outermost(node: Node): Node {
  let at = node;
  while (isExpression(at.parent) && unwrapped(at.parent) === node) at = at.parent;
  return at;
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
  if (runsIterator(at, subject, handed)) return UNKNOWN;
  if (isVariableDeclaration(parent)) return handed ? UNKNOWN : aliased(parent, at, subject);
  if (isSpreadAssignment(parent)) return SPREADS;
  if (discarded(at)) return KNOWN;
  const read = isArray(subject) ? arrayRead(at) : undefined;
  if (read !== undefined) return read;
  const given = assigned(at, subject);
  if (given !== undefined) return given;
  const member = isPropertyAccessExpression(parent) || isElementAccessExpression(parent);
  if (member && parent.expression === at)
    return memberUse(parent, handed ? handedKind(subject) : subject);
  return flowUse(at, subject);
}

/** What an array does where it is spread, iterated or converted: it is copied out, or it is read; none for another use. */
function arrayRead(at: Node): Use | undefined {
  if (copiesOut(at)) return SPREADS;
  return readsArray(at) ? KNOWN : undefined;
}

/** Whether a held object, or a literal that holds one or may, is iterated at the mention: application code runs. */
function runsIterator(at: Node, subject: Subject, handed: boolean): boolean {
  return (handed || subject === 'held' || subject === 'box') && iterates(at);
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
  return takenApart(subject) ? KNOWN : UNKNOWN;
}

/** A mention on either side of an assignment: the source a pattern takes apart, or the name given a value. */
function assigned(at: Node, subject: Subject): Use | undefined {
  const { parent } = at;
  if (!isBinaryExpression(parent)) return undefined;
  const pattern = parent.right === at && parent.operatorToken.kind === SyntaxKind.EqualsToken;
  if (pattern && isPattern(parent.left)) return takenApart(subject) ? KNOWN : UNKNOWN;
  return overwritten(at) ? KNOWN : undefined;
}

/** Whether a mention is only dropped or compared: a statement, a comma, a loop head, a test. */
function discarded(at: Node): boolean {
  const { parent } = at;
  if (isForStatement(parent)) {
    const heads: readonly (Node | undefined)[] = [parent.initializer, parent.incrementor];
    return heads.includes(at);
  }
  const comma = isBinaryExpression(parent) && parent.operatorToken.kind === SyntaxKind.CommaToken;
  return (comma && parent.left === at) || isExpressionStatement(parent) || tested(at);
}

/** Whether a name is the left of a plain assignment: it is given a value, and nothing reads it. */
function overwritten(at: Node): boolean {
  const { parent } = at;
  return (
    isBinaryExpression(parent) &&
    parent.left === at &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken
  );
}

/** Whether the left of an assignment takes a value apart: a pattern, not a name or a member. */
function isPattern(left: Node): boolean {
  const target = isExpression(left) ? unwrapped(left) : left;
  return isObjectLiteralExpression(target) || isArrayLiteralExpression(target);
}

/**
 * Whether a pattern takes no more from a mention than it is followed in: the elements of an array, or
 * the values a held object or list holds, which the reader of the pattern's source reads in turn. A
 * literal that holds a followed object and an array that holds itself have members that are objects,
 * and a name that is given one is no name the readers follow.
 */
function takenApart(subject: Subject): boolean {
  return subject !== 'box' && subject !== 'carrier';
}

/**
 * Whether a mention of an array is read: converted to text by a template, an operator or a native
 * that does with it as its first argument (a later one is coerced, and runs the methods of what it is), spread into a list, or iterated by a loop. The array's own methods run through the
 * conversion, and what a read gives is followed by the readers.
 */
function readsArray(at: Node): boolean {
  const { parent } = at;
  if (isTemplateSpan(parent)) return !isTaggedTemplateExpression(parent.parent.parent);
  if (isBinaryExpression(parent) && parent.operatorToken.kind === SyntaxKind.PlusToken) return true;
  if (!isFirstArgument(parent, at)) return false;
  const path = nativePath(parent.expression);
  return path !== undefined && readsWithoutCallback(parent, path);
}

/**
 * Whether a mention of an array is copied out of: spread into a list or a call, iterated by a loop, or
 * given to a native that gathers what it holds. The elements an array holds go where the copy goes, and
 * an array that holds itself hands itself on.
 */
function copiesOut(at: Node): boolean {
  const { parent } = at;
  if (isSpreadElement(parent) || (isForOfStatement(parent) && parent.expression === at))
    return true;
  if (!isFirstArgument(parent, at)) return false;
  const path = nativePath(parent.expression);
  return path !== undefined && COPIERS.has(path);
}

/** What a name stands for where it is one of the values a choice may hand over: not the one readers follow. */
function handedKind(subject: Subject): Subject {
  return isArray(subject) ? 'echo' : 'box';
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
    if (!deeper) return memberResult(access, result, { subject, depth, base: memberName(first) });
    access = user;
  }
}

/** A chain of members: whose they are, how many, and the name of the first. */
interface Chain {
  readonly subject: Subject;
  readonly depth: number;
  readonly base: string | undefined;
}

/** What a member read, called or written at the end of a chain of members is used for. */
function memberResult(access: Node, result: Node, { subject, depth, base }: Chain): Use {
  const { parent: user } = result;
  if (isTaggedTemplateExpression(user)) return UNKNOWN;
  if ((isCallExpression(user) || isNewExpression(user)) && user.expression === result)
    return methodCall(access, user, { subject, depth, base });
  if (written(result))
    return depth === 1 && FOLLOWED.has(subject) && !keepsThis(result) ? KNOWN : UNKNOWN;
  return subject === 'array' ? KNOWN : resultUse(result, memberName(access), { depth, subject });
}

/** Whether a member is given a function that names `this`, which runs with the array as `this`. */
function keepsThis(result: Node): boolean {
  const { parent } = result;
  if (!isBinaryExpression(parent) || parent.left !== result) return false;
  const value = unwrapped(parent.right);
  return isFunctionExpression(value) && namesThis(value);
}

/**
 * A method called on a mention: a native method of an array, whose answer goes where it is known and
 * which hands the array to no function of the program. A method of a member of the mention is a method
 * of something else.
 */
function methodCall(access: Node, call: Node, { subject, depth, base }: Chain): Use {
  if (depth > 1)
    return isArray(subject) && (subject === 'array' || base === 'length') ? KNOWN : UNKNOWN;
  if (!isArray(subject)) return UNKNOWN;
  const name = memberName(access);
  if (name === undefined || !ARRAY_METHODS.has(name)) return UNKNOWN;
  if (isCallExpression(call) && handsArray(call, name)) return UNKNOWN;
  if (subject === 'echo' && MUTATING.has(name)) return UNKNOWN;
  if (ELEMENT_RETURNING.has(name) && elementWritten(call)) return UNKNOWN;
  const answer = SELF_RETURNING.has(name) ? answerUse(call) : KNOWN;
  return handsElements(call, name) || copiesElements(name) ? { ...answer, spreads: true } : answer;
}

/**
 * Whether a method gives the elements of the array to a function: a callback, a comparator. An array
 * that holds itself in an element hands itself to the function through it, and answers itself in the
 * elements of an answer (`copiesElements`).
 */
function handsElements(call: Node, name: string): boolean {
  return isCallExpression(call) && call.arguments.length > 0 && callsBack(name);
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
  let handed = false;
  for (;;) {
    if (isSpreadAssignment(at.parent)) return SPREADS;
    if (discarded(at)) return KNOWN;
    if (!passed(at)) break;
    at = outermost(at.parent);
    handed = true;
  }
  if (copiesOut(at)) return SPREADS;
  if (readsArray(at)) return KNOWN;
  const { parent } = at;
  const member = isPropertyAccessExpression(parent) || isElementAccessExpression(parent);
  if (member && parent.expression === at) return memberUse(parent, 'echo');
  return handed ? UNKNOWN : (stored(at) ?? returned(at) ?? chained(at));
}

/** An answer that a constant is initialized with, or a name is assigned: that name stands for the array. */
function stored(at: Node): Use | undefined {
  const { parent } = at;
  if (isVariableDeclaration(parent)) {
    const initializer: Node | undefined = parent.initializer;
    return initializer === at && isIdentifier(parent.name)
      ? { known: true, alias: parent, echo: true }
      : UNKNOWN;
  }
  const assignment =
    isBinaryExpression(parent) &&
    parent.right === at &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken;
  if (!assignment) return undefined;
  const declaration = namedVariable(parent.left);
  const onward = answerUse(parent);
  const single = onward.known && onward.alias === undefined;
  return declaration !== undefined && single
    ? { known: true, alias: declaration, echo: true }
    : UNKNOWN;
}

/** The variable a plain name stands for, where the expression is one. */
function namedVariable(expression: Expression): VariableDeclaration | undefined {
  const name = unwrapped(expression);
  const selected = isIdentifier(name) ? frameBindingOf(name) : undefined;
  if (selected === undefined || selected.keys.length > 0) return undefined;
  return isVariableDeclaration(selected.binding) ? selected.binding : undefined;
}

/** An answer that a function called where it is written returns: the call answers it in turn. */
function returned(at: Node): Use | undefined {
  const { parent } = at;
  let fn: Node | undefined = isArrowFunction(parent) && parent.body === at ? parent : undefined;
  if (isReturnStatement(parent)) {
    fn = parent.parent;
    while (!isSourceFile(fn) && !FUNCTIONS.has(fn.kind)) fn = fn.parent;
  }
  if (fn === undefined || !(isArrowFunction(fn) || isFunctionExpression(fn))) return undefined;
  const call = useOf(fn).parent;
  return invokedAtOnce(fn) && isCallExpression(call) ? answerUse(call) : undefined;
}

/** An answer that is the target of a native mutator of a written array, or a field of what it is handed. */
function chained(at: Node): Use {
  const flowing = containing(at);
  const user = flowing.top.parent;
  if (flowing.inLiteral && discarded(flowing.top)) return KNOWN;
  if (!isCallExpression(user) || !onArray(user)) return UNKNOWN;
  if (flowing.inLiteral) return CARRIES;
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
  if (isSpreadAssignment(parent)) return SPREADS;
  if (discarded(result) || isTemplateSpan(parent)) return KNOWN;
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
  return subject === 'list' || isArray(subject) ? LIST_FIELDS : NO_FIELDS;
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

/** An array that is the target of a native mutator, whose answer goes where it is known. */
function targetUse(call: Node, flowing: Flowing, subject: Subject): Use {
  const followed = subject === 'array' || subject === 'carrier';
  return followed && !flowing.inLiteral ? answerUse(call) : UNKNOWN;
}

/**
 * A borrowed method called on the array: the array is the receiver the readers of mutations follow, and a
 * method that calls back hands it to a function unless the callback is written out and takes no
 * parameter for it. The arguments of `apply` are a list, which may hold any callback.
 */
function borrowedUse(call: CallExpression, borrowed: Borrowed, subject: Subject): Use {
  const { name, apply } = borrowed;
  if (!isArray(subject) || (subject === 'echo' && MUTATING.has(name))) return UNKNOWN;
  if (apply ? callsBack(name) : handsArray(call, name, 1)) return UNKNOWN;
  const answer = SELF_RETURNING.has(name) ? answerUse(call) : KNOWN;
  const hands = call.arguments.length > 1 && callsBack(name);
  return hands || copiesElements(name) ? { ...answer, spreads: true } : answer;
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
    return flowing.inLiteral || !readerArgument(flowing.top) ? UNKNOWN : KNOWN;
  const position = invoked.args.findIndex((each) => outermost(each) === flowing.top);
  if (position === -1) return UNKNOWN;
  if (position === 0) return targetUse(call, flowing, subject);
  if (isArray(subject)) return flowing.inLiteral ? UNKNOWN : KNOWN;
  return followedArgument(invoked, position) ? KNOWN : UNKNOWN;
}

/** Whether a mutator of a written array reads the argument at the place for its fields, and coerces it to nothing. */
function followedArgument(invoked: MutatorInvocation, position: number): boolean {
  const target = invoked.args[0];
  const toArray = target !== undefined && arrayIdentity(target) !== undefined;
  return toArray && !coercesArgument(invoked.path, position);
}
