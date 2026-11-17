import {
  type BindingElement,
  type BindingName,
  type CallExpression,
  type ClassDeclaration,
  type ClassExpression,
  type ElementAccessExpression,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isDecorator,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isVariableDeclaration,
  type NewExpression,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  SyntaxKind,
  type TaggedTemplateExpression,
} from 'typescript/ast';

import {
  accessModeOf,
  type Binding,
  type CallableNode,
  createScopeTable,
  extendsExpressionOf,
  forEachDecorator,
  forEachHeaderNode,
  hasModifier,
  isCallableNode,
  isDeferredMember,
  isErasedOrAmbient,
  isPassiveDeferredFunction,
  type ScopeTable,
  unwrapExpression,
} from './statement-call-scopes.ts';
import {
  projectMemberFromValue,
  type ResolvedValue,
  resolveSpecTargets,
  resolveTargets,
  staticAccessKey,
  type TargetContext,
} from './statement-call-targets.ts';
import {
  bindingElementKey,
  collectExecutableRoot,
  staticPropertyNameKey,
} from './statement-call-writes.ts';

interface WalkState {
  readonly activated: Set<Node>;
  readonly constructed: Set<Node>;
  readonly ctx: TargetContext;
  readonly onCall: (call: CallExpression) => boolean;
  readonly scopes: ScopeTable;
  stopped: boolean;
  readonly wholeEscaped: Set<Node>;
}

/**
 * Visits every `CallExpression` that may run synchronously when `root` evaluates, stopping once
 * `onCall` returns `true`.
 */
export function forEachSynchronousCall(
  root: Node,
  onCall: (call: CallExpression) => boolean,
): void {
  const scopes = createScopeTable(root);
  const state: WalkState = {
    activated: new Set(),
    constructed: new Set(),
    ctx: {
      onActivate: (callable) => {
        activateCallable(callable, state);
      },
      scopes,
    },
    onCall,
    scopes,
    stopped: false,
    wholeEscaped: new Set(),
  };
  collectScopeWithPropagation(root, state);
  if (isCallExpression(root)) {
    visitNode(root, state);
    return;
  }
  root.forEachChild((child) => {
    visitNode(child, state);
  });
}

function collectScopeWithPropagation(execRoot: Node, state: WalkState): void {
  collectExecutableRoot(execRoot, state.scopes, (binding, spec) => {
    const resolved = resolveSpecTargets(spec, state.ctx);
    if (binding.escaped) {
      for (const value of resolved) {
        activateWholeValue(value, state);
      }
    } else if (binding.invoked) {
      for (const value of resolved) {
        if (value.kind === 'node' && isCallableNode(value.node)) {
          activateCallable(value.node, state);
        }
      }
    }
  });
}

function visitNode(node: Node, state: WalkState): void {
  if (state.stopped || isErasedOrAmbient(node) || isPassiveDeferredFunction(node)) {
    return;
  }
  if (isCallExpression(node)) {
    if (state.onCall(node)) {
      state.stopped = true;
      return;
    }
    handleCallExpression(node, state);
    return;
  }
  if (isNewExpression(node)) {
    handleNewExpression(node, state);
    return;
  }
  if (isTaggedTemplateExpression(node)) {
    handleTaggedTemplate(node, state);
    return;
  }
  observeNodeOperations(node, state);
  forEachActiveChild(node, state);
}

function observeNodeOperations(node: Node, state: WalkState): void {
  if (isClassStaticBlockDeclaration(node)) {
    collectScopeWithPropagation(node, state);
  } else if (isDecorator(node)) {
    invokeExpression(node.expression, state);
  } else if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
    observeMemberAccess(node, state);
  } else if (isSpreadAssignment(node)) {
    observeObjectSpread(node.expression, state);
  } else if (isVariableDeclaration(node) || isParameterDeclaration(node)) {
    if (node.initializer !== undefined && !isIdentifier(node.name)) {
      observeBindingPattern(node.name, resolveTargets(node.initializer, state.ctx), state);
    }
  } else if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
    observeAssignmentPattern(node.left, node.right, state);
  }
}

function forEachActiveChild(node: Node, state: WalkState): void {
  const visit = (child: Node): void => {
    visitNode(child, state);
  };
  if (isDeferredMember(node)) {
    forEachHeaderNode(node, visit);
    return;
  }
  if (isPropertyDeclaration(node) && !hasModifier(node, SyntaxKind.StaticKeyword)) {
    forEachDecorator(node.modifiers, visit);
    if (isComputedPropertyName(node.name)) {
      visit(node.name);
    }
    return;
  }
  node.forEachChild(visit);
}

function handleCallExpression(node: CallExpression, state: WalkState): void {
  invokeExpression(node.expression, state);
  invokeBorrowedReceiver(node.expression, state);
  for (const arg of node.arguments) {
    activateEscapedExpression(isSpreadElement(arg) ? arg.expression : arg, state);
  }
  node.forEachChild((child) => {
    visitNode(child, state);
  });
}

