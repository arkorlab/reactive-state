import {
  type BinaryExpression,
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  isAssertionExpression,
  isBinaryExpression,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExpressionWithTypeArguments,
  isIdentifier,
  isInterfaceDeclaration,
  isNewExpression,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isSourceFile,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isTypeOfExpression,
  type NoSubstitutionTemplateLiteral,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
  type StringLiteral,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { constantInitializer } from './framed-native-calls.ts';
import { isTypeOnly } from './framed-references.ts';
import { isWrittenMember } from './framed-written-members.ts';

const PROTOTYPE_CHANGES = new WeakMap<SourceFile, boolean>();

/**
 * Whether a file may give an array another prototype, or another inherited method, whose setter an
 * assignment then meets. The file is read for what it MAY do not for what it does: it may not, only
 * where every mention of what reaches a prototype is one of a short list of uses that reach none;
 * any other mention is taken for a change, and so is a name the code does not write.
 *
 * What reaches a prototype: the names `__proto__`, `setPrototypeOf`, `getPrototypeOf`, `prototype`,
 * `constructor`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__` and `__lookupSetter__`,
 * written as a member, a key or a text, of whatever object (a helper, a parameter or an import is no
 * different from a holder); and the globals `Object`, `Reflect`, `Array` and `Function`, and the global
 * objects that hold them (`globalThis`, `global`, `self`, `window`).
 *
 * The uses that reach none:
 * - a name read by a type;
 * - `Array.from`, `Array.isArray`, `Array.of`, `new Array(…)`, `Array(…)`, `x instanceof Array`,
 *   `class … extends Array`, and the same of `Object` (`new Object()`, `instanceof`, `extends`);
 * - a call of a member of `Object` or `Reflect` that the language names and that gives no other
 *   prototype, written by its name: `Object.keys`, `values`, `entries`, `fromEntries`, `freeze`,
 *   `isFrozen`, `getOwnPropertyNames`, `is`, `Reflect.has`, `ownKeys`; and, since they write an
 *   object that is not a prototype or hand a prototype back to be read, `Object.assign`,
 *   `defineProperty`, `defineProperties`, `Reflect.apply`, `defineProperty`, `set`, called or held
 *   as a function, and `getPrototypeOf` called, its answer compared or its member read;
 * - a member of the prototype of the arrays, the objects or the functions that is read by its name
 *   (`Array.prototype.join`), whose own members are not written, deleted or given away;
 * - a comparison of a holder or of a constructor: `x.constructor === Array`.
 *
 * A name written as text that the code joins (`'__pro' + 'to__'`, a template whose substitutions are
 * texts, a constant of such) is read as the name it makes. A name made at run time (a call, a variable
 * the code assigns, a parameter) is not read: the file does not write it.
 */
export function prototypeMayChange(file: SourceFile): boolean {
  const known = PROTOTYPE_CHANGES.get(file);
  if (known !== undefined) return known;
  let found = false;
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined && !found; node = pending.pop()) {
    found = !isSourceFile(node) && escapes(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  PROTOTYPE_CHANGES.set(file, found);
  return found;
}

/**
 * The names that reach a prototype, or give another to an object, as a member name, a key or a text, of
 * whatever object they are written for: a helper, a parameter, an import and a holder alike.
 */
const REACHING: ReadonlySet<string> = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'getPrototypeOf',
  'prototype',
  'setPrototypeOf',
]);

/** The globals that reach a prototype, and the global objects that hold them. */
const HOLDERS: ReadonlySet<string> = new Set([
  'Array',
  'Function',
  'global',
  'globalThis',
  'Object',
  'Reflect',
  'self',
  'window',
]);

/** The global objects: a member of one is another global. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['global', 'globalThis', 'self', 'window']);

/** The members of a holder that are called by their name and reach no prototype to give another. */
const CALLED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['Array', new Set(['from', 'isArray', 'of'])],
  [
    'Object',
    new Set([
      'entries',
      'freeze',
      'fromEntries',
      'getOwnPropertyNames',
      'is',
      'isFrozen',
      'keys',
      'values',
    ]),
  ],
  ['Reflect', new Set(['has', 'ownKeys'])],
]);

/**
 * The members that write an object, called or held as a function: no prototype is reached but by
 * a mention of it, which is a use of its own.
 */
