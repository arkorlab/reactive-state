import {
  type ClassLikeDeclaration,
  type ConstructorDeclaration,
  type Expression,
  type GetAccessorDeclaration,
  type Identifier,
  isArrowFunction,
  isPropertyAccessExpression,
  isElementAccessExpression,
  isBinaryExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isConstructorDeclaration,
  isExpressionWithTypeArguments,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPrivateIdentifier,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadAssignment,
  isStringLiteral,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PrivateIdentifier,
  type PropertyDeclaration,
  type PropertyName,
  type SetAccessorDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { declarationOf, initializerOf } from './framed.ts';
import { receiverOf } from './this-aliases.ts';

/**
 * The methods an object literal, a class, or a class's instance holds of its own or from its
 * source-written bases (`held-methods.ts`).
 */

/**
 * The methods of what `value` makes, where the code writes it: an object, `{ bump() { … } }`, or an
 * instance of a class of the module's, `new Counter()`; none of another value.
 */
export function instanceMethods(
  value: Expression,
): ReadonlyMap<string, readonly Node[]> | undefined {
  if (isObjectLiteralExpression(value)) {
    return objectMethods(value);
  }
  if (!isNewExpression(value)) {
    return undefined;
  }
  const made = unwrapped(value.expression);
  const declaredClass = isIdentifier(made) ? constructorOf(made) : inlineClass(made);
  if (declaredClass === undefined) {
    return new Map();
  }
  const replacement = returnedObject(declaredClass);
  return replacement === undefined
    ? memberMethods(declaredClass, false)
    : objectMethods(replacement);
}

/**
 * The surviving methods of a class or its instances, including source-written bases: each name holds
 * every body that may run, more than one only where a constructor installs a function beside it.
 */
export function memberMethods(
  declared: ClassLikeDeclaration,
  statics: boolean,
): ReadonlyMap<string, readonly Node[]> {
  const methods = new Map<string, readonly Node[]>();
  const classes = baseClasses(declared);
  for (const each of classes) {
    memberEntries(each, methods, { statics, fields: false });
    if (statics) {
      memberEntries(each, methods, { statics, fields: true });
    }
  }
  if (!statics) {
    for (const each of classes) {
      memberEntries(each, methods, { statics, fields: true });
      constructorCallables(each, methods);
    }
  }
  return methods;
}

/** The methods of the prototype of a class, source-written bases included: what `super.name` finds. */
function prototypeMethods(declared: ClassLikeDeclaration): ReadonlyMap<string, readonly Node[]> {
  const methods = new Map<string, readonly Node[]>();
  for (const each of baseClasses(declared)) {
    memberEntries(each, methods, { statics: false, fields: false });
  }
  return methods;
}

/**
 * The functions a constructor installs on the instance, `this.bump = () => { … }` or `this['bump'] =
 * function () { … }`, each one more body the name may hold, beside what it held: the constructor may
 * return before the assignment, wrap the method it replaces, or assign on a path that does not run, so
 * an install never takes a body away. A value that is no function written there leaves what the name
 * held, and the functions the constructor defines, which run later, install nothing.
 */
function constructorCallables(
  declared: ClassLikeDeclaration,
  methods: Map<string, readonly Node[]>,
): void {
  const constructor = declared.members.find(
    (member): member is ConstructorDeclaration =>
      isConstructorDeclaration(member) && member.body !== undefined,
  );
  const visit = (node: Node): void => {
    if (isArrowFunction(node) || ownsThis(node)) {
      return;
    }
    if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
      const key = installedKey(unwrapped(node.left));
      const value = unwrapped(node.right);
      if (key !== undefined && (isArrowFunction(value) || isFunctionExpression(value))) {
        methods.set(key, [...(methods.get(key) ?? []), value]);
      }
    }
    node.forEachChild(visit);
  };
  constructor?.body?.forEachChild(visit);
}

/** The member `this.name` or `this['name']` names, as text. */
function installedKey(target: Expression): string | undefined {
  if (!isPropertyAccessExpression(target) && !isElementAccessExpression(target)) {
    return undefined;
  }
  if (target.expression.kind !== SyntaxKind.ThisKeyword) {
    return undefined;
  }
  return isPropertyAccessExpression(target)
    ? keyOf(target.name)
    : literalKey(unwrapped(target.argumentExpression));
}

