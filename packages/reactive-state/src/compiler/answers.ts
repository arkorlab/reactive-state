import {
  type ArrowFunction,
  type BindingName,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type GetAccessorDeclaration,
  isArrowFunction,
  isBindingElement,
  isBlock,
  isCallSignatureDeclaration,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isConstructorTypeNode,
  isConstructSignatureDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionTypeNode,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isModuleBlock,
  isReturnStatement,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadElement,
  isTypeReferenceNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  type MethodDeclaration,
  type Node,
  type ParameterDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import type { MemberValue } from './exported-values.ts';
import { bindingIdentifiers } from './scope.ts';

/**
 * What a function a module exports answers called, as the compile reads its code: what it returns,
 * and what of what a call gives it that may be — a parameter its return type types of a type
 * parameter, `value` of `identity<T>(value: T): T`, or one it returns, `return value` — so that
 * what no JSON holds given there is taken for what it answers (`json-values.ts`).
 */

/** A function that answers what its body returns: a getter, read. */
export type Answering =
  | ArrowFunction
  | FunctionDeclaration
  | FunctionExpression
  | GetAccessorDeclaration
  | MethodDeclaration;

/** Whether `node` is a function that answers what its body returns. */
export function isAnswering(node: Node): node is Answering {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isArrowFunction(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node)
  );
}

/**
 * The declarations of the function `fn` is declared over overloads with — each signature, and the
 * one that implements them, any of which may answer a call as it is written: what the first
 * resolves to of a module's names is its first signature — or `fn` alone.
 */
export function overloadsOf(fn: Answering): readonly Answering[] {
  if (!isFunctionDeclaration(fn) || fn.name === undefined) {
    return [fn];
  }
  const { name, parent } = fn;
  const clause = parent.kind === SyntaxKind.CaseClause || parent.kind === SyntaxKind.DefaultClause;
  if (!clause && !isSourceFile(parent) && !isBlock(parent) && !isModuleBlock(parent)) {
    return [fn];
  }
  // A clause of a switch lists its statements after the case expression, as its children.
  const found: FunctionDeclaration[] = [];
  parent.forEachChild((each) => {
    if (isFunctionDeclaration(each) && each.name?.text === name.text) found.push(each);
  });
  return found;
}

/** The function that answers what a module declares is called: one written, a method, a getter. */
export function answeringOf(value: MemberValue | undefined): Answering | undefined {
  if (value === undefined || isClassDeclaration(value)) {
    return undefined;
  }
  const fn =
    isFunctionDeclaration(value) || isMethodDeclaration(value) || isGetAccessorDeclaration(value)
      ? value
      : unwrapped(value);
  return isAnswering(fn) ? fn : undefined;
}

/** What `fn` returns, where its code writes it: its body's value, or each `return`'s, its own. */
export function returnedBy(fn: Answering): readonly Expression[] {
  const { body } = fn;
  if (body === undefined) {
    return [];
  }
  if (!isBlock(body)) {
    return [body];
  }
  const returned: Expression[] = [];
  const visit = (node: Node): void => {
    if (isReturnStatement(node) && node.expression !== undefined) {
      returned.push(node.expression);
    }
    // A function within returns its own.
    if (!isFunctionLike(node)) {
      node.forEachChild(visit);
    }
  };
  body.forEachChild(visit);
  return returned;
}

/**
 * The places of the parameters of `fn` whose types name a type parameter its return type names
 * where a value of it stands — `value` of `identity<T>(value: T): T`, `items` of
 * `first<T>(items: readonly T[]): T` — as a call gives what that type parameter is of what it gives
 * them; none of one that names it in a function's type alone, `(item: T) => boolean`, which a call
 * gives a function of its own.
 */
export function answeredParameters(fn: Answering): readonly number[] {
  const { type, typeParameters } = fn;
  if (type === undefined || typeParameters === undefined) {
    return [];
  }
  const answered = new Set(
    typeParameters.map((each) => each.name.text).filter((name) => mentions(type, new Set([name]))),
  );
  if (answered.size === 0) {
    return [];
  }
  return parametersOf(fn).flatMap((parameter, index) =>
    parameter.type !== undefined && mentions(parameter.type, answered) ? [index] : [],
  );
}

