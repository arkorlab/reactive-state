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
  isExpression,
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
  isPropertyAssignment,
  isPropertyDeclaration,
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
import { unreferencedLocalFunction } from './framed-function-references.ts';
import { repeatedFrameRead } from './framed-writes.ts';
import { readsBinding } from './scope.ts';

/** A source holder read by a later execution cannot rely on its earlier textual prefix alone. */

interface QuietProof {
  readonly member: (value: Expression) => boolean;
  readonly quiet: (call: CallExpression) => boolean;
}

/**
 * Other execution owners can see writes or escapes appearing anywhere in the holder's source. So
 * does a loop around the reference that passes again: its next pass reads what the rest of the
 * loop, and the functions the loop may run, made of the holder.
 */
export function deferredArrayChange(
  reference: Identifier,
  binding: FrameBinding | FunctionDeclaration,
  proof: QuietProof,
): boolean {
  const owner = executionOwner(reference);
  const deferred = owner !== executionOwner(binding);
  if (!deferred && !repeatedFrameRead(reference, reference, binding, owner)) return false;
  const pending: Node[] = [binding.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeNode(node)) continue;
    if (
      isIdentifier(node) &&
      node !== binding.name &&
      node.text === reference.text &&
      readsBinding(node) &&
      frameDeclarationOf(node) === binding &&
      (deferred || betweenPasses(node, reference, binding, owner)) &&
      changedUse(node, isFunctionDeclaration(binding), proof, !deferred && node === reference)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * Whether `use` of the holder can come between two passes of the loop around `reference`: one in
 * the loop's repeated parts, or in another function, unless that is a local declaration nothing
 * refers to.
 */
function betweenPasses(
  use: Identifier,
  reference: Identifier,
  binding: FrameBinding | FunctionDeclaration,
  owner: Node,
): boolean {
  const writer = executionOwner(use);
  return writer === owner
    ? repeatedFrameRead(use, reference, binding, owner)
    : !unreferencedLocalFunction(writer, owner);
}

/**
 * A function body is deferred; its computed name and synchronous immediate invocation without
 * arguments are not. A call's arguments run before the body it invokes, though they are written
 * after it, so a body called with arguments keeps an order of its own. An instance field's
 * initializer is deferred too, run at each construction; a static one's runs where its class is
 * defined.
 */
export function executionOwner(node: Node): Node {
  for (let parent = node.parent, within: Node = node; ; within = parent, parent = parent.parent) {
    if (isSourceFile(parent) || instanceInitializer(parent, within)) return parent;
    if (
      !isAnswering(parent) &&
      !isConstructorDeclaration(parent) &&
      !isSetAccessorDeclaration(parent)
    )
      continue;
    const regions: readonly (Node | undefined)[] = [parent.body, ...parent.parameters];
    if (!regions.includes(within)) continue;
    const { parent: use } = useOf(parent);
    if (!isCallExpression(use) || use.arguments.length > 0 || eagerBody(use) !== parent.body)
      return parent;
  }
}

/** Whether `within` is the initializer of the instance field `parent`, which a construction runs. */
function instanceInitializer(parent: Node, within: Node): boolean {
  return (
    isPropertyDeclaration(parent) &&
    isExpression(within) &&
    within === parent.initializer &&
    parent.modifiers?.some((each) => each.kind === SyntaxKind.StaticKeyword) !== true
  );
}

/**
 * Function declarations need binding writes; mutable objects also lose proof when handed away. The
 * `proven` use is the read the proof is of: where a pattern takes the holder apart, it hands it
 * nowhere.
 */
function changedUse(
  name: Identifier,
  functionBinding: boolean,
  proof: QuietProof,
  proven: boolean,
): boolean {
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
  if (member === undefined) return !proven;
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
