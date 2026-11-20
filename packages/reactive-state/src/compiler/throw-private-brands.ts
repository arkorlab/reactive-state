import {
  type CallExpression,
  type ClassLikeDeclaration,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isExpression,
  isExpressionStatement,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isArrowFunction,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isRegularExpressionLiteral,
  isReturnStatement,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadElement,
  isTaggedTemplateExpression,
  type MethodDeclaration,
  type GetAccessorDeclaration,
  type Node,
  type PrivateIdentifier,
  type PropertyDeclaration,
  type SetAccessorDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { literalKey } from './exported-values.ts';
import { metadataParameters } from './input-bindings.ts';
import { metadataCallee } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';
import { writtenBy } from './written.ts';

/** Source-proven private operations, without assuming an unknown receiver has no private brand. */
interface Operation {
  readonly name: PrivateIdentifier;
  readonly receiver: Expression;
  readonly membership: boolean;
  readonly optional: boolean;
}

type NamedMember =
  | MethodDeclaration
  | PropertyDeclaration
  | GetAccessorDeclaration
  | SetAccessorDeclaration;
interface Brand {
  readonly owner: ClassLikeDeclaration;
  readonly member: NamedMember;
}

/** A private read/write needs its owner's brand; private membership rejects primitives alone. */
export function privateBrandThrows(node: Node, resolve: Resolve | undefined): boolean {
  const direct = operationOf(node);
  if (direct !== undefined && operationFails(direct, resolve)) {
    return true;
  }
  const called = calledOperation(node, resolve);
  return called !== undefined && operationFails(called, resolve);
}

/** A private reference, including a simple assignment or update that evaluates that reference. */
function operationOf(node: Node): Operation | undefined {
  let operation = node;
  for (;;) {
    if (isExpression(operation)) {
      operation = unwrapped(operation);
    }
    if (isPostfixUnaryExpression(operation) || isPrefixUnaryExpression(operation)) {
      operation = operation.operand;
    } else if (
      isBinaryExpression(operation) &&
      operation.operatorToken.kind === SyntaxKind.EqualsToken &&
      quiet(operation.right)
    ) {
      operation = operation.left;
    } else {
      break;
    }
  }
  return privateOperation(operation);
}

/** A private membership or reference after its surrounding assignment/update syntax is selected. */
function privateOperation(node: Node): Operation | undefined {
  if (
    isBinaryExpression(node) &&
    node.operatorToken.kind === SyntaxKind.InKeyword &&
    isPrivateIdentifier(node.left)
  ) {
    return { membership: true, name: node.left, optional: false, receiver: node.right };
  }
  if (!isPropertyAccessExpression(node) || !isPrivateIdentifier(node.name)) {
    return undefined;
  }
  const parent = node.parent;
  if (
    isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    !quiet(parent.right)
  ) {
    return undefined;
  }
  return {
    membership: false,
    name: node.name,
    optional: node.questionDotToken !== undefined,
    receiver: node.expression,
  };
}

/** Literal objects lack a base class's instance brand; derived stampers keep aliased values opaque. */
function operationFails(operation: Operation, resolve: Resolve | undefined): boolean {
  const brand = privateBrand(operation.name);
  if (brand === undefined) {
    return false;
  }
  const value = writtenOf(operation.receiver, resolve);
  const held = metadataCallee(value);
  let target = value;
  if (held !== undefined && isExpression(held)) {
    target = held;
  }
  const primitive = primitiveOf(target, resolve);
  if (primitive === 'nothing' && operation.optional) {
    return false;
  }
  if (
    primitive !== undefined ||
    isBigIntWritten(target, resolve) ||
    isSymbolWritten(target, resolve)
  ) {
    return true;
  }
  if (operation.membership) {
    return false;
  }
  if (
    isObjectLiteralExpression(target) ||
    isArrayLiteralExpression(target) ||
    isRegularExpressionLiteral(target)
  ) {
    return !derived(brand.owner) || target === unwrapped(operation.receiver);
  }
  if (held !== undefined && (isClassDeclaration(held) || isClassExpression(held))) {
    return staticMember(brand.member) ? held !== brand.owner : !derived(brand.owner);
  }
  return false;
}

/** The nearest lexical class that declares this private name, including an outer class's name. */
function privateBrand(name: PrivateIdentifier): Brand | undefined {
  for (let at: Node = name.parent; !isSourceFile(at); at = at.parent) {
    if (isClassDeclaration(at) || isClassExpression(at)) {
      const member = at.members.find(
        (each): each is NamedMember =>
          namedMember(each) && isPrivateIdentifier(each.name) && each.name.text === name.text,
      );
      if (member !== undefined) {
        return { member, owner: at };
      }
    }
  }
  return undefined;
}

/** A direct call of a stable simple class's own method, before any preceding body effects. */
function calledOperation(node: Node, resolve: Resolve | undefined): Operation | undefined {
  if (!isCallExpression(node) || node.arguments.some((each) => isSpreadElement(each))) {
    return undefined;
  }
  const method = calledMethod(node, resolve);
  const first = method?.body?.statements[0];
  const expression =
    first !== undefined && (isReturnStatement(first) || isExpressionStatement(first))
      ? first.expression
      : undefined;
  const operation = expression === undefined ? undefined : operationOf(expression);
  if (
    method === undefined ||
    operation === undefined ||
    !isIdentifier(unwrapped(operation.receiver))
  ) {
    return operation;
  }
  const formal = unwrapped(operation.receiver);
  const index = metadataParameters(method).findIndex(
    (each) => isIdentifier(each.name) && each.name.text === formal.getText(),
  );
  const argument = node.arguments[index];
  return index === -1 || argument === undefined ? undefined : { ...operation, receiver: argument };
}

/** A stable simple receiver's own method, without traversing inherited or replaced implementations. */
function calledMethod(
  node: CallExpression,
  resolve: Resolve | undefined,
): MethodDeclaration | undefined {
  const callee = unwrapped(node.expression);
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) {
    return undefined;
  }
  const key = isPropertyAccessExpression(callee)
    ? callee.name.text
    : literalKey(writtenOf(callee.argumentExpression, resolve));
  const receiver = metadataCallee(writtenOf(callee.expression, resolve));
  const made = receiver !== undefined && isNewExpression(receiver);
  const source = made ? metadataCallee(writtenOf(receiver.expression, resolve)) : receiver;
  if (
    key === undefined ||
    source === undefined ||
    (!isClassDeclaration(source) && !isClassExpression(source)) ||
    !simpleClass(source) ||
    changedMethod(source, node)
  ) {
    return undefined;
  }
  return ownMethod(source, key, !made);
}

