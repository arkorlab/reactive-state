import {
  type ClassLikeDeclaration,
  type ConstructorDeclaration,
  type Expression,
  type Identifier,
  isArrowFunction,
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
  isObjectLiteralExpression,
  isPrivateIdentifier,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  isStringLiteral,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type PrivateIdentifier,
  type PropertyDeclaration,
  type PropertyName,
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
export function instanceMethods(value: Expression): ReadonlyMap<string, Node> | undefined {
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

/** The surviving methods of a class or its instances, including source-written bases. */
export function memberMethods(
  declared: ClassLikeDeclaration,
  statics: boolean,
): ReadonlyMap<string, Node> {
  const methods = new Map<string, Node>();
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
    }
  }
  return methods;
}

/** The name of a member the code writes: of a name, a private one, or text; none of another. */
export function keyOf(name: PropertyName | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (isPrivateIdentifier(name)) {
    return privateName(name);
  }
  if (isComputedPropertyName(name)) {
    const value = unwrapped(name.expression);
    return isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)
      ? value.text
      : undefined;
  }
  return isIdentifier(name) || isStringLiteral(name) ? name.text : undefined;
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

/** The methods an object the code writes holds of its own, by their names: none of an arrow's. */
function objectMethods(value: ObjectLiteralExpression): ReadonlyMap<string, Node> {
  const methods = new Map<string, Node>();
  for (const property of value.properties) {
    const key = 'name' in property ? keyOf(property.name) : undefined;
    if (key !== undefined && isMethodDeclaration(property)) {
      methods.set(key, property);
    } else if (
      key !== undefined &&
      isPropertyAssignment(property) &&
      isFunctionExpression(unwrapped(property.initializer))
    ) {
      methods.set(key, unwrapped(property.initializer));
    }
  }
  return methods;
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
  methods: Map<string, Node>,
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
      methods.set(key, fn);
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