const WRITING: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['Object', new Set(['assign', 'defineProperties', 'defineProperty'])],
  ['Reflect', new Set(['apply', 'defineProperty', 'set'])],
]);

/** The members that hand back the prototype an object has: read, its answer is not given away. */
const HANDING_BACK = 'getPrototypeOf';

/** The methods of a function that call it or bind it, which a function held as a value may be given. */
const OF_FUNCTIONS: ReadonlySet<string> = new Set(['apply', 'bind', 'call']);

/** The operators that compare what they are given and do nothing with it. */
const COMPARISONS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/** Whether a node, where it is read, may reach a prototype in a way the list of uses does not name. */
function escapes(node: Node): boolean {
  if (isBinaryExpression(node) || isTemplateExpression(node))
    return !inType(node) && foldsToName(node);
  if (!isIdentifier(node) && !isStringLiteral(node) && !isNoSubstitutionTemplateLiteral(node))
    return false;
  if (REACHING.has(node.text)) return !inType(node) && nameEscapes(node);
  return isIdentifier(node) && !inType(node) && escapesAsHolder(node);
}

/** The longest name that reaches a prototype: a text longer than it is none, whatever is joined to it. */
const LONGEST_NAME = Math.max(...Array.from(REACHING, (name) => name.length));

/** How many parts one folding reads (a text, a template, a constant, an operand) before it gives up. */
const FOLD_STEPS = 256;

/** What one folding has left to read. */
interface FoldBudget {
  steps: number;
  /** The constants being folded: one that names itself, by whatever way, is no text. */
  readonly following: Set<Node>;
}

/**
 * Whether an expression is a name that reaches a prototype, written as text alone: a `+` of texts, a
 * template whose substitutions are texts, a constant of such (`'__pro' + 'to__'`). Any such name is a
 * mention, whatever it is used for; a name that a call or a variable the code assigns makes is not read.
 * The folding stops where the text is longer than any such name, and reads a bounded number of parts;
 * an expression that takes more is taken for a name, as the code that is not read.
 */
function foldsToName(expression: Expression): boolean {
  const budget: FoldBudget = { steps: FOLD_STEPS, following: new Set() };
  const text = foldedText(expression, budget);
  return budget.steps < 0 || (text !== undefined && REACHING.has(text));
}

/**
 * The text an expression is written as of text alone, none where any part is known only when the
 * code runs, or the text is longer than any name (which no part joined to it shortens).
 */
function foldedText(expression: Expression, budget: FoldBudget): string | undefined {
  budget.steps -= 1;
  if (budget.steps < 0) return undefined;
  const value = stripped(expression);
  if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value))
    return joinedText([value.text], budget);
  if (isTemplateExpression(value))
    return joinedText(
      [
        value.head.text,
        ...value.templateSpans.flatMap((span) => [span.expression, span.literal.text]),
      ],
      budget,
    );
  if (isIdentifier(value)) {
    const initializer = constantInitializer(value);
    if (initializer === undefined || budget.following.has(initializer)) return undefined;
    budget.following.add(initializer);
    const text = foldedText(initializer, budget);
    budget.following.delete(initializer);
    return text;
  }
  return isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.PlusToken
    ? joinedText(plusOperands(value, budget), budget)
    : undefined;
}

/** The expression past the parentheses, the casts of any kind, `!` and `satisfies` around it. */
function stripped(expression: Expression): Expression {
  let value = unwrapped(expression);
  while (isTypeAssertion(value)) value = unwrapped(value.expression);
  return value;
}

/** The operands a chain of `+` joins, in order; the chain is read by a loop, not by recursion. */
function plusOperands(chain: BinaryExpression, budget: FoldBudget): readonly Expression[] {
  const operands: Expression[] = [];
  let at: Expression = chain;
  while (isBinaryExpression(at) && at.operatorToken.kind === SyntaxKind.PlusToken) {
    budget.steps -= 1;
    if (budget.steps < 0) break;
    operands.push(at.right);
    at = stripped(at.left);
  }
  operands.push(at);
  return operands.toReversed();
}

/** The parts joined in order, none where one is not a text or the text outgrows every name. */
function joinedText(
  parts: readonly (Expression | string)[],
  budget: FoldBudget,
): string | undefined {
  let text = '';
  for (const part of parts) {
    const piece = typeof part === 'string' ? part : foldedText(part, budget);
    if (piece === undefined) return undefined;
    text += piece;
    if (text.length > LONGEST_NAME) return undefined;
  }
  return text;
}

