import {
  type CallExpression,
  type ClassDeclaration,
  type ClassExpression,
  type ConstructorDeclaration,
  type GetAccessorDeclaration,
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isComputedPropertyName,
  isConditionalExpression,
  isConstructorDeclaration,
  isDecorator,
  isElementAccessExpression,
  isExpressionWithTypeArguments,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTypeAssertion,
  isVariableDeclaration,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type SetAccessorDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { isTypeOnly } from './scope.ts';

type DeferredMember =
  | ConstructorDeclaration
  | GetAccessorDeclaration
  | MethodDeclaration
  | SetAccessorDeclaration;

const LOGICAL_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

interface WalkState {
  readonly activated: Set<Node>;
  readonly collectedScopes: Set<Node>;
  readonly localTargets: Map<string, Node[]>;
  readonly onCall: (call: CallExpression) => boolean;
  stopped: boolean;
}

/**
 * Visits every `CallExpression` that may run synchronously when `root` evaluates, stopping once
 * `onCall` returns `true`.
 */
export function forEachSynchronousCall(
  root: Node,
  onCall: (call: CallExpression) => boolean,
): void {
  const state: WalkState = {
    activated: new Set(),
    collectedScopes: new Set(),
    localTargets: new Map(),
    onCall,
    stopped: false,
  };
  collectScopeTargets(root, state);
  root.forEachChild((child) => {
    visitNode(child, state);
  });
}

function visitNode(node: Node, state: WalkState): void {
  if (state.stopped || isErasedOrAmbient(node) || isDeferredFunction(node, state.activated)) {
    return;
  }
  if (isCallExpression(node) && state.onCall(node)) {
    state.stopped = true;
    return;
  }
  if (isIdentifier(node) && standsInMemberOrInvocation(node)) {
    enterLocalTargets(node.text, state);
    return;
  }
  if (shouldCollectChildScope(node)) {
    collectScopeTargets(node, state);
  }
  forEachActiveChild(node, state);
}

function enterLocalTargets(name: string, state: WalkState): void {
  const targets = state.localTargets.get(name);
  if (targets === undefined) {
    return;
  }
  for (const target of targets) {
    activateTarget(target, state);
  }
}

function activateTarget(target: Node, state: WalkState): void {
  const queue: Node[] = [target];
  for (const queued of queue) {
    const current = unwrapTarget(queued);
    if (state.activated.has(current)) {
      continue;
    }
    state.activated.add(current);
    enqueueInnerTargets(current, state.localTargets, queue);
    visitNode(current, state);
  }
}

function unwrapTarget(node: Node): Node {
  let current = node;
  while (isWrapperExpression(current)) {
    current = (current as { readonly expression: Node }).expression;
  }
  return current;
}

function enqueueInnerTargets(
  node: Node,
  localTargets: ReadonlyMap<string, Node[]>,
  queue: Node[],
): void {
  if (isIdentifier(node)) {
    queue.push(...(localTargets.get(node.text) ?? []));
    return;
  }
  if (isConditionalExpression(node)) {
    queue.push(node.whenTrue, node.whenFalse);
    return;
  }
  if (isBinaryExpression(node)) {
    enqueueBinaryTargets(node, queue);
    return;
  }
  if (isArrayLiteralExpression(node)) {
    enqueueArrayTargets(node.elements, queue);
    return;
  }
  if (isObjectLiteralExpression(node)) {
    enqueueObjectTargets(node, queue);
  }
}

function enqueueArrayTargets(elements: readonly Node[], queue: Node[]): void {
  for (const element of elements) {
    queue.push(isSpreadElement(element) ? element.expression : element);
  }
}

function enqueueBinaryTargets(
  node: Node & {
    readonly left: Node;
    readonly operatorToken: { readonly kind: SyntaxKind };
    readonly right: Node;
  },
  queue: Node[],
): void {
  const operator = node.operatorToken.kind;
  if (operator === SyntaxKind.CommaToken) {
    queue.push(node.right);
  } else if (LOGICAL_OPERATORS.has(operator)) {
    queue.push(node.left, node.right);
  }
}

function enqueueObjectTargets(node: ObjectLiteralExpression, queue: Node[]): void {
  for (const property of node.properties) {
    if (isPropertyAssignment(property)) {
      queue.push(property.initializer);
    } else if (isShorthandPropertyAssignment(property)) {
      queue.push(property.name);
    } else if (isSpreadAssignment(property)) {
      queue.push(property.expression);
    }
  }
}

function shouldCollectChildScope(node: Node): boolean {
  return (
    isArrowFunction(node) ||
    isFunctionExpression(node) ||
    isFunctionDeclaration(node) ||
    isClassStaticBlockDeclaration(node)
  );
}

function collectScopeTargets(scopeRoot: Node, state: WalkState): void {
  if (state.collectedScopes.has(scopeRoot)) {
    return;
  }
  state.collectedScopes.add(scopeRoot);
  const scan = (node: Node): void => {
    if (isErasedOrAmbient(node)) {
      return;
    }
    recordDeclarationTarget(node, state.localTargets);
    if (node !== scopeRoot && isScopeBoundary(node)) {
      return;
    }
    node.forEachChild(scan);
  };
  scopeRoot.forEachChild(scan);
}

function recordDeclarationTarget(node: Node, localTargets: Map<string, Node[]>): void {
  if ((isFunctionDeclaration(node) || isClassDeclaration(node)) && node.name !== undefined) {
    appendTarget(localTargets, node.name.text, node);
    return;
  }
  if (isVariableDeclaration(node) && isIdentifier(node.name) && node.initializer !== undefined) {
    appendTarget(localTargets, node.name.text, node.initializer);
  }
}

function appendTarget(localTargets: Map<string, Node[]>, name: string, target: Node): void {
  const existing = localTargets.get(name);
  if (existing === undefined) {
    localTargets.set(name, [target]);
  } else {
    existing.push(target);
  }
}

function isScopeBoundary(node: Node): boolean {
  return (
    isArrowFunction(node) ||
    isFunctionExpression(node) ||
    isFunctionDeclaration(node) ||
    isDeferredMember(node)
  );
}

function isErasedOrAmbient(node: Node): boolean {
  if (isTypeOnly(node) || hasModifier(node, SyntaxKind.DeclareKeyword)) {
    return true;
  }
  return isPropertyDeclaration(node) && hasModifier(node, SyntaxKind.AbstractKeyword);
}

function isDeferredFunction(node: Node, activated: ReadonlySet<Node>): boolean {
  if (activated.has(node)) {
    return false;
  }
  if (isFunctionDeclaration(node)) {
    return true;
  }
  return (isArrowFunction(node) || isFunctionExpression(node)) && !standsInInvocation(node);
}

function forEachActiveChild(node: Node, state: WalkState): void {
  const visit = (child: Node): void => {
    visitNode(child, state);
  };
  if (isDeferredMember(node) && !hasActiveOwner(node, state.activated)) {
    visitMemberHeader(node, visit);
    return;
  }
  if (
    isPropertyDeclaration(node) &&
    !hasModifier(node, SyntaxKind.StaticKeyword) &&
    !hasActiveOwner(node, state.activated)
  ) {
    node.forEachChild((child) => {
      if (child !== node.initializer) {
        visit(child);
      }
    });
    return;
  }
  node.forEachChild(visit);
}

function hasActiveOwner(member: Node, activated: ReadonlySet<Node>): boolean {
  const owner = member.parent;
  if (owner === undefined || !isOwnerContainer(owner)) {
    return false;
  }
  return activated.has(owner) || standsInMemberOrInvocation(owner);
}

function isOwnerContainer(
  node: Node,
): node is ClassDeclaration | ClassExpression | ObjectLiteralExpression {
  return isObjectLiteralExpression(node) || isClassExpression(node) || isClassDeclaration(node);
}

function standsInInvocation(node: Node): boolean {
  let current = node;
  for (;;) {
    const { parent } = current;
    if (parent === undefined) {
      return false;
    }
    if (isInvocationParent(parent)) {
      return true;
    }
    if (!forwardsToInvocation(current, parent)) {
      return false;
    }
    current = parent;
  }
}

function standsInMemberOrInvocation(node: Node): boolean {
  let current = node;
  for (;;) {
    const { parent } = current;
    if (parent === undefined) {
      return false;
    }
    if (isInvocationParent(parent) || isMemberReceiver(current, parent)) {
      return true;
    }
    if (!forwardsToInvocation(current, parent)) {
      return false;
    }
    current = parent;
  }
}

function isInvocationParent(parent: Node): boolean {
  return isCallExpression(parent) || isNewExpression(parent) || isTaggedTemplateExpression(parent);
}

function isMemberReceiver(current: Node, parent: Node): boolean {
  return (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === current
  );
}

function forwardsToInvocation(current: Node, parent: Node): boolean {
  if (isWrapperExpression(parent) || isContainerParent(current, parent)) {
    return true;
  }
  return isBranchingParent(current, parent) || isMemberReceiver(current, parent);
}

function isWrapperExpression(node: Node): boolean {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    isNonNullExpression(node) ||
    isTypeAssertion(node) ||
    isExpressionWithTypeArguments(node)
  );
}