/** The place of the parameter of `fn` that is `name`, or whose pattern binds it; none of another. */
export function parameterNamed(fn: Answering, name: string): number | undefined {
  const index = parametersOf(fn).findIndex((parameter) =>
    bindingIdentifiers(parameter.name).some((each) => each.text === name),
  );
  return index === -1 ? undefined : index;
}

/**
 * What a call, of the arguments `given`, gives the parameter of `fn` at `index`: the argument
 * there, those from there on of a rest parameter, and, past a spread, which may give it any of
 * them, every argument from the spread on — what a spread spreads, as it is.
 */
export function givenAt(
  given: readonly Expression[],
  fn: Answering,
  index: number,
): readonly Expression[] {
  const spread = given.findIndex((each) => isSpreadElement(each));
  const shifted = spread !== -1 && spread <= index;
  const isRest = parametersOf(fn)[index]?.dotDotDotToken !== undefined;
  return given
    .slice(shifted ? spread : index, shifted || isRest ? given.length : index + 1)
    .map((each) => (isSpreadElement(each) ? each.expression : each));
}

/** The kinds of what the code writes that is a value there, never `undefined`. */
const SHOWN: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.ClassExpression,
  SyntaxKind.FalseKeyword,
  SyntaxKind.FunctionExpression,
  SyntaxKind.NewExpression,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TemplateExpression,
  SyntaxKind.TrueKeyword,
]);

/**
 * Whether a call, of the arguments `given`, may give the parameter at `index` nothing — of no
 * argument there, or past a spread, which may hand none — or what may be `undefined`, of which the
 * parameter takes the default the code writes it: all but a value the code shows there (`SHOWN`).
 */
export function omitsAt(given: readonly Expression[], index: number): boolean {
  const spread = given.findIndex((each) => isSpreadElement(each));
  if (spread !== -1 && spread <= index) {
    return true;
  }
  const argument = given[index];
  return argument === undefined || !SHOWN.has(unwrapped(argument).kind);
}

/**
 * The defaults the code writes that the name `name`, which a parameter of `fn` binds, may take: the
 * parameter's own, where the call may give it nothing (`omits`) — of a pattern, what it takes apart
 * — and, of a pattern, each of the elements on the way to the name, which stands in for what the
 * value lacks there.
 */
export function defaultsOf(
  fn: Answering,
  name: string,
  omits: (index: number) => boolean,
): readonly Expression[] {
  const index = parameterNamed(fn, name);
  const parameter = index === undefined ? undefined : parametersOf(fn)[index];
  if (index === undefined || parameter === undefined) {
    return [];
  }
  const own = parameter.initializer !== undefined && omits(index) ? [parameter.initializer] : [];
  return [...own, ...elementDefaults(parameter.name, name)];
}

/** The defaults of the elements of `pattern` on the way to the name `name` it binds. */
function elementDefaults(pattern: BindingName, name: string): readonly Expression[] {
  if (isIdentifier(pattern)) {
    return [];
  }
  return pattern.elements.flatMap((element) => {
    const bound = isBindingElement(element) ? element.name : undefined;
    if (bound === undefined || bindingIdentifiers(bound).every((each) => each.text !== name)) {
      return [];
    }
    const own =
      isBindingElement(element) && element.initializer !== undefined ? [element.initializer] : [];
    return [...own, ...elementDefaults(bound, name)];
  });
}

/** The parameters of `fn` a call gives, by their place: all but a `this` it is typed of. */
export function parametersOf(fn: Answering): readonly ParameterDeclaration[] {
  const [first, ...rest] = fn.parameters;
  return first !== undefined && isIdentifier(first.name) && first.name.text === 'this'
    ? rest
    : fn.parameters;
}