/**
 * Whether a name that reaches a prototype is used otherwise than the list says: as a member of a
 * holder that is read as the list says (`Object.getPrototypeOf(x)` compared or read, `Array.prototype.join`,
 * `x.constructor === Array`), or not at all as a member: a key of a literal or a pattern, a bare name, a
 * text, whoever it is written for.
 */
function nameEscapes(name: Identifier | StringLiteral | NoSubstitutionTemplateLiteral): boolean {
  const access = accessOf(name);
  if (access === undefined) return true;
  if (name.text === 'getPrototypeOf') return !isNativeHandingBack(access);
  if (name.text === 'prototype') return prototypeUsedOtherwise(access);
  if (name.text === 'constructor') return !onlyCompared(access);
  return true;
}

/** The member access a name is the member of, by a name or a text key; none for any other place. */
function accessOf(name: Node): PropertyAccessExpression | ElementAccessExpression | undefined {
  const { parent } = name;
  if (isPropertyAccessExpression(parent) && parent.name === name) return parent;
  const site = outermost(name);
  const holder = site.parent;
  return isElementAccessExpression(holder) && holder.argumentExpression === site
    ? holder
    : undefined;
}

/** Whether a member is the `getPrototypeOf` of the global `Object` or `Reflect`, whose use the holder decides. */
function isNativeHandingBack(access: PropertyAccessExpression | ElementAccessExpression): boolean {
  const path = globalPathOf(access)?.join('.');
  return path === 'Object.getPrototypeOf' || path === 'Reflect.getPrototypeOf';
}

/**
 * Whether a name is written in a type: `Array<string>`, `typeof Object`, an interface, an alias, a
 * member of a type literal. A type names no value and reaches no prototype.
 */
function inType(node: Node): boolean {
  for (let at = node.parent; !isSourceFile(at); at = at.parent)
    if (isTypeOnly(at) || isInterfaceDeclaration(at) || isTypeAliasDeclaration(at)) return true;
  return false;
}

/** Whether a node is a member read by a name or a key. */
function isMemberAccess(node: Node): node is PropertyAccessExpression | ElementAccessExpression {
  return isPropertyAccessExpression(node) || isElementAccessExpression(node);
}

/** The name a member is read by where it is written out, none for one the code computes. */
function writtenMember(
  node: PropertyAccessExpression | ElementAccessExpression,
): string | undefined {
  if (isPropertyAccessExpression(node)) return node.name.text;
  const key = unwrapped(node.argumentExpression);
  return isStringLiteral(key) || isNoSubstitutionTemplateLiteral(key) ? key.text : undefined;
}

/** Whether an expression gives the value of an operand as its own: parentheses, a cast, a comma's last. */
function passes(parent: Node, at: Node): boolean {
  if (isBinaryExpression(parent))
    return parent.operatorToken.kind === SyntaxKind.CommaToken && parent.right === at;
  return (
    isParenthesizedExpression(parent) ||
    isAssertionExpression(parent) ||
    isNonNullExpression(parent) ||
    isSatisfiesExpression(parent)
  );
}

/** The node that stands for the same value as `node`, through what gives it on. */
function outermost(node: Node): Node {
  let at = node;
  while (passes(at.parent, at)) at = at.parent;
  return at;
}

/**
 * Whether a node is the right of an `instanceof`, an operand of `typeof` or of a comparison. The left
 * of an `instanceof` is not: it is handed to the `Symbol.hasInstance` hook of the right.
 */
function onlyTested(site: Node): boolean {
  const { parent } = site;
  if (isTypeOfExpression(parent)) return true;
  if (!isBinaryExpression(parent)) return false;
  if (parent.operatorToken.kind === SyntaxKind.InstanceOfKeyword) return parent.right === site;
  return COMPARISONS.has(parent.operatorToken.kind);
}

/**
 * Whether a mention of a holder (`Object`, or `globalThis.Object`, `window.Array`) reaches a prototype
 * where the list of uses does not name how: a global object is a holder only through a member that
 * is one, and a holder is used only as the list says.
 */