function isContainerParent(current: Node, parent: Node): boolean {
  if (
    isSpreadElement(parent) ||
    isArrayLiteralExpression(parent) ||
    isSpreadAssignment(parent) ||
    isObjectLiteralExpression(parent)
  ) {
    return true;
  }
  return isPropertyAssignment(parent) && parent.initializer === current;
}

function isBranchingParent(current: Node, parent: Node): boolean {
  if (isConditionalExpression(parent)) {
    return current !== parent.condition;
  }
  if (!isBinaryExpression(parent)) {
    return false;
  }
  const operator = parent.operatorToken.kind;
  return (
    LOGICAL_OPERATORS.has(operator) ||
    (operator === SyntaxKind.CommaToken && current === parent.right)
  );
}

function isDeferredMember(node: Node): node is DeferredMember {
  return (
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node)
  );
}

function visitMemberHeader(member: DeferredMember, visit: (child: Node) => void): void {
  visitDecorators(member.modifiers, visit);
  if (!isConstructorDeclaration(member) && isComputedPropertyName(member.name)) {
    visit(member.name);
  }
  for (const parameter of member.parameters) {
    visitDecorators(parameter.modifiers, visit);
  }
}

function visitDecorators(
  modifiers: readonly Node[] | undefined,
  visit: (child: Node) => void,
): void {
  if (modifiers === undefined) {
    return;
  }
  for (const modifier of modifiers) {
    if (isDecorator(modifier)) {
      visit(modifier);
    }
  }
}

function hasModifier(node: Node, kind: SyntaxKind): boolean {
  return (
    (node as { readonly modifiers?: readonly Node[] }).modifiers?.some(
      (each) => each.kind === kind,
    ) === true
  );
}
