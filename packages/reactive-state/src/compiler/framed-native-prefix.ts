import {
  type ArrowFunction,
  type CallExpression,
  type ConstructorDeclaration,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type GetAccessorDeclaration,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isConstructorDeclaration,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNonNullExpression,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isTypeAssertion,
  isTemplateExpression,
  isVariableDeclaration,
  type MethodDeclaration,
  type NewExpression,
  type Node,
  type ParameterDeclaration,
  type SetAccessorDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { destructuredFirst, patternAfter } from './destructuring-order.ts';
import { isTypeOnly } from './scope.ts';

/** A new native origin cannot cross opaque earlier work in its immediate execution owner. */

export interface FramedOwnerPrefixProof {
  readonly parameter?: (value: ParameterDeclaration) => boolean;
  readonly primitive: (value: Expression) => boolean;
  readonly value?: (value: Expression) => boolean;
  readonly call?: (node: CallExpression) => boolean;
  readonly construct?: (node: NewExpression) => boolean;
  readonly spread?: (value: Expression) => boolean;
  /**
   * Whether work in what a destructuring pattern around the consumer destructures — which runs
   * first, though written after — is earlier work too: for a proof that reads written values.
   */
  readonly reached?: boolean;
}

type PrefixOwner =
  | ArrowFunction
  | FunctionDeclaration
  | FunctionExpression
  | MethodDeclaration
  | GetAccessorDeclaration
  | SetAccessorDeclaration
  | ConstructorDeclaration;

/** A captured source belongs to the consumer only when both have the same known immediate owner. */
export function framedPrefixSameOwner(source: Node, consumer: Node): boolean {
  const owner = prefixOwner(consumer);
  return owner !== undefined && prefixOwner(source) === owner;
}

/** Callers separately qualify the consumer's full argument evaluation and native conversions. */
export function framedQuietOwnerPrefix(
  consumer: Expression,
  proof: FramedOwnerPrefixProof,
): boolean {
  const owner = prefixOwner(consumer);
  if (
    owner?.body === undefined ||
    isConstructorDeclaration(owner) ||
    owner.parameters.some((parameter) => {
      return (
        (!isIdentifier(parameter.name) || parameter.initializer !== undefined) &&
        proof.parameter?.(parameter) !== true
      );
    })
  )
    return false;
  const pending: Node[] = [owner.body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const first = reachedFirst(node, consumer, proof);
    if (outsidePrefix(node, consumer, first)) continue;
    if (callable(node)) {
      const name = 'name' in node ? node.name : undefined;
      if (name !== undefined && isComputedPropertyName(name)) pending.push(name);
      continue;
    }
    if (!quietPrefixNode(node, consumer, proof, first)) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Work in what a pattern around the consumer destructures, where the proof counts it as earlier. */
function reachedFirst(node: Node, consumer: Expression, proof: FramedOwnerPrefixProof): boolean {
  return proof.reached === true && destructuredFirst(node, consumer);
}

/**
 * The consumer, work written after it and types stay out of its prefix — but for work `first` in what
 * a pattern around it destructures — and so does a pattern whose own source holds the consumer.
 */
function outsidePrefix(node: Node, consumer: Expression, first: boolean): boolean {
  return (
    node === consumer ||
    (!first && node.pos >= consumer.pos) ||
    isTypeOnly(node) ||
    patternAfter(node, consumer)
  );
}

/** Computed callable names belong to their enclosing owner; bodies and parameters do not. */
function prefixOwner(node: Node): PrefixOwner | undefined {
  for (let parent = node.parent, within = node; ; within = parent, parent = parent.parent) {
    if (isSourceFile(parent) || isPropertyDeclaration(parent)) return undefined;
    if (!callable(parent)) continue;
    const regions: readonly (Node | undefined)[] = [parent.body, ...parent.parameters];
    if (regions.includes(within)) return parent;
  }
}

/** Deferred function creation does not execute its body or parameter initialization. */
function callable(node: Node): node is PrefixOwner {
  return (
    isArrowFunction(node) ||
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node)
  );
}

/** Repeated work and implicit application evaluation lose the added origin proof. */
function quietPrefixNode(
  node: Node,
  consumer: Expression,
  proof: FramedOwnerPrefixProof,
  first: boolean,
): boolean {
  const completed = first || node.end <= consumer.pos;
  if (opaqueBoundary(node, completed)) return false;
  if (isVariableDeclaration(node) && !isIdentifier(node.name) && !patternAfter(node.name, consumer))
    return false;
  if (!completed) return true;
  if (isCallExpression(node)) return proof.call?.(node) === true;
  if (isNewExpression(node)) return proof.construct?.(node) === true;
  if (isPropertyAccessExpression(node) || isElementAccessExpression(node))
    return quietMember(node, proof);
  if (isSpreadAssignment(node) || isSpreadElement(node))
    return proof.spread?.(node.expression) === true;
  if (isComputedPropertyName(node)) return proof.primitive(node.expression);
  return quietConversion(node, proof);
}

/** Class initialization, iteration and suspension can run before a textually later consumer. */
function opaqueBoundary(node: Node, completed: boolean): boolean {
  if (isClassDeclaration(node) || isClassExpression(node)) return true;
  return (
    node.kind === SyntaxKind.ForStatement ||
    node.kind === SyntaxKind.ForInStatement ||
    node.kind === SyntaxKind.ForOfStatement ||
    node.kind === SyntaxKind.WhileStatement ||
    node.kind === SyntaxKind.DoStatement ||
    (completed && opaqueEvaluation(node))
  );
}

/** Suspension and implicit calls matter only once their operand evaluation has completed. */
function opaqueEvaluation(node: Node): boolean {
  return [
    SyntaxKind.AwaitExpression,
    SyntaxKind.DeleteExpression,
    SyntaxKind.PostfixUnaryExpression,
    SyntaxKind.TaggedTemplateExpression,
    SyntaxKind.YieldExpression,
  ].includes(node.kind);
}

/** Source-qualified native fields are quiet reads; proving a call does not hide its computed key. */
function quietMember(
  node: Expression & { readonly expression: Expression },
  proof: FramedOwnerPrefixProof,
): boolean {
  if (isElementAccessExpression(node) && !proof.primitive(node.argumentExpression)) return false;
  return proof.value?.(node) === true || provedCallee(node, proof);
}

/** Only a direct callee member chain inherits a completed native invocation's proof. */
function provedCallee(node: Expression, proof: FramedOwnerPrefixProof): boolean {
  let target: Node = node;
  for (let parent = target.parent; ; parent = target.parent) {
    if (transparent(parent) || memberReceiver(target, parent)) {
      target = parent;
      continue;
    }
    if (isCallExpression(parent) && parent.expression === target)
      return proof.call?.(parent) === true;
    return (
      isNewExpression(parent) && parent.expression === target && proof.construct?.(parent) === true
    );
  }
}

/** Transparent expression wrappers do not change evaluation order or execute a conversion. */
function transparent(node: Node): boolean {
  return (
    isAsExpression(node) ||
    isTypeAssertion(node) ||
    isSatisfiesExpression(node) ||
    isParenthesizedExpression(node) ||
    isNonNullExpression(node)
  );
}

/** A computed key remains an operand rather than acquiring its receiver's native callee proof. */
function memberReceiver(node: Node, parent: Node): boolean {
  return (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

/** Primitive-only operations cannot call a supplied value's conversion hooks. */
function quietConversion(node: Node, proof: FramedOwnerPrefixProof): boolean {
  if (isBinaryExpression(node)) return proof.primitive(node);
  if (isPrefixUnaryExpression(node))
    return node.operator === SyntaxKind.ExclamationToken || proof.primitive(node);
  if (isTemplateExpression(node)) return proof.primitive(node);
  return true;
}
