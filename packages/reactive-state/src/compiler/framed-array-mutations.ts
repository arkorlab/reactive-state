import {
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isConstructorDeclaration,
  isDeleteExpression,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isFunctionDeclaration,
  isIdentifier,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isPropertyAssignment,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isTypeAssertion,
  isTypeNode,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { eagerBody, isAnswering } from './answers.ts';
import { useOf } from './code-globals.ts';
import { frameDeclarationOf, type FrameBinding } from './framed-bindings.ts';
import { readsBinding } from './scope.ts';

/** A source holder read by a later execution cannot rely on its earlier textual prefix alone. */

interface QuietProof {
  readonly member: (value: Expression) => boolean;
  readonly quiet: (call: CallExpression) => boolean;
}

/** Other execution owners can see writes or escapes appearing anywhere in the holder's source. */
export function deferredArrayChange(
  reference: Identifier,
  binding: FrameBinding | FunctionDeclaration,
  proof: QuietProof,
): boolean {
  if (executionOwner(reference) === executionOwner(binding)) return false;
  const pending: Node[] = [binding.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (
      isIdentifier(node) &&
      node !== binding.name &&
      node.text === reference.text &&
      readsBinding(node) &&
      frameDeclarationOf(node) === binding &&
      changedUse(node, isFunctionDeclaration(binding), proof)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * A function body is deferred; its computed name and synchronous immediate invocation are not. The
 * initializer of an instance field is deferred as well: it runs when an instance is made.
 */
export function executionOwner(node: Node): Node {
  for (let parent = node.parent, within: Node = node; ; within = parent, parent = parent.parent) {
    if (isSourceFile(parent)) return parent;
    if (instanceInitializer(parent) === within) return parent;
    if (
      !isAnswering(parent) &&
      !isConstructorDeclaration(parent) &&
      !isSetAccessorDeclaration(parent)
    )
      continue;
    const regions: readonly (Node | undefined)[] = [parent.body, ...parent.parameters];
    if (!regions.includes(within)) continue;
    const { parent: use } = useOf(parent);
    if (!isCallExpression(use) || eagerBody(use) !== parent.body) return parent;
  }
}

/** The initializer of an instance field, which runs when an instance is made. */
export function instanceInitializer(node: Node): Node | undefined {
  const instance =
    isPropertyDeclaration(node) &&
    node.modifiers?.some((each) => each.kind === SyntaxKind.StaticKeyword) !== true;
  return instance ? node.initializer : undefined;
}

/** Function declarations need binding writes; mutable objects also lose proof when handed away. */
function changedUse(name: Identifier, functionBinding: boolean, proof: QuietProof): boolean {
  let target: Node = name;
  while (transparent(target.parent)) target = target.parent;
  let member: Expression | undefined;
  if (!functionBinding) {
    while (memberReceiver(target)) {
      member = target.parent;
      target = member;
      while (transparent(target.parent)) target = target.parent;
    }
  }
  if (writtenTarget(target)) return true;
  if (functionBinding) return false;
  if (member === undefined) return true;
  if (isCallExpression(target.parent) && target.parent.expression === target)
    return !proof.quiet(target.parent);
  return !proof.member(member);
}

/** The identifier or a selected object's field is the target, never a member's key. */
function memberReceiver(node: Node): node is Node & {
  readonly parent: Expression & { readonly expression: Expression };
} {
  const parent = node.parent;
  return (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

/** Direct, pattern, unary, loop and delete writes all replace the selected source value. */
function writtenTarget(node: Node): boolean {
  let target = node;
  while (assignmentContainer(target)) target = target.parent;
  const parent = target.parent;
  if (isBinaryExpression(parent) && parent.left === target) {
    const kind = parent.operatorToken.kind;
    return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
  }
  if (isForInStatement(parent) || isForOfStatement(parent)) return parent.initializer === target;
  if (isDeleteExpression(parent)) return true;
  return (
    (isPrefixUnaryExpression(parent) || isPostfixUnaryExpression(parent)) &&
    (parent.operator === SyntaxKind.PlusPlusToken || parent.operator === SyntaxKind.MinusMinusToken)
  );
}

/** Wrappers and assignment patterns retain their target while ordinary value reads stop here. */
function assignmentContainer(target: Node): boolean {
  const parent = target.parent;
  return (
    transparent(parent) ||
    isArrayLiteralExpression(parent) ||
    isObjectLiteralExpression(parent) ||
    isSpreadElement(parent) ||
    isSpreadAssignment(parent) ||
    (isPropertyAssignment(parent) && parent.initializer === target) ||
    (isShorthandPropertyAssignment(parent) && parent.name === target)
  );
}

/** Transparent expression syntax retains the same mutable identity. */
function transparent(node: Node): boolean {
  return (
    isAsExpression(node) ||
    isTypeAssertion(node) ||
    isParenthesizedExpression(node) ||
    isNonNullExpression(node) ||
    isSatisfiesExpression(node)
  );
}
