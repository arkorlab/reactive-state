import {
  type CallExpression,
  type ClassElement,
  type Expression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isDeleteExpression,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isSpreadAssignment,
  isSetAccessorDeclaration,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  type Node,
  type ObjectLiteralElementLike,
  type PropertyName,
  type SourceFile,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { frameMemberName } from './framed-bindings.ts';
import { framedKeyNames } from './framed-keys.ts';
import { prototypeMayChange } from './framed-prototype-changes.ts';
import { isWrittenMember } from './framed-written-members.ts';
import { constantValue } from './numbers.ts';

/** What a file may give the methods of an array: one of its own, or another inherited. */

const OVERRIDDEN = new WeakMap<SourceFile, Map<string, boolean>>();

/** A call of a native object mutator, with the arguments it is given. */
export type MutatorOf = (
  call: CallExpression,
) => { readonly args: readonly Expression[] } | undefined;

/**
 * Whether the method of an array of this name may be one the code writes: the file gives an array
 * another prototype, or writes a member of that name, or one a name it cannot read may be, or has an
 * object with a field or a text of the name that a native mutator may copy, or gives a mutator a
 * source it cannot read. Where it is not, what an array answers to the name is the native method.
 */
export function methodMayBeOverridden(
  file: SourceFile,
  method: string,
  mutatorOf: MutatorOf,
): boolean {
  const known = OVERRIDDEN.get(file) ?? new Map<string, boolean>();
  OVERRIDDEN.set(file, known);
  const found = known.get(method);
  if (found !== undefined) return found;
  let may = prototypeMayChange(file);
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined && !may; node = pending.pop()) {
    may =
      namedOf(node, method) ||
      writesMember(node, method) ||
      (isCallExpression(node) && givesUnreadSource(node, mutatorOf));
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  known.set(method, may);
  return may;
}

/**
 * Whether a node is a text of the name, or an object or a class with a member the name, or a name
 * that may be it, writes.
 */
function namedOf(node: Node, method: string): boolean {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return node.text === method;
  if (isTemplateExpression(node)) return constantValue(node) === method;
  if (isClassDeclaration(node) || isClassExpression(node))
    return node.members.some((member) => memberMayBe(declaredMemberName(member), method));
  if (!isObjectLiteralExpression(node)) return false;
  return node.properties.some((property) => fieldMayBe(property, method));
}

/** Whether a field of an object written out is named by the name, or by one the code does not write. */
function fieldMayBe(property: ObjectLiteralElementLike, method: string): boolean {
  return !isSpreadAssignment(property) && memberMayBe(property.name, method);
}

/** The name of a member of a class that gives a method, an accessor or a field: none for the others. */
function declaredMemberName(member: ClassElement): PropertyName | undefined {
  const named =
    isMethodDeclaration(member) ||
    isGetAccessorDeclaration(member) ||
    isSetAccessorDeclaration(member) ||
    isPropertyDeclaration(member);
  return named ? member.name : undefined;
}

/**
 * Whether the name of a field of an object, or of a member of a class (a method, an accessor, a property,
 * static or not), is the name, or a name the code does not write. A member without a name, a constructor
 * and a private name, is none.
 */
function memberMayBe(name: PropertyName | undefined, method: string): boolean {
  if (name === undefined) return false;
  if (!isComputedPropertyName(name)) return writtenArrayKey(name) === method;
  const names = framedKeyNames(name.expression);
  return names === undefined || names.includes(method);
}

/** Whether a node writes, steps or deletes a member of the name, or of a name that may be it. */
function writesMember(node: Node, method: string): boolean {
  if (!isPropertyAccessExpression(node) && !isElementAccessExpression(node)) return false;
  const { parent } = node;
  const changed =
    isWrittenMember(node) ||
    isDeleteExpression(parent) ||
    isPrefixUnaryExpression(parent) ||
    isPostfixUnaryExpression(parent);
  if (!changed) return false;
  const name = frameMemberName(node);
  if (name !== undefined) return name === method;
  const names = isElementAccessExpression(node)
    ? framedKeyNames(node.argumentExpression)
    : undefined;
  return names === undefined || names.includes(method);
}

/** Whether a call of a native mutator copies from, or defines by, something that is not written out. */
function givesUnreadSource(call: CallExpression, mutatorOf: MutatorOf): boolean {
  const invoked = mutatorOf(call);
  if (invoked === undefined) return false;
  const [, ...rest] = invoked.args;
  return rest.some((each) => {
    const value = unwrapped(each);
    return isSpreadElement(each) || !(isObjectLiteralExpression(value) || constantOf(value));
  });
}

/** Whether a mutator's argument is a number, a text, or nothing: a key or a value, no source of members. */
function constantOf(value: Expression): boolean {
  return constantValue(value) !== undefined;
}
