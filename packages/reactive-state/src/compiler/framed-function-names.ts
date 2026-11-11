import {
  type BinaryExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isConstructorDeclaration,
  isElementAccessExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isParenthesizedExpression,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTypeAssertion,
  isVariableDeclaration,
  type Node,
  type PropertyName,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';

/**
 * The names a function is reached by, and where a function runs where it is written: which names
 * its declaration, its expression, the place that holds it and its class give it, and whether it is
 * made and called on the spot. What follows a name is the module of recursion's.
 */

/** The names a function is called by, and whether it has a name that is worked out. */
export interface FunctionNames {
  readonly names: readonly string[];
  readonly computed: boolean;
}

/** The methods the language calls where nothing names them: a coercion, an iteration, a trap. */
export const IMPLICIT_METHODS: ReadonlySet<string> = new Set([
  'apply',
  'construct',
  'defineProperty',
  'deleteProperty',
  'get',
  'getOwnPropertyDescriptor',
  'getPrototypeOf',
  'has',
  'isExtensible',
  'next',
  'ownKeys',
  'preventExtensions',
  'return',
  'set',
  'setPrototypeOf',
  'then',
  'throw',
  'toJSON',
  'toLocaleString',
  'toString',
  'valueOf',
]);

/** The text of a property name that is written out, none for a computed one. */
export function keyText(name: PropertyName | undefined): string | undefined {
  if (name === undefined || isComputedPropertyName(name)) return undefined;
  return isIdentifier(name) ||
    isPrivateIdentifier(name) ||
    isStringLiteral(name) ||
    isNumericLiteral(name) ||
    isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : undefined;
}

/** Whether a node only gives its operand a type: a parenthesis, `as`, `satisfies`, `!`, `<T>`. */
function isWrapper(node: Node): node is Node & { readonly expression: Node } {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    isNonNullExpression(node) ||
    isTypeAssertion(node)
  );
}

/** The node that holds a function expression or an arrow, past parentheses and type wrappers. */
export function holderOf(fn: Node): Node {
  let at = fn;
  while (isWrapper(at.parent) && at.parent.expression === at) at = at.parent;
  return at;
}

/** The variable an arrow or a function expression is the value of. */
export function boundVariable(fn: Node): VariableDeclaration | undefined {
  if (!isArrowFunction(fn) && !isFunctionExpression(fn)) return undefined;
  const at = holderOf(fn);
  const { parent } = at;
  return isVariableDeclaration(parent) && (parent.initializer as Node | undefined) === at
    ? parent
    : undefined;
}

/** Whether a node is an assignment that gives a value, plain or by a condition. */
function isAssignment(node: Node): node is BinaryExpression {
  return (
    isBinaryExpression(node) &&
    (node.operatorToken.kind === SyntaxKind.EqualsToken ||
      node.operatorToken.kind === SyntaxKind.BarBarEqualsToken ||
      node.operatorToken.kind === SyntaxKind.AmpersandAmpersandEqualsToken ||
      node.operatorToken.kind === SyntaxKind.QuestionQuestionEqualsToken)
  );
}

/** The call, construction or tag that calls a function written here on the spot, or by `call`. */
function callOnTheSpot(held: Node): Node | undefined {
  const { parent: holder } = held;
  const at =
    isPropertyAccessExpression(holder) &&
    holder.expression === held &&
    (holder.name.text === 'call' || holder.name.text === 'apply')
      ? holder
      : held;
  const { parent } = at;
  return ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === at) ||
    (isTaggedTemplateExpression(parent) && parent.tag === at)
    ? parent
    : undefined;
}

/** Whether a function is a generator: a call makes its iterator, and its body runs as that goes on. */
function isGenerator(fn: Node): boolean {
  return (
    (isFunctionDeclaration(fn) || isFunctionExpression(fn) || isMethodDeclaration(fn)) &&
    fn.asteriskToken !== undefined
  );
}

/**
 * Whether nothing keeps a function that is written here: its body runs where it is called on the
 * spot, or it is dropped, or it is a generator whose iterator is. A generator whose iterator is used
 * is advanced where that is, which is not known.
 */
function keptNowhere(fn: Node, held: Node): boolean {
  if (isExpressionStatement(held.parent)) return true;
  const call = callOnTheSpot(held);
  return call !== undefined && (!isGenerator(fn) || isExpressionStatement(call.parent));
}

