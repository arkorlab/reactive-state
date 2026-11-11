import {
  type BinaryExpression,
  isAsExpression,
  isAwaitExpression,
  type Identifier,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isConstructorDeclaration,
  isElementAccessExpression,
  isExpressionWithTypeArguments,
  isFunctionDeclaration,
  isForOfStatement,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isExpressionStatement,
  isMetaProperty,
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
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTypeAssertion,
  isTypeNode,
  isVariableDeclaration,
  isYieldExpression,
  type Node,
  type PropertyName,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedPossibleBranch } from './framed-branches.ts';
import { readsBinding } from './scope.ts';

/**
 * Where a function can run itself again. A function is reached by the names it is given: its
 * declaration's, its expression's, the variable or the property it is the value of, and its
 * method's or its class's; the code that reads one of them, or a name of a function that does, may
 * reach it before it ends. A function that is used otherwise than by a call, passed, stored or
 * compared, may be reached from anywhere, and so may one a getter, a setter or a method that the
 * language calls by itself holds, and one held where no name gives it: passed to a call, returned,
 * put in a list. A run that waits or yields lets another call of the function go on in its place.
 */

/** The names a function is called by, and whether it has a name that is worked out. */
interface FunctionNames {
  readonly names: readonly string[];
  readonly computed: boolean;
}

