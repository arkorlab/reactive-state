import {
  type AccessorDeclaration,
  type BinaryExpression,
  type CallExpression,
  type ClassDeclaration,
  type ClassExpression,
  type Expression,
  type FunctionLikeDeclaration,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isBlock,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isConstructorDeclaration,
  isDecorator,
  isCallExpression,
  isElementAccessExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isExpressionStatement,
  isFunctionLikeDeclaration,
  isIdentifier,
  isReturnStatement,
  isSetAccessorDeclaration,
  isMethodDeclaration,
  isGetAccessorDeclaration,
  isNonNullExpression,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isVariableDeclaration,
  isVariableStatement,
  type MethodDeclaration,
  type PropertyDeclaration,
  type Node,
  NodeFlags,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import {
  sourceArrayFunction,
  writtenArrayFunction,
  writtenArrayKey,
} from './framed-array-functions.ts';
import { arrayIdentity } from './framed-array-identity.ts';
import { instanceInitializer, invokedAtOnce } from './framed-array-mutations.ts';
import { assignmentPatternDefault } from './framed-assignment-patterns.ts';
import { frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { constantValue } from './numbers.ts';

/** The names an array's own methods may take, and what a direct write of one declares. */

export const OWN_METHODS = new Set([
  'at',
  'concat',
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flat',
  'flatMap',
  'forEach',
  'join',
  'map',
  'pop',
  'reduce',
  'reduceRight',
  'shift',
  'slice',
  'some',
  'sort',
  'splice',
  'toReversed',
  'toSorted',
  'toSpliced',
  'toString',
  'with',
]);

export interface ArrayMethodOverride {
  readonly own: boolean;
  readonly value?: Expression | MethodDeclaration;
  /** A data property the descriptor wrote writable: a later write replaces it. */
  readonly writable?: true;
  /** A property the descriptor wrote configurable: a later definition or deletion replaces it. */
  readonly configurable?: true;
  /** A deletion left the array the method it inherits. */
  readonly inherited?: true;
}

/** The own methods a write names, as far as it shows them. */
export type OwnMethods = Map<string, ArrayMethodOverride>;

/**
 * The expression a statement of the block evaluates for certain and may write the array's methods
 * with: an expression statement's, the initializer of the one declaration of a plain name, or the
 * right of an assignment to a plain name that is no write of a method, whose own write is the call
 * or the deletion it holds. What runs after the expression, a pattern's defaults and the setter of a
 * property assigned, is no part of it.
 */
export function definiteExpression(before: Node, root: FrameBinding): Expression | undefined {
  let expression: Expression | undefined;
  if (isExpressionStatement(before)) expression = before.expression;
  else if (isVariableStatement(before)) {
    const [only, ...rest] = before.declarationList.declarations;
    const plain = only !== undefined && rest.length === 0 && isIdentifier(only.name);
    expression = plain ? only.initializer : undefined;
  }
  const value = expression === undefined ? undefined : unwrapped(expression);
  const stored =
    value !== undefined &&
    isBinaryExpression(value) &&
    value.operatorToken.kind === SyntaxKind.EqualsToken &&
    isIdentifier(unwrapped(value.left)) &&
    ownMethodAssignment(value, root) === undefined;
  return stored ? value.right : expression;
}

/** The operators whose right side runs only on some left. */
const SHORT_CIRCUITS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * A descriptor written with `__proto__: object` takes fields from that object, which the compile
 * leaves unread: it may name an accessor, or any attribute.
 */
function setsPrototype(property: ObjectLiteralElementLike): boolean {
  return (
    isPropertyAssignment(property) &&
    !isComputedPropertyName(property.name) &&
    writtenArrayKey(property.name) === '__proto__'
  );
}

/** Whether an assignment gives a member a value, whose setter runs after the right side. */
function setsMember(node: BinaryExpression): boolean {
  const kind = node.operatorToken.kind;
  const assigns = kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
  return assigns && !isIdentifier(unwrapped(node.left));
}

/** Whether a node is a link of an optional chain, which runs what follows `?.` only on some value. */
function inOptionalChain(node: Node): boolean {
  // eslint-disable-next-line no-bitwise -- TypeScript marks the links of an optional chain with this flag.
  return (node.flags & NodeFlags.OptionalChain) !== 0;
}

/**
 * The links of an optional chain read the expression before them first: whatever that expression
 * holds runs before `?.` decides whether the rest of the chain does.
 */
function readsFirst(link: Node, at: Node): boolean {
  const reads =
    isPropertyAccessExpression(link) ||
    isElementAccessExpression(link) ||
    isCallExpression(link) ||
    isNonNullExpression(link);
  return reads && link.expression === at;
}

/** Whether a node is `||=`, `&&=` or `??=`, which assigns only where its left says so. */
function isLogicalAssignment(node: Node): boolean {
  if (!isBinaryExpression(node)) return false;
  const kind = node.operatorToken.kind;
  return (
    kind === SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === SyntaxKind.BarBarEqualsToken ||
    kind === SyntaxKind.QuestionQuestionEqualsToken
  );
}

/**
 * Whether an expression runs whenever its statement does: the statement is an expression, a
 * declaration or a class, and no condition, short circuit, optional chain, default of a pattern,
 * function, instance field or inner statement lies between them. A loop, a branch or a switch runs
 * its parts on some paths. A logical assignment is itself no sure write: it assigns where its left
 * says so.
 */
export function evaluatedForSure(node: Node, statement: Node): boolean {
  const runs =
    isExpressionStatement(statement) ||
    isVariableStatement(statement) ||
    isClassDeclaration(statement);
  if (!runs || isLogicalAssignment(node)) return false;
  for (let at = node; at !== statement; at = at.parent) {
    if (skipsLink(at, statement)) return false;
  }
  return true;
}

/**
 * Whether a node lies in what runs later: the body and the parameters of a function, which run when
 * it is called, and the initializer of an instance field, which runs when an instance is made. The
 * computed name of a member runs when the object or the class is defined, and the body of a
 * function called where it is written runs now.
 */
function runsLater(parent: Node, at: Node): boolean {
  if (!isFunctionLikeDeclaration(parent)) return instanceInitializer(parent) === at;
  const body: Node | undefined = parent.body;
  return !isComputedPropertyName(at) && !(body === at && invokedAtOnce(parent));
}

/** The default a binding element or a shorthand field of a pattern holds: it runs on some values. */
function patternDefault(node: Node): Node | undefined {
  if (isBindingElement(node)) return node.initializer;
  return isShorthandPropertyAssignment(node) ? node.objectAssignmentInitializer : undefined;
}

/** Whether what holds `at` runs it only on some paths: a branch, a short circuit, a chain, a setter. */
function skipsLink(at: Node, statement: Node): boolean {
  const { parent } = at;
  if (isConditionalExpression(parent)) return at !== parent.condition;
  if (patternDefault(parent) === at) return true;
  if (isBinaryExpression(parent) && parent.right === at)
    return (
      SHORT_CIRCUITS.has(parent.operatorToken.kind) ||
      setsMember(parent) ||
      assignmentPatternDefault(parent)
    );
  if (runsLater(parent, at)) return true;
  if (inOptionalChain(parent) && !readsFirst(parent, at)) return true;
  const inner = parent.kind >= SyntaxKind.FirstStatement && parent.kind <= SyntaxKind.LastStatement;
  return inner && parent !== statement && !runsStraight(parent);
}

/**
 * Whether a statement of a class's static block, or of the body of a function called where it is
 * written, runs whenever that body does: it is an expression, a declaration, a plain block or the
 * last `return`, and only plain blocks lie between it and the body, which runs, from its first
 * statement to its last, when the class is defined or the function is called.
 */
function runsStraight(statement: Node): boolean {
  const plain =
    isBlock(statement) ||
    isExpressionStatement(statement) ||
    isVariableStatement(statement) ||
    isReturnStatement(statement);
  if (!plain) return false;
  let within = statement.parent;
  while (isBlock(within)) within = within.parent;
  if (isClassStaticBlockDeclaration(within)) return !isReturnStatement(statement);
  return isFunctionLikeDeclaration(within) && invokedAtOnce(within) && !returnsEarly(within);
}

/** Whether a function body may leave before its last statement: a `return` that is not the last. */
function returnsEarly(fn: FunctionLikeDeclaration): boolean {
  const { body } = fn;
  if (body === undefined || !isBlock(body)) return false;
  const last: Node | undefined = body.statements.at(-1);
  const pending: Node[] = [...body.statements];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node !== last && isReturnStatement(node)) return true;
    if (!isFunctionLikeDeclaration(node))
      node.forEachChild((child) => {
        pending.push(child);
      });
  }
  return false;
}