/** A static string, template or numeric property key as its runtime property name. */
export function literalKey(node: Node): string | undefined {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return isNumericLiteral(node) ? String(Number(node.text)) : undefined;
}

/** The name of a member the code writes: of a name, a private one, text, or a number. */
export function keyOf(name: PropertyName | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (isPrivateIdentifier(name)) {
    return privateName(name);
  }
  if (isComputedPropertyName(name)) {
    return literalKey(unwrapped(name.expression));
  }
  return isIdentifier(name) ? name.text : literalKey(name);
}

/** Whether `node` is code of a `this` of its own: a function but an arrow, a class. */
export function ownsThis(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isClassDeclaration(node) ||
    isClassExpression(node)
  );
}

/**
 * What `node`, code of a `this` of its own, runs where it is defined, with the `this` around it: a
 * class's `extends` expression and its computed member names, a function's or method's computed
 * name — `class extends this.base() {}`, `{ [this.next()]() {} }`.
 */
export function definedExpressions(node: Node): readonly Expression[] {
  if (isClassDeclaration(node) || isClassExpression(node)) {
    return heritageExpressions(node);
  }
  const name =
    isMethodDeclaration(node) || isGetAccessorDeclaration(node) || isSetAccessorDeclaration(node)
      ? node.name
      : undefined;
  return name !== undefined && isComputedPropertyName(name) ? [name.expression] : [];
}

/** A class's `extends` expression, then the computed names of its members. */
function heritageExpressions(declared: ClassLikeDeclaration): readonly Expression[] {
  const found: Expression[] = [];
  const clauses = declared.heritageClauses;
  if (clauses !== undefined) {
    for (const clause of clauses) {
      const types = clause.token === SyntaxKind.ExtendsKeyword ? clause.types : [];
      for (const type of types) {
        if (isExpressionWithTypeArguments(type)) {
          found.push(type.expression);
        }
      }
    }
  }
  return [...found, ...memberNameExpressions(declared)];
}

/** The expressions of the computed names of a class's methods, fields and accessors. */
function memberNameExpressions(declared: ClassLikeDeclaration): readonly Expression[] {
  const found: Expression[] = [];
  for (const member of declared.members) {
    const name = isNamedMember(member) ? member.name : undefined;
    if (name !== undefined && isComputedPropertyName(name)) {
      found.push(name.expression);
    }
  }
  return found;
}

/** Whether `member` is a method, a field or an accessor, which a computed name may name. */
function isNamedMember(
  member: Node,
): member is
  | GetAccessorDeclaration
  | MethodDeclaration
  | PropertyDeclaration
  | SetAccessorDeclaration {
  return (
    isMethodDeclaration(member) ||
    isPropertyDeclaration(member) ||
    isGetAccessorDeclaration(member) ||
    isSetAccessorDeclaration(member)
  );
}

/**
 * The methods `super.key` may run where `at` stands: those the prototype of the base class of the class
 * around it keeps (its statics for a `static` member), past its own bases, which no own member of an
 * instance shadows; every public one when `key` is not text.
 */
export function superMethods(at: Node, key: string | undefined): readonly Node[] {
  const around = memberAround(at);
  const base = around === undefined ? undefined : baseClass(around.home);
  if (around === undefined || base === undefined) {
    return [];
  }
  const methods = around.isStatic ? memberMethods(base, true) : prototypeMethods(base);
  if (key !== undefined) {
    return methods.get(key) ?? [];
  }
  return [...methods].filter(([name]) => !name.startsWith('#')).flatMap(([, bodies]) => bodies);
}

/** The class `at` stands in, and whether the member of it that holds `at` is `static`. */
function memberAround(
  at: Node,
): { readonly home: ClassLikeDeclaration; readonly isStatic: boolean } | undefined {
  for (let member: Node = at; !isSourceFile(member.parent); member = member.parent) {
    const home = member.parent;
    if (isClassDeclaration(home) || isClassExpression(home)) {
      const isStatic =
        isNamedMember(member) &&
        member.modifiers?.some((each) => each.kind === SyntaxKind.StaticKeyword) === true;
      return { home, isStatic };
    }
  }
  return undefined;
}