/** The methods the language calls where nothing names them: a coercion, an iteration, a trap. */
const IMPLICIT_METHODS: ReadonlySet<string> = new Set([
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

/** Whether a node is a type and no value: the expression a class extends is a value. */
function isTypeOnly(node: Node): boolean {
  return isTypeNode(node) && !isExpressionWithTypeArguments(node);
}

/** The text of a property name that is written out, none for a computed one. */
function keyText(name: PropertyName | undefined): string | undefined {
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
function holderOf(fn: Node): Node {
  let at = fn;
  while (isWrapper(at.parent) && at.parent.expression === at) at = at.parent;
  return at;
}

/** The variable an arrow or a function expression is the value of. */
function boundVariable(fn: Node): VariableDeclaration | undefined {
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

/** Whether nothing keeps a function that is written here: it is called on the spot, or dropped. */
function keptNowhere(held: Node): boolean {
  const { parent: holder } = held;
  const at =
    isPropertyAccessExpression(holder) &&
    holder.expression === held &&
    (holder.name.text === 'call' || holder.name.text === 'apply')
      ? holder
      : held;
  const { parent } = at;
  return (
    ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === at) ||
    (isTaggedTemplateExpression(parent) && parent.tag === at) ||
    isExpressionStatement(parent)
  );
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
  else if (!keptNowhere(at)) computed = true;
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
function namesOfClass(declaration: Node): FunctionNames {
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
function namesOf(fn: Node): FunctionNames {
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

/** Whether a node is a function whose code can be reached again by a name. */
export function isNamedFunction(node: Node): boolean {
  if (
    !isFunctionDeclaration(node) &&
    !isFunctionExpression(node) &&
    !isArrowFunction(node) &&
    !isMethodDeclaration(node) &&
    !isGetAccessorDeclaration(node) &&
    !isSetAccessorDeclaration(node) &&
    !isConstructorDeclaration(node)
  )
    return false;
  const { names, computed } = namesOf(node);
  return computed || names.length > 0;
}

/** The name a node reads, if it reads one: a variable, or a property by its name. */
function referenceText(node: Node): string | undefined {
  if (isMetaProperty(node))
    return node.keywordToken === SyntaxKind.NewKeyword ? 'constructor' : undefined;
  if (isIdentifier(node)) {
    const { parent } = node;
    if (isPropertyAccessExpression(parent) && parent.name === node) return node.text;
    if (!isShorthandPropertyAssignment(parent) && (parent as { name?: Node }).name === node)
      return undefined;
    return readsBinding(node) ? node.text : undefined;
  }
  return isStringLiteral(node) &&
    isElementAccessExpression(node.parent) &&
    node.parent.argumentExpression === node
    ? node.text
    : undefined;
}

/**
 * Whether a node, the name of a reference, is what a call, a construction or a tag calls: the name
 * itself, a property's, or either of them through `call` or `apply`.
 */
function called(node: Node): boolean {
  let at = holderOf(node);
  if (isPropertyAccessExpression(at.parent) && at.parent.name === at) at = holderOf(at.parent);
  if (isPropertyAccessExpression(at.parent) && at.parent.expression === at) {
    const via = at.parent.name.text;
    if (via !== 'call' && via !== 'apply') return false;
    at = holderOf(at.parent);
  }
  const { parent } = at;
  return (
    ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === at) ||
    (isTaggedTemplateExpression(parent) && parent.tag === at)
  );
}

/** Whether a reference is a name that is written to, and not read. */
function written(node: Node): boolean {
  const { parent } = node;
  return (
    isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken
  );
}

/** Whether no arm a written condition rules out holds the node, or a function that holds it. */
function runsWithin(node: Node, fn: Node): boolean {
  if (!framedPossibleBranch(node)) return false;
  for (let at = node.parent; at !== fn; at = at.parent)
    if (isAnswering(at) && !framedPossibleBranch(at)) return false;
  return true;
}

/** Whether a node lies in the initializer of an instance field, which runs when one is made. */
function inInstanceInitializer(node: Node, fn: Node): boolean {
  for (let at = node; at !== fn; at = at.parent)
    if (isInstanceInitializer(at.parent, at)) return true;
  return false;
}

/** Whether a node is what the instance field that holds it is given. */
function isInstanceInitializer(holder: Node, node: Node): boolean {
  if (!isPropertyDeclaration(holder)) return false;
  const initializer: Node | undefined = holder.initializer;
  return (
    initializer === node &&
    holder.modifiers?.some((each) => each.kind === SyntaxKind.StaticKeyword) !== true
  );
}

/**
 * Whether a name read inside the function resolves to the function: no parameter, no local, and no
 * function or class within it that is named alike takes the name first. A name that is not the
 * function's own or its variable's is taken for the function's wherever it is read.
 */
function refersToFunction(name: Identifier, fn: Node): boolean {
  const declared = frameDeclarationOf(name);
  if (isFunctionExpression(fn) && fn.name?.text === name.text) {
    if (declared !== undefined) return false;
  } else if (isFunctionDeclaration(fn) && fn.name?.text === name.text) {
    if (declared !== fn) return false;
  } else if (boundVariable(fn)?.name.getText() === name.text && declared !== boundVariable(fn)) {
    return false;
  }
  for (let at = name.parent; at !== fn; at = at.parent)
    if ((isFunctionExpression(at) || isClassExpression(at)) && at.name?.text === name.text)
      return false;
  return true;
}

/** The functions of the file with the names they are reached by, and the code of each. */
interface FileFunctions {
  readonly byName: ReadonlyMap<string, readonly Node[]>;
  readonly implicit: readonly Node[];
}

const FUNCTIONS = new WeakMap<SourceFile, FileFunctions>();

/** The functions of a file by name, and those the language may call by itself. */
function functionsOf(file: SourceFile): FileFunctions {
  const known = FUNCTIONS.get(file);
  if (known !== undefined) return known;
  const byName = new Map<string, Node[]>();
  const implicit: Node[] = [];
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    for (const name of reachedNames(node).names)
      byName.set(name, [...(byName.get(name) ?? []), node]);
    if (isNamedFunction(node) && runsBySelf(node)) implicit.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const found = { byName, implicit };
  FUNCTIONS.set(file, found);
  return found;
}

/** The names a function or a class is reached by; a class by its own. */
function reachedNames(node: Node): FunctionNames {
  if (isClassDeclaration(node) || isClassExpression(node)) return namesOfClass(node);
  return isNamedFunction(node) ? namesOf(node) : { names: [], computed: false };
}

/** Whether the language may call a function by itself: an accessor or an implicit method. */
function runsBySelf(fn: Node): boolean {
  const { names, computed } = namesOf(fn);
  const accessor = isGetAccessorDeclaration(fn) || isSetAccessorDeclaration(fn);
  return computed || accessor || names.some((name) => IMPLICIT_METHODS.has(name));
}

/** Whether the code of a function reads one of the names where it may run. */
function mentionsAny(fn: Node, names: ReadonlySet<string>): boolean {
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const text = referenceText(node);
    if (text !== undefined && names.has(text) && !written(node) && runsWithin(node, fn))
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * The names by which a function is reached again, and whether it may be reached from anywhere: its
 * own, and those of the functions of the file that read one of them; and a function that is used
 * otherwise than by a call, or one the language calls by itself that reads one.
 */
function reaching(fn: Node): { readonly names: ReadonlySet<string>; readonly anywhere: boolean } {
  const names = new Set(namesOf(fn).names);
  const { byName, implicit } = functionsOf(fn.getSourceFile());
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, functions] of byName)
      if (!names.has(name) && functions.some((each) => mentionsAny(each, names))) {
        names.add(name);
        grew = true;
      }
  }
  const anywhere =
    namesOf(fn).computed ||
    reachedByProperty(fn) ||
    implicit.some((each) => mentionsAny(each, names)) ||
    escapes(fn.getSourceFile(), names);
  return { names, anywhere };
}

/** Whether a function is the value of a property, or a method: a key worked out reaches it. */
function reachedByProperty(fn: Node): boolean {
  if (isMethodDeclaration(fn) || isGetAccessorDeclaration(fn) || isSetAccessorDeclaration(fn))
    return true;
  if (!isFunctionExpression(fn) && !isArrowFunction(fn)) return false;
  const { parent } = holderOf(fn);
  if (isPropertyAssignment(parent) || isPropertyDeclaration(parent)) return true;
  return (
    isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    (isPropertyAccessExpression(parent.left) || isElementAccessExpression(parent.left))
  );
}

/** Whether the file uses one of the names otherwise than by calling it or giving it a value. */
function escapes(file: SourceFile, names: ReadonlySet<string>): boolean {
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const text = referenceText(node);
    if (
      text !== undefined &&
      names.has(text) &&
      !written(node) &&
      !called(node) &&
      !isDeclarationName(node) &&
      framedPossibleBranch(node)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whether a node names what a declaration declares, in a property of a literal or a class. */
function isDeclarationName(node: Node): boolean {
  const { parent } = node;
  return (isPropertyAssignment(parent) || isPropertyDeclaration(parent)) && parent.name === node;
}

/** The parts of a function that run where it is written: a computed name, and its decorators. */
function definitionParts(fn: Node): readonly Node[] {
  const { name, modifiers } = fn as { readonly name?: Node; readonly modifiers?: readonly Node[] };
  const decorators = modifiers?.filter((each) => each.kind === SyntaxKind.Decorator) ?? [];
  return name !== undefined && isComputedPropertyName(name) ? [name, ...decorators] : decorators;
}

/** Whether code that runs in the range reaches what the language may call by itself. */

function runsCodeBetween(fn: Node, from: number, to: number): boolean {
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (node !== fn && isAnswering(node)) {
      pending.push(...definitionParts(node));
      continue;
    }
    if (node.pos >= from && node.pos < to && !isCodeFree(node) && framedPossibleBranch(node))
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** The kinds of node that run no code but their parts': a name, a literal, a plain statement. */
const CODE_FREE: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.AsExpression,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.Block,
  SyntaxKind.BreakStatement,
  SyntaxKind.CaseBlock,
  SyntaxKind.CaseClause,
  SyntaxKind.CatchClause,
  SyntaxKind.ConditionalExpression,
  SyntaxKind.ContinueStatement,
  SyntaxKind.DefaultClause,
  SyntaxKind.EmptyStatement,
  SyntaxKind.ExpressionStatement,
  SyntaxKind.FalseKeyword,
  SyntaxKind.FunctionExpression,
  SyntaxKind.Identifier,
  SyntaxKind.IfStatement,
  SyntaxKind.LabeledStatement,
  SyntaxKind.NonNullExpression,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.PropertyAssignment,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.ReturnStatement,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.ShorthandPropertyAssignment,
  SyntaxKind.StringLiteral,
  SyntaxKind.SwitchStatement,
  SyntaxKind.ThisKeyword,
  SyntaxKind.ThrowStatement,
  SyntaxKind.TrueKeyword,
  SyntaxKind.TryStatement,
  SyntaxKind.TypeAssertionExpression,
  SyntaxKind.VariableDeclaration,
  SyntaxKind.VariableDeclarationList,
  SyntaxKind.VariableStatement,
]);

/** Whether a node runs no code but its parts': any other may call a getter, a trap or a method. */
function isCodeFree(node: Node): boolean {
  return CODE_FREE.has(node.kind);
}

/** Whether a node suspends the function that runs it, which lets another run of it begin. */
function isSuspension(node: Node): boolean {
  return (
    isAwaitExpression(node) ||
    isYieldExpression(node) ||
    (isForOfStatement(node) && node.awaitModifier !== undefined)
  );
}

/**
 * Whether the function runs itself again between two positions: its names, or those of a function
 * that reads one of them, are read there where the code may run; where the function may be reached
 * from anywhere, whenever code runs there at all; and where it waits or yields, which lets a run
 * that another call began go on in its place.
 */
export function runsItselfBetween(fn: Node, from: number, to: number): boolean {
  if (!isNamedFunction(fn)) return false;
  const { names, anywhere } = reaching(fn);
  if (anywhere && runsCodeBetween(fn, from, to)) return true;
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (node !== fn && isNamedFunction(node)) {
      pending.push(...definitionParts(node));
      continue;
    }
    if (node.pos >= from && node.pos < to && (isSuspension(node) || callsFunction(node, fn, names)))
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whether a node reads a name by which the function is reached, in a place that may run. */
function callsFunction(node: Node, fn: Node, names: ReadonlySet<string>): boolean {
  const text = referenceText(node);
  return (
    text !== undefined &&
    names.has(text) &&
    !written(node) &&
    (!isIdentifier(node) || refersToFunction(node, fn)) &&
    runsWithin(node, fn) &&
    !inInstanceInitializer(node, fn)
  );
}

/** Whether the function runs itself again anywhere in its code. */
export function runsItself(fn: Node): boolean {
  return runsItselfBetween(fn, -Infinity, Infinity);
}
