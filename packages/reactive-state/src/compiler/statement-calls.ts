import {
  type CallExpression,
  type ClassDeclaration,
  type ClassExpression,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isConstructorDeclaration,
  isDecorator,
  isElementAccessExpression,
  isForOfStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isNewExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isVariableDeclaration,
  type NewExpression,
  type Node,
  SyntaxKind,
  type TaggedTemplateExpression,
} from 'typescript/ast';

import { createStepCounter, forEachCallWithin, WalkBudgetError } from './statement-call-budget.ts';
import {
  type ResolvedValue,
  type TargetContext,
  valueIdentityKey,
} from './statement-call-classes.ts';
import {
  activateArrayReceiver,
  activateReturnedValues,
  activateEscapedExpression,
  type EscapeDriver,
} from './statement-call-escapes.ts';
import { projectMemberFromValue } from './statement-call-members.ts';
import {
  isValueAssignment,
  observeAssignmentDestructuring,
  observeDeclarationDestructuring,
  observeForOfDestructuring,
  observeMemberAccess,
  observeObjectSpread,
} from './statement-call-patterns.ts';
import {
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
  nodeIdOf,
  type ScopeTable,
  unwrapExpression,
} from './statement-call-scopes.ts';
import {
  EMPTY_NODE_SET,
  resolveTargets,
  staticAccessKey,
  superConstructorTargets,
} from './statement-call-targets.ts';
import { collectExecutableRoot } from './statement-call-writes.ts';

interface ActiveReceiverEntry {
  readonly owner: Node;
  readonly receiver: ResolvedValue;
}

interface WalkState {
  readonly activated: Map<Node, Set<string>>;
  readonly activeReceivers: ActiveReceiverEntry[];
  /** Every binding a collected scope gave a spec to, in order. */
  readonly appended: Binding[];
  readonly constructed: Map<Node, Set<string>>;
  readonly ctx: TargetContext;
  readonly dirtyBindings: Set<Binding>;
  readonly driver: EscapeDriver;
  flushing: boolean;
  readonly onCall: (call: CallExpression) => boolean;
  readonly scopes: ScopeTable;
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
  const state = createWalkState(root, onCall);
  try {
    collectScopeWithPropagation(root, state);
    if (isCallExpression(root)) {
      visitNode(root, state);
      return;
    }
    root.forEachChild((child) => {
      visitNode(child, state);
    });
  } catch (error) {
    if (!(error instanceof WalkBudgetError)) {
      throw error;
    }
    forEachCallWithin(root, onCall);
  }
}

function createWalkState(root: Node, onCall: (call: CallExpression) => boolean): WalkState {
  const scopes = createScopeTable(root);
  const activeReceivers: ActiveReceiverEntry[] = [];
  const wholeEscaped = new Set<string>();
  const state: WalkState = {
    activated: new Map(),
    activeReceivers,
    appended: [],
    constructed: new Map(),
    ctx: {
      activeReceiverFor: (owner) => findActiveReceiver(activeReceivers, owner),
      ensureScope: (execRoot) => {
        collectScopeWithPropagation(execRoot, state);
      },
      onActivate: (callable, receiver) => {
        activateCallable(callable, state, receiver);
      },
      project: (receiver, query) => projectMemberFromValue(receiver, query, state.ctx),
      resolve: (expr, seenNodes, seenBindings) =>
        resolveTargets(expr, state.ctx, seenNodes, seenBindings),
      scopes,
      spend: createStepCounter(),
      withActiveReceiver: (owner, receiver, run) =>
        runWithReceiver(activeReceivers, owner, receiver, run),
    },
    dirtyBindings: new Set(),
    driver: {
      activateCallable: (callable, receiver) => {
        activateCallable(callable, state, receiver);
      },
      constructClass: (cls, instanceReceiver) => {
        constructClass(cls, state, instanceReceiver);
      },
      get ctx() {
        return state.ctx;
      },
      isStopped: () => state.stopped,
      scopes,
      watch: (watcherKey, run) => {
        watchResolution(watcherKey, state, run);
      },
      wholeEscaped,
    },
    flushing: false,
    onCall,
    scopes,
    stopped: false,
  };
  return state;
}

function findActiveReceiver(
  stack: readonly ActiveReceiverEntry[],
  owner: Node,
): ResolvedValue | undefined {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const entry = stack[index];
    if (entry?.owner === owner) {
      return entry.receiver;
    }
  }
  return undefined;
}

function runWithReceiver<T>(
  stack: ActiveReceiverEntry[],
  owner: Node,
  receiver: ResolvedValue | undefined,
  run: () => T,
): T {
  if (receiver === undefined) {
    return run();
  }
  stack.push({ owner, receiver });
  try {
    return run();
  } finally {
    stack.pop();
  }
}