/** A constructor's sole unconditional returned literal replaces the instance and its methods. */
function returnedObject(declared: ClassLikeDeclaration): ObjectLiteralExpression | undefined {
  const constructor = declared.members.find(
    (member): member is ConstructorDeclaration =>
      isConstructorDeclaration(member) && member.body !== undefined,
  );
  const body = constructor?.body;
  const last = body?.statements.at(-1);
  if (body === undefined || last === undefined || !isReturnStatement(last)) {
    return undefined;
  }
  const value = last.expression === undefined ? undefined : unwrapped(last.expression);
  if (value === undefined || !isObjectLiteralExpression(value) || unknownReplacement(value)) {
    return undefined;
  }
  const otherReturns = new Set<Node>();
  const visit = (node: Node): void => {
    if (otherReturns.size > 0 || (node !== body && (ownsThis(node) || isArrowFunction(node)))) {
      return;
    }
    if (node !== last && isReturnStatement(node)) {
      otherReturns.add(node);
      return;
    }
    node.forEachChild(visit);
  };
  visit(body);
  return otherReturns.size === 0 ? value : undefined;
}

/** Accessors, spreads and constructor-this closures do not establish the returned own methods. */
function unknownReplacement(value: ObjectLiteralExpression): boolean {
  return value.properties.some((property) => {
    if (
      isGetAccessorDeclaration(property) ||
      isSetAccessorDeclaration(property) ||
      isSpreadAssignment(property)
    ) {
      return true;
    }
    const fn = isPropertyAssignment(property) ? unwrapped(property.initializer) : undefined;
    if (fn === undefined || !isArrowFunction(fn)) {
      return false;
    }
    const captured = new Set<Node>();
    const visit = (node: Node): void => {
      if (receiverOf(node)) {
        captured.add(node);
      } else if (!ownsThis(node)) {
        node.forEachChild(visit);
      }
    };
    visit(fn);
    return captured.size > 0;
  });
}

/** The lexical class a name declares or aliases, with alias cycles left unknown. */
function constructorOf(name: Identifier): ClassLikeDeclaration | undefined {
  let value: Expression = name;
  const seen = new Set<Expression>();
  while (!seen.has(value)) {
    seen.add(value);
    if (isClassExpression(value)) {
      return value;
    }
    if (!isIdentifier(value)) {
      return undefined;
    }
    const declared = declarationOf(value);
    if (declared !== undefined && isClassDeclaration(declared)) {
      return declared;
    }
    const initializer = initializerOf(value);
    if (initializer === undefined) {
      return undefined;
    }
    value = unwrapped(initializer);
  }
  return undefined;
}

/**
 * The methods an object the code writes holds of its own, by their names: none of an arrow's; those
 * of an object it spreads, which a later property of the same name replaces.
 */
function objectMethods(value: ObjectLiteralExpression): ReadonlyMap<string, readonly Node[]> {
  const methods = new Map<string, readonly Node[]>();
  const entries = objectEntries(value, new Set());
  for (const [key, method] of entries) {
    if (method !== undefined) {
      methods.set(key, [method]);
    }
  }
  return methods;
}

/**
 * What each named property of an object the code writes holds, in property order: the method it is,
 * or none where it is any other value, a function the code does not write there, or an accessor,
 * which replaces what a property of the name before it, or a spread before it, held.
 */
function objectEntries(
  value: ObjectLiteralExpression,
  spreading: ReadonlySet<Node>,
): ReadonlyMap<string, Node | undefined> {
  const entries = new Map<string, Node | undefined>();
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) {
      for (const [key, method] of spreadEntries(property.expression, spreading)) {
        entries.set(key, method);
      }
      continue;
    }
    const key = 'name' in property ? keyOf(property.name) : undefined;
    if (key !== undefined) {
      entries.set(key, propertyMethod(property));
    }
  }
  return entries;
}

/** The method a property of an object literal is: a method, or a function the property is given. */
function propertyMethod(property: ObjectLiteralElementLike): Node | undefined {
  if (isMethodDeclaration(property)) {
    return property;
  }
  if (!isPropertyAssignment(property)) {
    return undefined;
  }
  const given = unwrapped(property.initializer);
  return isFunctionExpression(given) ? given : undefined;
}