/** A pattern and the value it binds: a declaration's or a default's initializer, an assignment's right. */
function boundPattern(node: Node): { readonly pattern: Node; readonly value: Node } | undefined {
  if (isVariableDeclaration(node) || isBindingElement(node)) {
    const { name, initializer } = node;
    const binds =
      name !== undefined && (isObjectBindingPattern(name) || isArrayBindingPattern(name));
    return binds && initializer !== undefined ? { pattern: name, value: initializer } : undefined;
  }
  if (!isBinaryExpression(node) || node.operatorToken.kind !== SyntaxKind.EqualsToken)
    return undefined;
  const { left } = node;
  return isObjectLiteralExpression(left) || isArrayLiteralExpression(left)
    ? { pattern: left, value: node.right }
    : undefined;
}

/** A member of a class that has a name, which may be computed. */
type NamedMember = MethodDeclaration | PropertyDeclaration | AccessorDeclaration;

/** Whether a node is a member of a class that has a name. */
function isNamedMember(member: Node): member is NamedMember {
  return (
    isPropertyDeclaration(member) ||
    isMethodDeclaration(member) ||
    isGetAccessorDeclaration(member) ||
    isSetAccessorDeclaration(member)
  );
}

/** Whether a member runs with the class: a static block, or a static field's initializer. */
function isStaticMember(member: Node): boolean {
  return (
    isClassStaticBlockDeclaration(member) ||
    (isPropertyDeclaration(member) &&
      member.modifiers?.some((each) => each.kind === SyntaxKind.StaticKeyword) === true)
  );
}