/** Runtime members that declare an ordinary or private property name. */
function namedMember(node: Node): node is NamedMember {
  return (
    isMethodDeclaration(node) ||
    isPropertyDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)
  );
}

/** Whether a member belongs to the constructor rather than instances. */
function staticMember(member: NamedMember): boolean {
  return member.modifiers?.some((each) => each.kind === SyntaxKind.StaticKeyword) === true;
}

/** The last own entry shadows earlier methods, including instance fields with that same name. */
function ownMethod(
  source: ClassLikeDeclaration,
  key: string,
  staticCall: boolean,
): MethodDeclaration | undefined {
  for (const member of source.members.toReversed()) {
    if (
      !namedMember(member) ||
      (isIdentifier(member.name) ? member.name.text : literalKey(member.name)) !== key
    ) {
      continue;
    }
    if (staticMember(member) !== staticCall) {
      continue;
    }
    return isMethodDeclaration(member) &&
      !answersLater(member) &&
      metadataParameters(member).every((each) => {
        return (
          isIdentifier(each.name) &&
          each.initializer === undefined &&
          each.dotDotDotToken === undefined
        );
      })
      ? member
      : undefined;
  }
  return undefined;
}

/** Only base classes with inert fields, ordinary names and methods have a stable own method proof. */
function simpleClass(source: ClassLikeDeclaration): boolean {
  return (
    !derived(source) &&
    source.members.every((member) => {
      if (
        !namedMember(member) ||
        isComputedPropertyName(member.name) ||
        member.modifiers?.some((each) => each.kind === SyntaxKind.Decorator) === true
      ) {
        return false;
      }
      return (
        isMethodDeclaration(member) ||
        (isPropertyDeclaration(member) &&
          (member.initializer === undefined || quiet(member.initializer)))
      );
    }) &&
    source.modifiers?.some((each) => each.kind === SyntaxKind.Decorator) !== true
  );
}

/** A derived class can install its instance brand on an object a base constructor returns. */
function derived(source: ClassLikeDeclaration): boolean {
  return source.heritageClauses?.some((each) => each.token === SyntaxKind.ExtendsKeyword) === true;
}

/** Earlier application work or writes leave a class's eventual method unproven. */
function changedMethod(source: ClassLikeDeclaration, call: Node): boolean {
  const visit = (node: Node): boolean => {
    if (node.end <= source.end || node.pos >= call.pos) {
      return false;
    }
    if (node.pos >= source.end && node.end <= call.pos && !quiet(node)) {
      return true;
    }
    return node.forEachChild((child) => (visit(child) ? true : undefined)) === true;
  };
  return visit(source.getSourceFile());
}

/** Primitive creation and deferred function values do not invoke application code or write state. */
function quiet(node: Node): boolean {
  if (isArrowFunction(node) || isFunctionExpression(node) || isMethodDeclaration(node)) {
    return true;
  }
  if (
    isCallExpression(node) ||
    isNewExpression(node) ||
    isPropertyAccessExpression(node) ||
    isElementAccessExpression(node) ||
    isTaggedTemplateExpression(node) ||
    isComputedPropertyName(node) ||
    writtenBy(node) !== undefined
  ) {
    return false;
  }
  return node.forEachChild((child) => (quiet(child) ? undefined : true)) !== true;
}