function collectScopeWithPropagation(execRoot: Node, state: WalkState): void {
  collectExecutableRoot(execRoot, state.scopes, (binding) => {
    state.appended.push(binding);
    if (binding.watchers.size > 0) {
      state.dirtyBindings.add(binding);
    }
  });
  flushDirtyBindings(state);
}

function flushDirtyBindings(state: WalkState): void {
  if (state.flushing) {
    return;
  }
  state.flushing = true;
  try {
    while (!state.stopped && state.dirtyBindings.size > 0) {
      const batch = [...state.dirtyBindings];
      state.dirtyBindings.clear();
      const callbacks = new Map<string, () => void>();
      for (const binding of batch) {
        for (const [key, callback] of binding.watchers) {
          callbacks.set(key, callback);
        }
      }
      for (const callback of callbacks.values()) {
        if (state.driver.isStopped()) {
          break;
        }
        callback();
      }
    }
  } finally {
    state.flushing = false;
  }
}

function watchResolution(
  watcherKey: string,
  state: WalkState,
  run: (seenBindings: Set<Binding>) => void,
): void {
  if (state.stopped) {
    return;
  }
  const replay = (): void => {
    let again = true;
    while (again && !state.stopped) {
      const seenBindings = new Set<Binding>();
      const logStart = state.appended.length;
      run(seenBindings);
      for (const binding of seenBindings) {
        binding.watchers.set(watcherKey, replay);
      }
      // A write recorded while `run` resolved found no watcher on its binding, as this one is
      // registered only now: resolve again, with what the binding holds by now.
      again = state.appended.slice(logStart).some((binding) => seenBindings.has(binding));
    }
  };
  replay();
}

function markKeyedVisit(map: Map<Node, Set<string>>, node: Node, key: string): boolean {
  let keys = map.get(node);
  if (keys === undefined) {
    keys = new Set();
    map.set(node, keys);
  } else if (keys.has(key)) {
    return false;
  }
  keys.add(key);
  return true;
}