/** The decorators of a member: they run with its name, in the order of the members. */
function decoratorsOf(member: Node): readonly Node[] {
  const decorated =
    isNamedMember(member) ||
    isClassStaticBlockDeclaration(member) ||
    isConstructorDeclaration(member);
  return (decorated ? (member.modifiers ?? []) : []).filter((each) => isDecorator(each));
}

/**
 * What a class runs, in order: what it extends, the computed names of its members in their order,
 * then its static initializers and blocks in theirs, and last the initializers of instances, which
 * run once the class is made. The methods and the constructor run when they are called.
 */
function membersInRunOrder(
  node: ClassDeclaration | ClassExpression,
  children: readonly Node[],
): readonly Node[] {
  const members = new Set<Node>(node.members);
  const names = node.members.flatMap((member): Node[] => {
    return [
      ...decoratorsOf(member),
      ...(isNamedMember(member) && isComputedPropertyName(member.name) ? [member.name] : []),
    ];
  });
  const initializers = (wanted: boolean): Node[] => {
    return node.members.flatMap((member): Node[] => {
      if (isStaticMember(member) !== wanted) return [];
      if (isClassStaticBlockDeclaration(member)) return [member];
      return isPropertyDeclaration(member) && member.initializer !== undefined
        ? [member.initializer]
        : [];
    });
  };
  return [
    ...children.filter((child) => !members.has(child)),
    ...names,
    ...initializers(true),
    ...initializers(false),
  ];
}

/** Whether a call runs a function written as its callee, whose body runs after the arguments. */
function calledAtOnce(call: CallExpression): boolean {
  const callee = unwrapped(call.expression);
  return isFunctionLikeDeclaration(callee) && invokedAtOnce(callee);
}

/**
 * The children of a node in the order they run. A pattern binds what its value evaluated to, so the
 * value runs before the keys and targets the pattern names.
 */
export function inRunOrder(node: Node): readonly Node[] {
  const children: Node[] = [];
  node.forEachChild((child) => {
    children.push(child);
  });
  if (isClassExpression(node) || isClassDeclaration(node)) return membersInRunOrder(node, children);
  if (isCallExpression(node) && calledAtOnce(node))
    return [...children.filter((child) => child !== node.expression), node.expression];
  const bound = boundPattern(node);
  if (bound === undefined) return children;
  const rest = children.filter((child) => child !== bound.value);
  rest.splice(rest.indexOf(bound.pattern), 0, bound.value);
  return rest;
}

/** What an assignment makes a property: writable and configurable, as a descriptor would say. */
export const PLAIN_PROPERTY = { writable: true, configurable: true } as const;