/**
 * Whether the type `node` names one of the type parameters `names` where a value of it stands: not
 * in a function's type, nor a method's, whose values are functions of their own.
 */
function mentions(node: Node, names: ReadonlySet<string>): boolean {
  if (
    isFunctionTypeNode(node) ||
    isConstructorTypeNode(node) ||
    isMethodSignatureDeclaration(node) ||
    isCallSignatureDeclaration(node) ||
    isConstructSignatureDeclaration(node)
  ) {
    return false;
  }
  if (isTypeReferenceNode(node) && isIdentifier(node.typeName) && names.has(node.typeName.text)) {
    return true;
  }
  return node.forEachChild((child) => (mentions(child, names) ? true : undefined)) === true;
}

/** Whether `fn` answers a promise, `async`, or what iterates it, a generator: no JSON. */
export function answersLater(fn: Answering): boolean {
  const isAsync = fn.modifiers?.some((each) => each.kind === SyntaxKind.AsyncKeyword) === true;
  return isAsync || (!isArrowFunction(fn) && fn.asteriskToken !== undefined);
}

/** The names a function declares of its own, and what those it declares once with `const` hold. */
export interface Locals {
  /** Its parameters, its variables, its functions and classes, its own functions' aside. */
  readonly declared: ReadonlySet<string>;
  /** What each name it declares once, with `const`, holds: its initializer. */
  readonly constants: ReadonlyMap<string, Expression>;
}

/** The locals of each function read, as `localsOf` reads them. */
const LOCALS = new WeakMap<Answering, Locals>();

/**
 * The names `fn` declares of its own (`Locals`) — of its body, its own functions' and classes'
 * aside, which a name of theirs is no name of its — so that what it returns is read of them.
 */
export function localsOf(fn: Answering): Locals {
  const known = LOCALS.get(fn);
  if (known !== undefined) {
    return known;
  }
  const counts = new Map<string, number>();
  const constants = new Map<string, Expression>();
  const declare = (name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  for (const parameter of fn.parameters) {
    for (const each of bindingIdentifiers(parameter.name)) {
      declare(each.text);
    }
  }
  const visit = (node: Node): void => {
    if (isVariableDeclaration(node)) {
      for (const each of bindingIdentifiers(node.name)) {
        declare(each.text);
      }
      const list = node.parent;
      if (
        isIdentifier(node.name) &&
        node.initializer !== undefined &&
        isVariableDeclarationList(list) &&
        /^const\s/u.test(list.getText())
      ) {
        constants.set(node.name.text, node.initializer);
      }
    } else if (
      (isFunctionDeclaration(node) || isClassDeclaration(node)) &&
      node.name !== undefined
    ) {
      declare(node.name.text);
    }
    if (!isFunctionLike(node)) {
      node.forEachChild(visit);
    }
  };
  fn.body?.forEachChild(visit);
  const locals: Locals = {
    constants: new Map([...constants].filter(([name]) => counts.get(name) === 1)),
    declared: new Set(counts.keys()),
  };
  LOCALS.set(fn, locals);
  return locals;
}

/** Whether `node` stands within `fn`, where its locals name what it reads. */
export function standsIn(node: Node, fn: Answering): boolean {
  return node.getSourceFile() === fn.getSourceFile() && node.pos >= fn.pos && node.end <= fn.end;
}

/** Whether `node` is a function of its own, whose `return`s are its own. */
function isFunctionLike(node: Node): boolean {
  return (
    isArrowFunction(node) ||
    isFunctionExpression(node) ||
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isClassExpression(node) ||
    isClassDeclaration(node)
  );
}

/** An immediately invoked body runs now only where the function answers synchronously. */
export function eagerBody(node: Node): Node | undefined {
  const invoked = isCallExpression(node) ? unwrapped(node.expression) : undefined;
  return invoked !== undefined &&
    (isArrowFunction(invoked) || isFunctionExpression(invoked)) &&
    !answersLater(invoked)
    ? invoked.body
    : undefined;
}