function handleNewExpression(node: NewExpression, state: WalkState): void {
  constructExpression(node.expression, state);
  if (node.arguments !== undefined) {
    for (const arg of node.arguments) {
      activateEscapedExpression(isSpreadElement(arg) ? arg.expression : arg, state);
    }
  }
  node.forEachChild((child) => {
    visitNode(child, state);
  });
}

function handleTaggedTemplate(node: TaggedTemplateExpression, state: WalkState): void {
  invokeExpression(node.tag, state);
  if (isTemplateExpression(node.template)) {
    for (const span of node.template.templateSpans) {
      activateEscapedExpression(span.expression, state);
    }
  }
  node.forEachChild((child) => {
    visitNode(child, state);
  });
}

function invokeExpression(expr: Node, state: WalkState): void {
  const seenBindings = new Set<Binding>();
  const targets = resolveTargets(expr, state.ctx, new Set(), seenBindings);
  for (const binding of seenBindings) {
    binding.invoked = true;
  }
  for (const target of targets) {
    if (target.kind === 'node' && isCallableNode(target.node)) {
      activateCallable(target.node, state);
    }
  }
}

function invokeBorrowedReceiver(calleeExpr: Node, state: WalkState): void {
  const clean = unwrapExpression(calleeExpr);
  if (!isPropertyAccessExpression(clean) && !isElementAccessExpression(clean)) {
    return;
  }
  const key = staticAccessKey(clean, state.scopes);
  if (key !== 'call' && key !== 'apply') {
    return;
  }
  const receivers = resolveTargets(clean.expression, state.ctx);
  for (const receiver of receivers) {
    if (receiver.kind === 'node' && isCallableNode(receiver.node)) {
      activateCallable(receiver.node, state);
    }
  }
}

function constructExpression(expr: Node, state: WalkState): void {
  const targets = resolveTargets(expr, state.ctx);
  for (const target of targets) {
    if (target.kind !== 'node') {
      continue;
    }
    if (isClassDeclaration(target.node) || isClassExpression(target.node)) {
      constructClass(target.node, state);
    } else if (isFunctionDeclaration(target.node) || isFunctionExpression(target.node)) {
      activateCallable(target.node, state);
    }
  }
}

function constructClass(cls: ClassDeclaration | ClassExpression, state: WalkState): void {
  if (state.stopped || state.constructed.has(cls)) {
    return;
  }
  state.constructed.add(cls);
  const baseExpr = extendsExpressionOf(cls);
  if (baseExpr !== undefined) {
    constructExpression(baseExpr, state);
  }
  for (const member of cls.members) {
    if (isErasedOrAmbient(member)) {
      continue;
    }
    if (
      isPropertyDeclaration(member) &&
      !hasModifier(member, SyntaxKind.StaticKeyword) &&
      member.initializer !== undefined
    ) {
      visitNode(member.initializer, state);
    } else if (isConstructorDeclaration(member)) {
      activateCallable(member, state);
    }
  }
}

function activateCallable(callable: CallableNode, state: WalkState): void {
  if (state.stopped || isErasedOrAmbient(callable) || state.activated.has(callable)) {
    return;
  }
  state.activated.add(callable);
  collectScopeWithPropagation(callable, state);
  for (const parameter of callable.parameters) {
    parameter.forEachChild((child) => {
      if (!isDecorator(child)) {
        visitNode(child, state);
      }
    });
  }
  if (callable.body !== undefined) {
    visitNode(callable.body, state);
  }
}

function activateEscapedExpression(expr: Node, state: WalkState): void {
  const seenBindings = new Set<Binding>();
  const targets = resolveTargets(expr, state.ctx, new Set(), seenBindings);
  for (const binding of seenBindings) {
    binding.escaped = true;
  }
  for (const target of targets) {
    activateWholeValue(target, state);
  }
}

function activateWholeValue(value: ResolvedValue, state: WalkState): void {
  if (state.stopped) {
    return;
  }
  if (value.kind === 'instance') {
    activateWholeClass(value.cls, state);
    return;
  }
  activateWholeNode(value.node, state);
}

function activateWholeNode(node: Node, state: WalkState): void {
  if (isCallableNode(node)) {
    activateCallable(node, state);
    return;
  }
  if (isClassDeclaration(node) || isClassExpression(node)) {
    activateWholeClass(node, state);
    return;
  }
  if (state.wholeEscaped.has(node)) {
    return;
  }
  if (isObjectLiteralExpression(node)) {
    state.wholeEscaped.add(node);
    activateWholeObject(node, state);
  } else if (isArrayLiteralExpression(node)) {
    state.wholeEscaped.add(node);
    activateWholeArray(node.elements, state);
  }
}