/**
 * A method a write may have replaced: unproven, with the attributes it has both ways, as it was
 * and as the write leaves it, if it ran. A write of the value alone leaves it as it was.
 */
export function afterPossibleWrite(
  previous: ArrayMethodOverride | undefined,
  written: ArrayMethodOverride | undefined,
): ArrayMethodOverride {
  const writable = previous?.writable === true && written?.writable === true;
  const configurable = previous?.configurable === true && written?.configurable === true;
  return {
    own: false,
    ...(writable && { writable: true as const }),
    ...(configurable && { configurable: true as const }),
  };
}

/**
 * A method a write that is sure to run leaves: unproven, with the attributes the write leaves it,
 * which a write of the value alone leaves as they were.
 */
export function afterSureWrite(written: ArrayMethodOverride | undefined): ArrayMethodOverride {
  return {
    own: false,
    ...(written?.writable === true && { writable: true as const }),
    ...(written?.configurable === true && { configurable: true as const }),
  };
}

/**
 * A method an assignment sure to run leaves: unproven, and a writable data property, since an
 * assignment to one that is not throws; it is configurable if it was, or if the array had no own
 * property of the name before, which the assignment then creates as one.
 */
export function afterAssignment(previous: ArrayMethodOverride | undefined): ArrayMethodOverride {
  return {
    own: false,
    writable: true,
    ...((previous === undefined || previous.configurable === true) && {
      configurable: true as const,
    }),
  };
}

/** One direct assignment to the native method selected by a call; it creates a plain property. */
export function ownMethodAssignment(
  node: Node,
  root: FrameBinding,
): (ArrayMethodOverride & { readonly key: string }) | undefined {
  if (!isBinaryExpression(node) || node.operatorToken.kind !== SyntaxKind.EqualsToken)
    return undefined;
  const member = unwrapped(node.left);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const key = frameMemberName(member);
  if (key === undefined || !OWN_METHODS.has(key) || arrayIdentity(member.expression) !== root)
    return undefined;
  return {
    key,
    own: sourceArrayFunction(node.right) || knownNonNative(node.right),
    value: node.right,
    ...PLAIN_PROPERTY,
  };
}

/** A written non-callable join makes native toString fall back to the ordinary object tag. */
export function knownNonNative(expression: Expression): boolean {
  const value = unwrapped(expression);
  return (
    writtenArrayFunction(value) ||
    constantValue(value) !== undefined ||
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword ||
    globalPathOf(value)?.join('.') === 'undefined'
  );
}

/**
 * Each source's last explicitly written field wins; an unknown source may restore native methods. A
 * getter runs where the copy reaches it, and may give the array another method, or the fields after
 * it another value: the methods are unproven from there on.
 */
export function assignMethods(source: Expression, own: OwnMethods): void {
  const value = unwrapped(source);
  if (!isObjectLiteralExpression(value)) {
    forgetMethods(own);
    return;
  }
  let run = false;
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) {
      forgetMethods(own);
      continue;
    }
    if (isGetAccessorDeclaration(property)) {
      forgetMethods(own);
      run = true;
      continue;
    }
    const key = writtenArrayKey(property.name);
    if (key === undefined) forgetMethods(own);
    else if (OWN_METHODS.has(key)) {
      const written = propertyOverride(property);
      own.set(key, run ? afterPossibleWrite(own.get(key), written) : written);
    }
  }
}

/** A written own method or callable value, with unknown entries kept unproven; a plain property. */
function propertyOverride(property: Node): ArrayMethodOverride {
  if (isMethodDeclaration(property)) return { own: true, value: property, ...PLAIN_PROPERTY };
  if (!isPropertyAssignment(property)) return { own: false };
  const { initializer } = property;
  return { own: knownNonNative(initializer), value: initializer, ...PLAIN_PROPERTY };
}

/** One statically named data descriptor (after the target, its key and descriptor), including restoration to the native implementation. */
export function defineMethod(args: readonly Expression[], own: OwnMethods): void {
  const keyNode = args[1];
  const key = keyNode === undefined ? undefined : constantValue(keyNode);
  if (typeof key !== 'string') {
    forgetMethods(own);
    return;
  }
  if (OWN_METHODS.has(key)) own.set(key, descriptorFunction(args[2], own.get(key)));
}

/**
 * Object.defineProperties selects each descriptor by its written property name. A getter of the map
 * runs where the definitions reach it, and may give the array another method, or the descriptors
 * after it another value: the methods are unproven from there on.
 */
