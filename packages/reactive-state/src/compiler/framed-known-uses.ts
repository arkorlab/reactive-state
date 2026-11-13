import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isArrowFunction,
  isCallExpression,
  isConditionalExpression,
  isDeleteExpression,
  isDoStatement,
  isElementAccessExpression,
  isExpression,
  isExpressionStatement,
  isForInStatement,
  isForOfStatement,
  isFunctionExpression,
  isIdentifier,
  isIfStatement,
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
  isTypeNode,
  isTypeOfExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVoidExpression,
  isWhileStatement,
  type Node,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { arrayIdentity } from './framed-array-identity.ts';
import { invokedAtOnce } from './framed-array-mutations.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { mutatorInvocation, nativePath } from './framed-mutator-calls.ts';
import { readsBinding } from './scope.ts';

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
 * that holds it, a return, a destructured alias, a callback that is given it, a write through a
 * member of a member), and the compile refuses what it cannot show safe. A program that uses these
 * forms is refused too. The arguments of a native mutator are judged by `framed-known-forms`.
 *
 * Not covered: `eval` and `Function`, a `Proxy` whose trap runs application code, a `with` scope,
 * and code of other files. What a getter or a setter of a written literal runs is read by the
 * readers of that literal.
 */

/**
 * What is followed: an array whose methods and elements are read, a held object that feeds one, or a
 * held list, whose entries a spread places by position and whose writes no reader of a spread collects.
 */
export type Subject = 'array' | 'held' | 'list';

/** What a mention is: a use the compile knows or not, and the constant it names the same, if any. */
export interface Use {
  readonly known: boolean;
  readonly alias?: VariableDeclaration;
}

const KNOWN: Use = { known: true };
const UNKNOWN: Use = { known: false };

/** The fields whose values are functions and data, no object the compile follows: a descriptor's, a list's length. */
const DESCRIPTOR_FIELDS: ReadonlySet<string> = new Set([
  'configurable',
  'enumerable',
  'get',
  'length',
  'set',
  'value',
  'writable',
]);

/** The natives that read their arguments and run no application code on them. */
const READERS: ReadonlySet<string> = new Set([
  'Array.isArray',
  'Number.isFinite',
  'Number.isInteger',
  'Number.isNaN',
  'Object.getOwnPropertyDescriptor',
  'Object.getOwnPropertyDescriptors',
  'Object.getOwnPropertyNames',
  'Object.isExtensible',
  'Object.isFrozen',
  'Object.isSealed',
  'Object.keys',
]);

/** The natives that convert an array to text or copy its elements, running its own methods. */
const CONVERTERS: ReadonlySet<string> = new Set([
  'Array.from',
  'Boolean',
  'JSON.stringify',
  'Number',
  'Object.entries',
  'Object.values',
  'String',
]);

/** The operators that hand over one of their operands. */
export const LOGICAL: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/** The methods of an array that the language gives it: those a call of which runs no code of the program. */
const ARRAY_METHODS: ReadonlySet<string> = new Set(
  Object.getOwnPropertyNames(Array.prototype).filter((name) => {
    return (
      name !== 'constructor' &&
      typeof (Array.prototype as unknown as Record<string, unknown>)[name] === 'function'
    );
  }),
);

/** The methods of an array that answer the array itself. */
const SELF_RETURNING: ReadonlySet<string> = new Set(['copyWithin', 'fill', 'reverse', 'sort']);

/** The place of the array among the parameters of a reducer: after the accumulator, the element and the index. */
const REDUCER_ARRAY = 3;

/** The methods that call back with the array itself, and the place of the parameter that is given it. */
const ARRAY_PARAMETER: ReadonlyMap<string, number> = new Map([
  ['every', 2],
  ['filter', 2],
  ['find', 2],
  ['findIndex', 2],
  ['findLast', 2],
  ['findLastIndex', 2],
  ['flatMap', 2],
  ['forEach', 2],
  ['map', 2],
  ['reduce', REDUCER_ARRAY],
  ['reduceRight', REDUCER_ARRAY],
  ['some', 2],
]);

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