function activateWholeArray(elements: readonly Node[], state: WalkState): void {
  for (const element of elements) {
    if (!isOmittedExpression(element)) {
      activateEscapedExpression(isSpreadElement(element) ? element.expression : element, state);
    }
  }
}

function activateWholeObject(object: ObjectLiteralExpression, state: WalkState): void {
  for (const property of object.properties) {
    if (isDeferredMember(property)) {
      activateCallable(property, state);
    } else if (isPropertyAssignment(property)) {
      activateEscapedExpression(property.initializer, state);
    } else if (isShorthandPropertyAssignment(property)) {
      activateEscapedExpression(property.name, state);
    } else if (isSpreadAssignment(property)) {
      activateEscapedExpression(property.expression, state);
    }
  }
}

function activateWholeClass(cls: ClassDeclaration | ClassExpression, state: WalkState): void {
  if (state.wholeEscaped.has(cls)) {
    return;
  }
  state.wholeEscaped.add(cls);
  constructClass(cls, state);
  for (const member of cls.members) {
    if (isDeferredMember(member)) {
      activateCallable(member, state);
    }
  }
}

function observeMemberAccess(
  access: ElementAccessExpression | PropertyAccessExpression,
  state: WalkState,
): void {
  const mode = accessModeOf(access);
  const key = staticAccessKey(access, state.scopes);
  const receivers = resolveTargets(access.expression, state.ctx);
  for (const receiver of receivers) {
    projectMemberFromValue(receiver, { key, mode, seen: new Set() }, state.ctx);
  }
}

function observeObjectSpread(expr: Node, state: WalkState): void {
  const sources = resolveTargets(expr, state.ctx);
  for (const source of sources) {
    projectMemberFromValue(source, { key: undefined, mode: 'read', seen: new Set() }, state.ctx);
  }
}

function observeBindingPattern(
  pattern: BindingName,
  sources: readonly ResolvedValue[],
  state: WalkState,
): void {
  if (isIdentifier(pattern) || sources.length === 0) {
    return;
  }
  if (isObjectBindingPattern(pattern)) {
    observeObjectBindingElements(pattern.elements, sources, state);
  } else if (isArrayBindingPattern(pattern)) {
    observeArrayBindingElements(pattern.elements, sources, state);
  }
}

function observeObjectBindingElements(
  elements: readonly BindingElement[],
  sources: readonly ResolvedValue[],
  state: WalkState,
): void {
  for (const element of elements) {
    const key =
      element.dotDotDotToken === undefined ? bindingElementKey(element, state.scopes) : undefined;
    observeProjectedElement(element, sources, key, state);
  }
}

function observeArrayBindingElements(
  elements: readonly Node[],
  sources: readonly ResolvedValue[],
  state: WalkState,
): void {
  for (const [index, element] of elements.entries()) {
    if (!isOmittedExpression(element) && isBindingElement(element)) {
      const key = element.dotDotDotToken === undefined ? String(index) : undefined;
      observeProjectedElement(element, sources, key, state);
    }
  }
}

function observeProjectedElement(
  element: BindingElement,
  sources: readonly ResolvedValue[],
  key: string | undefined,
  state: WalkState,
): void {
  const projected = sources.flatMap((src) =>
    projectMemberFromValue(src, { key, mode: 'read', seen: new Set() }, state.ctx),
  );
  if (element.name !== undefined && !isIdentifier(element.name)) {
    const nextSources =
      element.initializer === undefined
        ? projected
        : [...projected, ...resolveTargets(element.initializer, state.ctx)];
    observeBindingPattern(element.name, nextSources, state);
  }
}

function observeAssignmentPattern(left: Node, right: Node, state: WalkState): void {
  const target = unwrapExpression(left);
  if (isObjectLiteralExpression(target)) {
    observeObjectAssignmentPattern(target.properties, resolveTargets(right, state.ctx), state);
  } else if (isArrayLiteralExpression(target)) {
    observeArrayAssignmentPattern(target.elements, resolveTargets(right, state.ctx), state);
  }
}

function observeObjectAssignmentPattern(
  properties: readonly ObjectLiteralElementLike[],
  sources: readonly ResolvedValue[],
  state: WalkState,
): void {
  for (const property of properties) {
    const key = isSpreadAssignment(property)
      ? undefined
      : staticPropertyNameKey(property.name, state.scopes);
    for (const src of sources) {
      projectMemberFromValue(src, { key, mode: 'read', seen: new Set() }, state.ctx);
    }
  }
}

function observeArrayAssignmentPattern(
  elements: readonly Node[],
  sources: readonly ResolvedValue[],
  state: WalkState,
): void {
  for (const [index, element] of elements.entries()) {
    if (!isOmittedExpression(element)) {
      const key = isSpreadElement(element) ? undefined : String(index);
      for (const src of sources) {
        projectMemberFromValue(src, { key, mode: 'read', seen: new Set() }, state.ctx);
      }
    }
  }
}