function escapesAsHolder(name: Node): boolean {
  if (!isIdentifier(name)) return false;
  const path = globalPathOf(name);
  const root = path?.[0];
  if (root === undefined || !HOLDERS.has(root)) return false;
  let holder: Node = name;
  let held = root;
  while (GLOBAL_OBJECTS.has(held)) {
    const site = outermost(holder);
    const { parent } = site;
    if (isTypeOfExpression(parent)) return false;
    if (!isMemberAccess(parent) || parent.expression !== site) return true;
    const next = writtenMember(parent);
    if (next === undefined || !HOLDERS.has(next)) return true;
    holder = parent;
    held = next;
  }
  return !holderUsed(outermost(holder), held);
}

/** Whether a holder, at the node that stands for it, is used as the list of uses says. */
function holderUsed(site: Node, held: string): boolean {
  const { parent } = site;
  if (onlyTested(site)) return true;
  if (isExpressionWithTypeArguments(parent)) return held === 'Array' || held === 'Object';
  if ((isNewExpression(parent) || isCallExpression(parent)) && parent.expression === site)
    return held === 'Array' || held === 'Object';
  if (!isMemberAccess(parent) || parent.expression !== site) return false;
  const member = writtenMember(parent);
  if (member === undefined) return false;
  if (member === 'prototype') return true;
  return memberUsed(parent, held, member);
}

/**
 * Whether a member of a holder, read by its name, is one of the uses that reach no prototype. A member
 * the code writes, deletes or steps (assigned, a pattern's place, a loop head) is none: the native it
 * names is another from there on, and every call of it after that is a call of what the code made.
 */
function memberUsed(
  access: PropertyAccessExpression | ElementAccessExpression,
  held: string,
  member: string,
): boolean {
  if (changed(access)) return false;
  const site = outermost(access);
  const { parent } = site;
  const called = isCallExpression(parent) && parent.expression === site;
  if (CALLED.get(held)?.has(member) === true) return called;
  if (member === HANDING_BACK && (held === 'Object' || held === 'Reflect'))
    return called && !usedOtherwiseThanRead(parent);
  if (WRITING.get(held)?.has(member) !== true) return false;
  return called || !isMemberAccess(parent) || OF_FUNCTIONS.has(writtenMember(parent) ?? '');
}

/** Whether the `prototype` of a function is given away, written, or reached through a `constructor`. */
function prototypeUsedOtherwise(
  access: PropertyAccessExpression | ElementAccessExpression,
): boolean {
  const object = unwrapped(access.expression);
  const viaConstructor = isMemberAccess(object) && writtenMember(object) === 'constructor';
  return viaConstructor || usedOtherwiseThanRead(access);
}

/** Whether a `constructor` is only compared, or its `name` read. */
function onlyCompared(access: Node): boolean {
  const site = outermost(access);
  if (onlyTested(site)) return true;
  const { parent } = site;
  return isMemberAccess(parent) && parent.expression === site && writtenMember(parent) === 'name';
}

/** Whether a member write, a deletion or a step changes the member the access names. */
function changed(member: Node): boolean {
  const { parent } = outermost(member);
  return (
    isWrittenMember(member) ||
    isDeleteExpression(parent) ||
    isPrefixUnaryExpression(parent) ||
    isPostfixUnaryExpression(parent)
  );
}

/**
 * Whether a prototype, or what hands one back, is given away, or has a member written, not read: a
 * member read is read by the name the code writes (`.join`, `['join']`), for a key the code computes
 * (`[key]`, `[0]`, `['jo' + 'in']`) may be a name that reaches another prototype or a method that sets
 * one; and a member is read, not called with the prototype as its `this` (`Array.prototype.valueOf()`
 * answers the prototype itself, `Array.prototype.push(fn)` writes it): through `call`, `apply` and
 * `bind` it is called on what the code gives, which is a use of its own.
 */
function usedOtherwiseThanRead(node: Node): boolean {
  const site = outermost(node);
  const { parent } = site;
  if (isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) return false;
  if (!isMemberAccess(parent) || parent.expression !== site) return true;
  return writtenMember(parent) === undefined || changed(parent) || calledWithItAsThis(parent);
}

/** Whether a member access is called, as a method of what it reads from: the object is the `this`. */
function calledWithItAsThis(access: Node): boolean {
  const site = outermost(access);
  const { parent } = site;
  if (isTaggedTemplateExpression(parent)) return parent.tag === site;
  return (isCallExpression(parent) || isNewExpression(parent)) && parent.expression === site;
}