export function descriptorMethods(descriptors: ObjectLiteralExpression, own: OwnMethods): void {
  let run = false;
  for (const property of descriptors.properties) {
    if (isSpreadAssignment(property)) {
      forgetMethods(own);
      continue;
    }
    if (isGetAccessorDeclaration(property)) {
      forgetMethods(own);
      run = true;
      continue;
    }
    const key = writtenArrayKey(property.name);
    if (key === undefined) forgetMethods(own);
    else if (OWN_METHODS.has(key)) {
      const written = isPropertyAssignment(property)
        ? descriptorFunction(property.initializer, own.get(key))
        : { own: false };
      own.set(key, run ? afterPossibleWrite(own.get(key), written) : written);
    }
  }
}

const ACCESSOR_KEYS = new Set(['get', 'set']);

/**
 * A written value function proves a custom implementation; getters and unknown values do not. An
 * attribute the descriptor leaves unsaid stays as the property it redefines had it.
 */
function descriptorFunction(
  descriptor: Expression | undefined,
  previous?: ArrayMethodOverride,
): ArrayMethodOverride {
  if (descriptor === undefined) return { own: false };
  const value = unwrapped(descriptor);
  if (!isObjectLiteralExpression(value)) return { own: false };
  const writable = attributeKept(descriptorSays(value, 'writable'), previous?.writable);
  const configurable = attributeKept(descriptorSays(value, 'configurable'), previous?.configurable);
  return {
    ...descriptorValue(value),
    ...(writable && { writable: true as const }),
    ...(configurable && { configurable: true as const }),
  };
}

/** An attribute the descriptor says is true, or leaves unsaid where the property it redefines had it. */
function attributeKept(says: AttributeSaid, before: true | undefined): boolean {
  return says === 'true' || (says === 'omitted' && before === true);
}

/** The attributes a descriptor's conversion reads before its value. */
const READ_BEFORE_VALUE: ReadonlySet<string> = new Set(['configurable', 'enumerable']);

/** Whether a field is a getter that may give the descriptor another value before it is read. */
function rewritesValue(property: ObjectLiteralElementLike, key: string | undefined): boolean {
  return isGetAccessorDeclaration(property) && (key === undefined || READ_BEFORE_VALUE.has(key));
}

/**
 * The value a descriptor writes, unproven once an accessor, a spread or an unknown key may follow.
 * A getter named by an attribute read before the value, or that may be, may give the descriptor
 * another value first.
 */
function descriptorValue(value: ObjectLiteralExpression): ArrayMethodOverride {
  let custom: ArrayMethodOverride = { own: false };
  let rewritten = false;
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) custom = { own: false };
    else {
      const key = writtenArrayKey(property.name);
      rewritten ||= rewritesValue(property, key);
      if (key === undefined || ACCESSOR_KEYS.has(key) || setsPrototype(property))
        custom = { own: false };
      else if (key === 'value')
        custom = isPropertyAssignment(property)
          ? { own: knownNonNative(property.initializer), value: property.initializer }
          : { own: false };
    }
  }
  return rewritten ? { own: false } : custom;
}

type AttributeSaid = 'omitted' | 'other' | 'true';

/**
 * What a descriptor says of an attribute: a literal `true` as its last word, nothing at all, or
 * anything else — `false`, a value the compile cannot read, a spread, a key that is not written out.
 * A writable data property is not an accessor.
 */
function descriptorSays(
  descriptor: ObjectLiteralExpression,
  attribute: 'configurable' | 'writable',
): AttributeSaid {
  let says: AttributeSaid = 'omitted';
  for (const property of descriptor.properties) {
    if (isSpreadAssignment(property)) return 'other';
    const key = writtenArrayKey(property.name);
    if (key === undefined || setsPrototype(property)) return 'other';
    if (attribute === 'writable' && ACCESSOR_KEYS.has(key)) return 'other';
    if (key === attribute)
      says =
        isPropertyAssignment(property) &&
        unwrapped(property.initializer).kind === SyntaxKind.TrueKeyword
          ? 'true'
          : 'other';
  }
  return says;
}

/** An opaque write can replace either method and therefore removes a proof of a custom method. */
export function forgetMethods(own: OwnMethods): void {
  for (const method of OWN_METHODS) own.set(method, { own: false });
}