/** The entries of the object literal `source` is, through constant aliases; none of another value. */
function spreadEntries(
  source: Expression,
  spreading: ReadonlySet<Node>,
): ReadonlyMap<string, Node | undefined> {
  let value = unwrapped(source);
  const seen = new Set<Node>(spreading);
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const initializer = initializerOf(value);
    if (initializer === undefined) {
      return new Map();
    }
    value = unwrapped(initializer);
  }
  if (!isObjectLiteralExpression(value) || seen.has(value)) {
    return new Map();
  }
  return objectEntries(value, new Set([...seen, value]));
}

/** Known source-written bases, first, with alias and heritage cycles ending the walk. */
function baseClasses(declared: ClassLikeDeclaration): readonly ClassLikeDeclaration[] {
  const classes: ClassLikeDeclaration[] = [];
  const seen = new Set<ClassLikeDeclaration>();
  let current: ClassLikeDeclaration | undefined = declared;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    classes.unshift(current);
    current = baseClass(current);
  }
  return classes;
}

/** A class's explicit extends value, when its lexical source identifies another class. */
function baseClass(declared: ClassLikeDeclaration): ClassLikeDeclaration | undefined {
  const clauses = declared.heritageClauses;
  if (clauses === undefined) {
    return undefined;
  }
  for (const clause of clauses) {
    if (clause.token !== SyntaxKind.ExtendsKeyword) {
      continue;
    }
    for (const type of clause.types) {
      if (isExpressionWithTypeArguments(type)) {
        const value = unwrapped(type.expression);
        return isIdentifier(value) ? constructorOf(value) : inlineClass(value);
      }
    }
  }
  return undefined;
}

/** An inline class is a known base; calls and other heritage values remain unknown. */
function inlineClass(value: Expression): ClassLikeDeclaration | undefined {
  return isClassExpression(value) ? value : undefined;
}

/** Own prototype entries precede instance fields; a surviving nonfunction also shadows a base. */
function memberEntries(
  declared: ClassLikeDeclaration,
  methods: Map<string, readonly Node[]>,
  phase: { readonly statics: boolean; readonly fields: boolean },
): void {
  for (const member of declared.members) {
    if (
      (!isMethodDeclaration(member) &&
        !isPropertyDeclaration(member) &&
        !isGetAccessorDeclaration(member) &&
        !isSetAccessorDeclaration(member)) ||
      isPropertyDeclaration(member) !== phase.fields ||
      typeOnlyField(member)
    ) {
      continue;
    }
    const key = keyOf(member.name);
    const isStatic =
      member.modifiers?.some((each) => each.kind === SyntaxKind.StaticKeyword) === true;
    if (key === undefined || isStatic !== phase.statics) {
      continue;
    }
    const fn =
      isMethodDeclaration(member) || isPropertyDeclaration(member)
        ? memberFunction(member)
        : undefined;
    if (fn === undefined) {
      methods.delete(key);
    } else {
      methods.set(key, [fn]);
    }
  }
}

/** A declared or abstract field contributes no runtime instance or static entry. */
function typeOnlyField(member: Node): boolean {
  return (
    isPropertyDeclaration(member) &&
    member.modifiers?.some(
      (each) => each.kind === SyntaxKind.DeclareKeyword || each.kind === SyntaxKind.AbstractKeyword,
    ) === true
  );
}

/** The function a member of a class is: a method, or a property of an arrow or a function. */
function memberFunction(member: MethodDeclaration | PropertyDeclaration): Node | undefined {
  if (isMethodDeclaration(member)) {
    return member;
  }
  const value = member.initializer === undefined ? undefined : unwrapped(member.initializer);
  return value !== undefined && (isArrowFunction(value) || isFunctionExpression(value))
    ? value
    : undefined;
}

/** Private names belong to their declaring class rather than shadowing a base's same spelling. */
function privateName(name: PrivateIdentifier): string {
  let owner: Node = name.parent;
  while (!isClassDeclaration(owner) && !isClassExpression(owner)) {
    owner = owner.parent;
  }
  return `${name.text}@${owner.pos}`;
}
