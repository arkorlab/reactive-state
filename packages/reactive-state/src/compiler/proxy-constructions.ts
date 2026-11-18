import {
  type ClassElement,
  type ClassLikeDeclaration,
  type ConstructorDeclaration,
  type Expression,
  isArrowFunction,
  isBinaryExpression,
  isClassDeclaration,
  isClassExpression,
  isConstructorDeclaration,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isReturnStatement,
  isSetAccessorDeclaration,
  isSpreadElement,
  isStringLiteral,
  type NewExpression,
  type Node,
  type PropertyDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { literalName } from './bounded.ts';
import { peelPlatform } from './platform-uses.ts';
import { type Origin } from './proxy-values.ts';
import { declaredLineage, resolveLocalClass } from './settled-receivers.ts';

/**
 * What `new C(…)` of a local class can hold: what each constructor of its `extends` chain returns
 * by a `return`, what its fields are initialised to and what a constructor assigns to `this.name`,
 * and, where a constructor takes parameters, the arguments, which it may store or return. A
 * constructor that returns a value gives it in place of the instance (`return new Proxy(this, {})`).
 * Fields a method assigns later are not read.
 */
export function constructedOrigins(call: NewExpression, at: Origin): readonly Origin[] {
  const declared = resolveLocalClass(call.expression);
  const lineage = declared === undefined ? [] : declaredLineage(declared);
  const origins = lineage.flatMap((each) => linkOrigins(each, at));
  const takesParameters = lineage.some((each) =>
    constructorsOf(each).some((ctor) => ctor.parameters.length > 0),
  );

  return takesParameters ? [...origins, ...argumentOrigins(call, at)] : origins;
}

/** The constructors with a body that `declared` writes. */
function constructorsOf(declared: ClassLikeDeclaration): readonly ConstructorDeclaration[] {
  return declared.members.filter(
    (member): member is ConstructorDeclaration =>
      isConstructorDeclaration(member) && member.body !== undefined,
  );
}

/** What one link of the chain gives the instance: its constructors' and its fields'. */
function linkOrigins(declared: ClassLikeDeclaration, at: Origin): readonly Origin[] {
  const fields = declared.members.flatMap((member) => {
    return isInstanceField(member) && member.initializer !== undefined
      ? fieldOrigins(fieldName(member.name), member.initializer, at)
      : [];
  });

  return [...constructorsOf(declared).flatMap((ctor) => constructorOrigins(ctor, at)), ...fields];
}

/** Whether `member` declares a field of each instance, which a `static` one is not. */
function isInstanceField(member: ClassElement): member is PropertyDeclaration {
  return (
    isPropertyDeclaration(member) &&
    member.modifiers?.every((each) => each.kind !== SyntaxKind.StaticKeyword) !== false
  );
}

/** The arguments of a construction, each as a value the instance may hold at any key. */
function argumentOrigins(call: NewExpression, at: Origin): readonly Origin[] {
  return (call.arguments ?? []).map((argument) => {
    const value = isSpreadElement(argument) ? argument.expression : argument;

    return { ...at, excluded: undefined, keys: [], spread: undefined, value };
  });
}

/** What a constructor's own code gives the instance: the values it returns and the fields it sets. */
function constructorOrigins(ctor: ConstructorDeclaration, at: Origin): readonly Origin[] {
  const found: Origin[] = [];
  const visit = (node: Node, within: boolean): void => {
    if (!within && isReturnStatement(node) && node.expression !== undefined) {
      found.push({ ...at, value: node.expression });
    } else if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
      const written = thisMember(node.left);
      if (written !== undefined) {
        found.push(...fieldOrigins(written.name, node.right, at));
      }
    }
    // A function within returns for its own caller; what it assigns to `this` is only an arrow's.
    if (!isFunctionOfItsOwn(node) || isArrowFunction(node)) {
      const inner = within || isFunctionOfItsOwn(node);
      node.forEachChild((child) => {
        visit(child, inner);
      });
    }
  };
  ctor.body?.forEachChild((child) => {
    visit(child, false);
  });

  return found;
}

/** Whether `node` is a function or class whose `return`s are its own. */
function isFunctionOfItsOwn(node: Node): boolean {
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

/** The member `this.name` or `this['name']` a target writes; `name` is undefined where computed. */
function thisMember(target: Expression): { readonly name: string | undefined } | undefined {
  const clean = peelPlatform(target);
  if (isPropertyAccessExpression(clean) && clean.expression.kind === SyntaxKind.ThisKeyword) {
    return { name: clean.name.text };
  }
  if (isElementAccessExpression(clean) && clean.expression.kind === SyntaxKind.ThisKeyword) {
    return { name: literalName(clean) };
  }
  return undefined;
}

/** The text a field is declared by; none for a computed name. */
function fieldName(name: Node): string | undefined {
  return isIdentifier(name) || isStringLiteral(name) ? name.text : undefined;
}

/** `value` as the field `name` of the instance, projected by the keys the read of the instance has. */
function fieldOrigins(name: string | undefined, value: Expression, at: Origin): readonly Origin[] {
  const [key, ...rest] = at.keys;
  const base = { ...at, excluded: undefined, spread: undefined, value };
  if (key === undefined) {
    return [{ ...base, keys: [] }];
  }
  const selected = name === undefined || key === null || key === name;

  return selected ? [{ ...base, keys: rest }] : [];
}