/** The comparisons that read no more than the identity of their operands. */
const IDENTITY: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
]);

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
  const tracked = new Set<VariableDeclaration>([declaration]);
  const pending: VariableDeclaration[] = [declaration];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (subject !== 'array' && !constant(at)) return false;
    const seen = mentions(at).filter((each) => relevant(each));
    const kind = subject === 'held' && holdsList(at) ? 'list' : subject;
    for (const name of seen) {
      const use = classify(name, kind);
      if (!use.known) return false;
      if (use.alias === undefined || tracked.has(use.alias)) continue;
      tracked.add(use.alias);
      pending.push(use.alias);
    }
  }
  return true;
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
  if (isVariableDeclaration(parent)) return handed ? UNKNOWN : aliased(parent, at);
  if (isSpreadAssignment(parent) || isExpressionStatement(parent)) return KNOWN;
  if (subject === 'array' && readsArray(at)) return KNOWN;
  if (isBinaryExpression(parent) && parent.right === at && takesApart(parent.left)) return KNOWN;
  if (overwritten(at)) return KNOWN;
  if (tested(at)) return KNOWN;
  const member = isPropertyAccessExpression(parent) || isElementAccessExpression(parent);
  if (member && parent.expression === at) return memberUse(parent, subject);
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
function aliased(declaration: VariableDeclaration, at: Node): Use {
  const initializer: Node | undefined = declaration.initializer;
  if (initializer !== at || !isIdentifier(declaration.name)) return KNOWN;
  return { known: true, alias: declaration };
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
function takesApart(left: Node): boolean {
  const target = isExpression(left) ? unwrapped(left) : left;
  return isObjectLiteralExpression(target) || isArrayLiteralExpression(target);
}

/**
 * Whether a mention of an array is read: converted to text by a template, an operator or a native
 * that does, spread into a list, or iterated by a loop. The array's own methods run through the
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
  if (!isCallExpression(parent) || !parent.arguments.includes(at as Expression)) return false;
  const path = nativePath(parent.expression);
  return path !== undefined && (READERS.has(path) || CONVERTERS.has(path));
}

/** Whether a mention is only tested: a condition, a negation, `typeof`, an identity or an `in`. */
function tested(at: Node): boolean {
  const { parent } = at;
  if (isIfStatement(parent) || isWhileStatement(parent) || isDoStatement(parent))
    return parent.expression === at;
  if (isConditionalExpression(parent)) return parent.condition === at;
  if (isPrefixUnaryExpression(parent)) return parent.operator === SyntaxKind.ExclamationToken;
  if (isTypeOfExpression(parent) || isVoidExpression(parent)) return true;
  if (!isBinaryExpression(parent)) return false;
  const { kind } = parent.operatorToken;
  return IDENTITY.has(kind) || (kind === SyntaxKind.InKeyword && parent.right === at);
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
    return methodCall(access, user, { subject, depth });
  if (written(result)) return depth === 1 && subject !== 'list' ? KNOWN : UNKNOWN;
  return subject === 'array' ? KNOWN : resultUse(result, memberName(access), depth);
}

/**
 * A method called on a mention: a native method of an array, whose answer goes where it is known and
 * which hands the array to no function of the program. A method of a member of the mention is a method
 * of something else.
 */
function methodCall(
  access: Node,
  call: Node,
  { subject, depth }: { readonly subject: Subject; readonly depth: number },
): Use {
  if (depth > 1) return subject === 'array' ? KNOWN : UNKNOWN;
  const name = memberName(access);
  if (subject !== 'array' || name === undefined || !ARRAY_METHODS.has(name)) return UNKNOWN;
  if (isCallExpression(call) && handsArray(call, name)) return UNKNOWN;
  return SELF_RETURNING.has(name) ? answerUse(call) : KNOWN;
}

/**
 * Whether a method calls a function back with the array as an argument: a function of the program
 * that has a parameter for it (a rest parameter or `arguments` among them), or any callback that is not
 * written out, which may be one.
 */
function handsArray(call: CallExpression, name: string): boolean {
  const position = ARRAY_PARAMETER.get(name);
  const [first] = call.arguments;
  if (position === undefined || first === undefined) return false;
  const callback = unwrapped(first);
  if (!isArrowFunction(callback) && !isFunctionExpression(callback))
    return call.arguments.length > 1 || nativePath(first) === undefined;
  return (
    callback.parameters.length > position ||
    callback.parameters.some((each) => each.dotDotDotToken !== undefined) ||
    mentionsArguments(callback)
  );
}

/** Whether a function names `arguments` anywhere. */
function mentionsArguments(fn: Node): boolean {
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (isIdentifier(node) && node.text === 'arguments') return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
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
  if (readsArray(at)) return KNOWN;
  const { parent } = at;
  const member = isPropertyAccessExpression(parent) || isElementAccessExpression(parent);
  if (member && parent.expression === at) return memberUse(parent, 'array');
  return stored(at) ?? returned(at) ?? chained(at);
}

/** An answer that a constant is initialized with, or a name is assigned: that name stands for the array. */
function stored(at: Node): Use | undefined {
  const { parent } = at;
  if (isVariableDeclaration(parent)) {
    const initializer: Node | undefined = parent.initializer;
    return initializer === at && isIdentifier(parent.name)
      ? { known: true, alias: parent }
      : UNKNOWN;
  }
  const assignment =
    isBinaryExpression(parent) &&
    parent.right === at &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken;
  if (!assignment) return undefined;
  const declaration = namedVariable(parent.left);
  return declaration !== undefined && answerUse(parent).known
    ? { known: true, alias: declaration }
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
  if (!isCallExpression(user) || !onArray(user)) return UNKNOWN;
  if (flowing.inLiteral) return KNOWN;
  const first = mutatorInvocation(user)?.args[0];
  const target: Node | undefined = first === undefined ? undefined : outermost(first);
  return target !== undefined && target === flowing.top ? answerUse(user) : UNKNOWN;
}

/** What a member read hands over: a field of a descriptor, a read, or nothing the compile follows. */
function resultUse(result: Node, field: string | undefined, depth: number): Use {
  const { parent } = result;
  if (isExpressionStatement(parent) || tested(result) || isTemplateSpan(parent)) return KNOWN;
  if (isVariableDeclaration(parent)) {
    const initializer: Node | undefined = parent.initializer;
    const direct = initializer === result && depth === 1 && field !== undefined;
    return direct && DESCRIPTOR_FIELDS.has(field) ? KNOWN : UNKNOWN;
  }
  return readerArgument(result) ? KNOWN : UNKNOWN;
}

/** Whether a node is an argument of a native that reads and runs no application code. */
function readerArgument(at: Node): boolean {
  const { parent } = at;
  if (!isCallExpression(parent) || !parent.arguments.includes(at as Expression)) return false;
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

/** A literal that holds the mention and is the initializer of a constant: that constant holds it in turn. */
function container(user: Node, flowing: { readonly top: Node; readonly inLiteral: boolean }): Use {
  if (!flowing.inLiteral || !isVariableDeclaration(user) || !isIdentifier(user.name))
    return UNKNOWN;
  const initializer: Node | undefined = user.initializer;
  return initializer === flowing.top ? { known: true, alias: user } : UNKNOWN;
}

/** The outermost literal a node is written in, through fields, entries and spreads. */
function containing(node: Node): { readonly top: Node; readonly inLiteral: boolean } {
  let top: Node = node;
  let inLiteral = false;
  for (;;) {
    const { parent } = top;
    const within =
      (isPropertyAssignment(parent) && parent.initializer === top) ||
      isShorthandPropertyAssignment(parent) ||
      isSpreadElement(parent) ||
      isSpreadAssignment(parent) ||
      isParenthesizedExpression(parent);
    const literal = isObjectLiteralExpression(parent) || isArrayLiteralExpression(parent);
    if (!within && !literal) return { top: outermost(top), inLiteral };
    inLiteral ||= literal;
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
 * A mention in the arguments of a call. A native mutator of a written array follows its target, its
 * sources, its descriptors and its maps; a mutator of any other object copies or writes, which the
 * compile does not follow for a held object. Another call may do anything with it, but for a native
 * that reads.
 */
function argumentUse(
  call: Node,
  flowing: { readonly top: Node; readonly inLiteral: boolean },
  subject: Subject,
): Use {
  if (!isCallExpression(call)) return UNKNOWN;
  const invoked = mutatorInvocation(call);
  if (invoked === undefined)
    return !flowing.inLiteral && readerArgument(flowing.top) ? KNOWN : UNKNOWN;
  const position = invoked.args.findIndex((each) => outermost(each) === flowing.top);
  if (position === -1) return UNKNOWN;
  if (position === 0) return subject === 'array' && !flowing.inLiteral ? answerUse(call) : UNKNOWN;
  const target = invoked.args[0];
  if (target !== undefined && arrayIdentity(target) !== undefined) return KNOWN;
  return subject === 'array' ? KNOWN : UNKNOWN;
}