/** Whether a class is made where it is written, by a `new` on the spot. */
export function madeOnTheSpot(declaration: Node): boolean {
  return isClassExpression(declaration) && callOnTheSpot(holderOf(declaration)) !== undefined;
}

/**
 * Whether a function is made where it is written and called there, as an immediate one is, or a
 * constructor, where its class is made there: one run of the function around it.
 */
export function madeInPlace(fn: Node): boolean {
  if (isConstructorDeclaration(fn)) return madeOnTheSpot(fn.parent);
  return (
    (isFunctionExpression(fn) || isArrowFunction(fn)) && callOnTheSpot(holderOf(fn)) !== undefined
  );
}

/** Whether the body of a function runs where it is written: it is made and called there. */
export function runsInPlace(fn: Node): boolean {
  return madeInPlace(fn) && !isGenerator(fn);
}

/**
 * The names a function expression or an arrow is given where it is the value of something: a
 * variable, a property, an assignment's target. Held anywhere else, passed, returned, or put in a
 * list, it is reached by a name that is worked out.
 */
function givenNames(fn: Node): FunctionNames {
  const at = holderOf(fn);
  const { parent } = at;
  const names: string[] = [];
  let computed = false;
  const add = (name: string | undefined): void => {
    if (name === undefined) computed = true;
    else names.push(name);
  };
  const initial = (parent as { readonly initializer?: Node }).initializer === at;
  if (initial && isVariableDeclaration(parent) && isIdentifier(parent.name)) add(parent.name.text);
  else if (initial && (isPropertyAssignment(parent) || isPropertyDeclaration(parent)))
    add(keyText(parent.name));
  else if (isAssignment(parent) && (parent.right as Node) === at) add(targetName(parent.left));
  else if (!keptNowhere(fn, at)) computed = true;
  return { names, computed };
}

/** The name an assignment writes: a variable's, or a property's. */
function targetName(left: Node): string | undefined {
  const target = unwrapped(left as never) as Node;
  if (isIdentifier(target)) return target.text;
  if (isPropertyAccessExpression(target)) return target.name.text;
  if (
    isElementAccessExpression(target) &&
    (isStringLiteral(target.argumentExpression) ||
      isNoSubstitutionTemplateLiteral(target.argumentExpression))
  )
    return target.argumentExpression.text;
  return undefined;
}

/**
 * The class a constructor belongs to, by the names it has: its own, those it is given, and the
 * name of the property every instance reads it by.
 */
export function namesOfClass(declaration: Node): FunctionNames {
  const names = ['constructor'];
  if ((isClassDeclaration(declaration) || isClassExpression(declaration)) && declaration.name)
    names.push(declaration.name.text);
  if (!isClassExpression(declaration)) return { names, computed: false };
  const given = givenNames(declaration);
  return { names: [...names, ...given.names], computed: given.computed };
}

/**
 * The names a function is reached by. One that can be made, a declaration or an expression of
 * `function`, is reached by `constructor` too, which an instance and `new.target` read it by.
 */
export function namesOf(fn: Node): FunctionNames {
  if (isFunctionDeclaration(fn))
    return { names: fn.name ? [fn.name.text, 'constructor'] : [], computed: false };
  if (isMethodDeclaration(fn) || isGetAccessorDeclaration(fn) || isSetAccessorDeclaration(fn)) {
    const key = keyText(fn.name);
    return key === undefined ? { names: [], computed: true } : { names: [key], computed: false };
  }
  if (isConstructorDeclaration(fn)) return namesOfClass(fn.parent);
  if (!isFunctionExpression(fn) && !isArrowFunction(fn)) return { names: [], computed: false };
  const given = givenNames(fn);
  const own = isFunctionExpression(fn) && fn.name ? [fn.name.text] : [];
  const names = [...own, ...given.names];
  if (isFunctionExpression(fn) && names.length > 0) names.push('constructor');
  return { names, computed: given.computed };
}

/** Whether a node is a function, a method, an accessor or a constructor: code that runs when called. */
export function isFunctionCode(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isArrowFunction(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node)
  );
}

/** Whether a node is a function whose code can be reached again by a name. */
export function isNamedFunction(node: Node): boolean {
  if (!isFunctionCode(node)) return false;
  const { names, computed } = namesOf(node);
  return computed || names.length > 0;
}