function receiverSlotKey(receiver: ResolvedValue | undefined, scopes: ScopeTable): string {
  return receiver === undefined ? '_' : valueIdentityKey(receiver, scopes);
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
  if (isDecorator(node)) {
    invokeExpression(node.expression, state);
  } else if (isPropertyAccessExpression(node) || isElementAccessExpression(node)) {
    observeMemberAccess(node, state.driver);
  } else if (isSpreadAssignment(node)) {
    observeObjectSpread(node.expression, state.driver);
  } else if (isVariableDeclaration(node) || isParameterDeclaration(node)) {
    observeDeclarationDestructuring(node, state.driver);
  } else if (isBinaryExpression(node) && isValueAssignment(node.operatorToken.kind)) {
    observeAssignmentDestructuring(node.left, node.right, state.driver);
  } else if (isForOfStatement(node)) {
    observeForOfDestructuring(node, state.driver);
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
  const callee = unwrapExpression(node.expression);
  if (callee.kind === SyntaxKind.SuperKeyword) {
    invokeSuperConstructor(callee, state);
  } else {
    invokeExpression(node.expression, state);
    invokeBorrowedReceiver(node, state);
    activateArrayReceiver(node, state.driver);
  }
  for (const arg of node.arguments) {
    activateEscapedExpression(isSpreadElement(arg) ? arg.expression : arg, state.driver);
  }
  node.forEachChild((child) => {
    visitNode(child, state);
  });
}

function handleNewExpression(node: NewExpression, state: WalkState): void {
  constructExpression(node.expression, state);
  if (node.arguments !== undefined) {
    for (const arg of node.arguments) {
      activateEscapedExpression(isSpreadElement(arg) ? arg.expression : arg, state.driver);
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
      activateEscapedExpression(span.expression, state.driver);
    }
  }
  node.forEachChild((child) => {
    visitNode(child, state);
  });
}

function invokeExpression(expr: Node, state: WalkState): void {
  watchResolution(`invoke:${nodeIdOf(expr, state.scopes)}`, state, (seenBindings) => {
    const targets = resolveTargets(expr, state.ctx, EMPTY_NODE_SET, seenBindings);
    for (const target of targets) {
      if (target.kind === 'node' && isCallableNode(target.node)) {
        activateCallable(target.node, state, target.receiver);
      }
    }
  });
}

function invokeSuperConstructor(superNode: Node, state: WalkState): void {
  watchResolution(`super:${nodeIdOf(superNode, state.scopes)}`, state, (seenBindings) => {
    const { bases, selves } = superConstructorTargets(superNode, state.ctx, seenBindings);
    const receivers: readonly (ResolvedValue | undefined)[] =
      selves.length > 0 ? selves : [undefined];
    for (const base of bases) {
      if (base.kind !== 'node') {
        continue;
      }
      for (const self of receivers) {
        if (isClassDeclaration(base.node) || isClassExpression(base.node)) {
          constructClass(base.node, state, self);
        } else if (isFunctionDeclaration(base.node) || isFunctionExpression(base.node)) {
          activateCallable(base.node, state, self);
          activateReturnedValues(base.node, self, state.driver);
        }
      }
    }
  });
}

function invokeBorrowedReceiver(call: CallExpression, state: WalkState): void {
  const clean = unwrapExpression(call.expression);
  if (!isPropertyAccessExpression(clean) && !isElementAccessExpression(clean)) {
    return;
  }
  watchResolution(`borrow:${nodeIdOf(call, state.scopes)}`, state, (seenBindings) => {
    const key = staticAccessKey(clean, state.scopes, seenBindings);
    if (key !== 'call' && key !== 'apply') {
      return;
    }
    const receivers = resolveTargets(clean.expression, state.ctx, EMPTY_NODE_SET, seenBindings);
    const firstArg = call.arguments[0];
    const thisArgs =
      firstArg === undefined || isSpreadElement(firstArg)
        ? []
        : resolveTargets(firstArg, state.ctx, EMPTY_NODE_SET, seenBindings);
    for (const fnTarget of receivers) {
      if (fnTarget.kind !== 'node' || !isCallableNode(fnTarget.node)) {
        continue;
      }
      if (
        isArrowFunction(fnTarget.node) ||
        fnTarget.receiver !== undefined ||
        thisArgs.length === 0
      ) {
        activateCallable(fnTarget.node, state, fnTarget.receiver);
        continue;
      }
      for (const thisArg of thisArgs) {
        activateCallable(fnTarget.node, state, thisArg);
      }
    }
  });
}

function constructExpression(expr: Node, state: WalkState, instanceReceiver?: ResolvedValue): void {
  const receiverPart = receiverSlotKey(instanceReceiver, state.scopes);
  watchResolution(`new:${nodeIdOf(expr, state.scopes)}:${receiverPart}`, state, (seenBindings) => {
    const targets = resolveTargets(expr, state.ctx, EMPTY_NODE_SET, seenBindings);
    for (const target of targets) {
      if (target.kind !== 'node') {
        continue;
      }
      if (isClassDeclaration(target.node) || isClassExpression(target.node)) {
        constructClass(target.node, state, instanceReceiver);
      } else if (isFunctionDeclaration(target.node) || isFunctionExpression(target.node)) {
        activateCallable(target.node, state, instanceReceiver);
        activateReturnedValues(target.node, instanceReceiver, state.driver);
      }
    }
  });
}

function constructClass(
  cls: ClassDeclaration | ClassExpression,
  state: WalkState,
  instanceReceiver?: ResolvedValue,
): void {
  const effectiveReceiver: ResolvedValue = instanceReceiver ?? { cls, kind: 'instance' };
  const slotKey = receiverSlotKey(effectiveReceiver, state.scopes);
  if (state.stopped || !markKeyedVisit(state.constructed, cls, slotKey)) {
    return;
  }
  const baseExpr = extendsExpressionOf(cls);
  if (baseExpr !== undefined) {
    constructExpression(baseExpr, state, effectiveReceiver);
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
      const initializer = member.initializer;
      state.ctx.withActiveReceiver(member, effectiveReceiver, () => {
        visitNode(initializer, state);
      });
    } else if (isConstructorDeclaration(member)) {
      activateCallable(member, state, effectiveReceiver);
      activateReturnedValues(member, effectiveReceiver, state.driver);
    }
  }
}

function activateCallable(
  callable: CallableNode,
  state: WalkState,
  receiver?: ResolvedValue,
): void {
  const effectiveReceiver = isArrowFunction(callable) ? undefined : receiver;
  const slotKey = receiverSlotKey(effectiveReceiver, state.scopes);
  if (
    state.stopped ||
    isErasedOrAmbient(callable) ||
    !markKeyedVisit(state.activated, callable, slotKey)
  ) {
    return;
  }
  collectScopeWithPropagation(callable, state);
  state.ctx.withActiveReceiver(callable, effectiveReceiver, () => {
    for (const parameter of callable.parameters) {
      observeDeclarationDestructuring(parameter, state.driver);
      parameter.forEachChild((child) => {
        if (!isDecorator(child)) {
          visitNode(child, state);
        }
      });
    }
    if (callable.body !== undefined) {
      visitNode(callable.body, state);
    }
  });
}
