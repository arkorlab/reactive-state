import {
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isSuperExpression,
  isVariableDeclaration,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering, overloadsOf } from './answers.ts';
import { globalOf } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import {
  isBenignBuiltInMemberCall,
  isBenignGlobalCallable,
  isBenignPrototypeMemberCall,
} from './framed-template-argument-builtins.ts';
import {
  builtInCheckOf,
  type CalleeContext,
  consumeCalleeStep,
  EMPTY_RESOLUTION,
  type InvocationMode,
  mergeResolutions,
  resolveClassConstructor,
  resolveSuperConstructor,
  singleTarget,
  type TargetCallable,
  type TargetResolution,
  targetFromCallable,
  UNRESOLVED_RESOLUTION,
  withMode,
  withReceivers,
  withSeen,
} from './framed-template-argument-classes.ts';
import {
  resolveObjectPropertyExpressions,
  resolveReceiverMember,
} from './framed-template-argument-members.ts';
import {
  isStableMember,
  isUnreassignedDeclaration,
  memberNameOf,
  unwrapCalleeExpression,
} from './framed-template-argument-receivers.ts';
import {
  isAssignmentOperator,
  LOGICAL_OPERATORS,
  type SpreadUnfold,
  unfoldApplyOperand,
  unfoldCallArguments,
} from './framed-template-argument-spreads.ts';

/**
 * Callee target resolution across direct calls, `new` expressions, `super`, `.call`/`.apply`/`.bind`,
 * `Reflect.apply`/`Reflect.construct`, local objects/classes, and benign built-ins.
 */

const EMPTY_SLOTS: ReadonlyMap<number, readonly Expression[]> = new Map();
const EMPTY_SEEN_NODES: ReadonlySet<Node> = new Set();

export function resolveCallTargets(
  call: CallExpression | NewExpression,
  argsUnfold: SpreadUnfold,
  owner: Node,
): TargetResolution {
  const mode: InvocationMode = isNewExpression(call) ? 'construct' : 'call';
  const ctx = createCalleeContext(owner, mode, argsUnfold.slots);
  return resolveExpressionTargets(call.expression, ctx);
}

export function resolveCallbackTargets(expr: Expression, owner: Node): TargetResolution {
  const ctx = createCalleeContext(owner, 'call', EMPTY_SLOTS);
  return resolveExpressionTargets(expr, ctx);
}

function createCalleeContext(
  owner: Node,
  mode: InvocationMode,
  slots: ReadonlyMap<number, readonly Expression[]>,
): CalleeContext {
  const budget = { steps: 0 };
  const isResolvedCallback = (cbExpr: Expression): boolean => {
    const cbCtx: CalleeContext = {
      budget,
      isResolvedCallback,
      mode: 'call',
      owner,
      resolveExpr: resolveExpressionTargets,
      seen: EMPTY_SEEN_NODES,
      slots: EMPTY_SLOTS,
    };
    const res = resolveExpressionTargets(cbExpr, cbCtx);
    return !res.unresolvable;
  };
  return {
    budget,
    isResolvedCallback,
    mode,
    owner,
    resolveExpr: resolveExpressionTargets,
    seen: EMPTY_SEEN_NODES,
    slots,
  };
}

function resolveExpressionTargets(rawExpr: Expression, ctx: CalleeContext): TargetResolution {
  if (!consumeCalleeStep(ctx)) return UNRESOLVED_RESOLUTION;
  const current = unwrapCalleeExpression(rawExpr);
  if (ctx.seen.has(current)) return UNRESOLVED_RESOLUTION;
  const nextCtx = withSeen(ctx, current);
  if (nextCtx.mode === 'construct') return resolveConstructTarget(current, nextCtx);
  return resolveCallModeTarget(current, nextCtx);
}

function resolveConstructTarget(current: Expression, ctx: CalleeContext): TargetResolution {
  if (isClassExpression(current)) return resolveClassConstructor(current, ctx);
  if (isFunctionExpression(current)) return singleTarget(targetFromCallable(current, [current]));
  if (isIdentifier(current)) return resolveConstructIdentifier(current, ctx);
  if (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    return resolveConstructMember(current, ctx);
  }
  return resolveBranchTargets(current, ctx);
}

function resolveConstructIdentifier(id: Identifier, ctx: CalleeContext): TargetResolution {
  if (isBenignGlobalCallable(id, builtInCheckOf(ctx))) return EMPTY_RESOLUTION;
  const decl = frameDeclarationOf(id);
  if (decl === undefined || ctx.seen.has(decl) || !isUnreassignedDeclaration(decl)) {
    return UNRESOLVED_RESOLUTION;
  }
  if (isClassDeclaration(decl)) return resolveClassConstructor(decl, ctx);
  if (isFunctionDeclaration(decl)) return resolveFunctionOverloadTargets(decl);
  if (isVariableDeclaration(decl) && decl.initializer !== undefined) {
    return resolveExpressionTargets(decl.initializer, withSeen(ctx, decl));
  }
  return UNRESOLVED_RESOLUTION;
}

function resolveConstructMember(access: Expression, ctx: CalleeContext): TargetResolution {
  if (!isPropertyAccessExpression(access) && !isElementAccessExpression(access)) {
    return UNRESOLVED_RESOLUTION;
  }
  const method = memberNameOf(access);
  if (method === undefined) return UNRESOLVED_RESOLUTION;
  const receiver = unwrapCalleeExpression(access.expression);
  if (isBenignBuiltInMemberCall(receiver, method, builtInCheckOf(ctx))) return EMPTY_RESOLUTION;
  const propValues = resolveObjectPropertyExpressions(access.expression, method, ctx);
  if (propValues === undefined || propValues.length === 0) return UNRESOLVED_RESOLUTION;
  let combined = EMPTY_RESOLUTION;
  for (const val of propValues) {
    combined = mergeResolutions(combined, resolveExpressionTargets(val, ctx));
    if (combined.unresolvable) return UNRESOLVED_RESOLUTION;
  }
  return combined;
}

function resolveCallModeTarget(current: Expression, ctx: CalleeContext): TargetResolution {
  if (isSuperExpression(current)) return resolveSuperConstructor(current, ctx);
  if (isAnswering(current)) return singleTarget(targetFromCallable(current, [current]));
  if (isIdentifier(current)) return resolveCallIdentifier(current, ctx);
  if (isCallExpression(current)) return resolveBoundCallExpression(current, ctx);
  if (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    return resolveMemberCallExpression(current, ctx);
  }
  return resolveBranchTargets(current, ctx);
}

function resolveCallIdentifier(id: Identifier, ctx: CalleeContext): TargetResolution {
  if (isBenignGlobalCallable(id, builtInCheckOf(ctx))) return EMPTY_RESOLUTION;
  const decl = frameDeclarationOf(id);
  if (decl === undefined || ctx.seen.has(decl) || !isUnreassignedDeclaration(decl)) {
    return UNRESOLVED_RESOLUTION;
  }
  if (isFunctionDeclaration(decl)) return resolveFunctionOverloadTargets(decl);
  if (isVariableDeclaration(decl) && decl.initializer !== undefined) {
    return resolveExpressionTargets(decl.initializer, withSeen(ctx, decl));
  }
  return UNRESOLVED_RESOLUTION;
}

function resolveFunctionOverloadTargets(decl: Node): TargetResolution {
  if (!isFunctionDeclaration(decl)) return UNRESOLVED_RESOLUTION;
  const impls = overloadsOf(decl).filter((each) => each.body !== undefined);
  if (impls.length === 0) return UNRESOLVED_RESOLUTION;
  return {
    effectiveSlots: undefined,
    receiverExprs: [],
    targets: impls.map((fn) => targetFromCallable(fn, [fn])),
    unresolvable: false,
  };
}

function resolveBoundCallExpression(call: CallExpression, ctx: CalleeContext): TargetResolution {
  const callee = unwrapCalleeExpression(call.expression);
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) {
    return UNRESOLVED_RESOLUTION;
  }
  const method = memberNameOf(callee);
  if (method !== 'bind' || !isStableMember(call.getSourceFile(), 'bind')) {
    return UNRESOLVED_RESOLUTION;
  }
  const bindUnfold = unfoldCallArguments(call.arguments, ctx.owner);
  if (!bindUnfold.resolved) return UNRESOLVED_RESOLUTION;
  const offsets = new Set<number>();
  for (const len of bindUnfold.lengths) offsets.add(Math.max(0, len - 1));
  let combined = EMPTY_RESOLUTION;
  for (const boundCount of offsets) {
    const mergedSlots = combineBoundAndCallSlots(bindUnfold.slots, ctx.slots, boundCount);
    const innerRes = resolveExpressionTargets(callee.expression, { ...ctx, slots: mergedSlots });
    if (innerRes.unresolvable) return UNRESOLVED_RESOLUTION;
    const shifted = shiftTargetsParamOffset(innerRes, boundCount, bindUnfold.slots.get(0));
    combined = mergeResolutions(combined, shifted);
  }
  return combined;
}

function combineBoundAndCallSlots(
  bindSlots: ReadonlyMap<number, readonly Expression[]>,
  callSlots: ReadonlyMap<number, readonly Expression[]>,
  boundCount: number,
): ReadonlyMap<number, readonly Expression[]> {
  const combined = new Map<number, Expression[]>();
  for (let index = 0; index < boundCount; index += 1) {
    const exprs = bindSlots.get(index + 1);
    if (exprs !== undefined) combined.set(index, [...exprs]);
  }
  for (const [slot, exprs] of callSlots) {
    const targetSlot = boundCount + slot;
    const existing = combined.get(targetSlot);
    if (existing === undefined) combined.set(targetSlot, [...exprs]);
    else existing.push(...exprs);
  }
  return combined;
}

function shiftTargetsParamOffset(
  res: TargetResolution,
  boundCount: number,
  boundReceivers: readonly Expression[] | undefined,
): TargetResolution {
  const targets: TargetCallable[] = res.targets.map((target) => {
    return {
      ...target,
      paramOffset: target.paramOffset + boundCount,
    };
  });
  const receiverExprs = res.receiverExprs.length > 0 ? res.receiverExprs : (boundReceivers ?? []);
  return {
    effectiveSlots: undefined,
    receiverExprs,
    targets,
    unresolvable: false,
  };
}

function resolveMemberCallExpression(access: Expression, ctx: CalleeContext): TargetResolution {
  if (!isPropertyAccessExpression(access) && !isElementAccessExpression(access)) {
    return UNRESOLVED_RESOLUTION;
  }
  const method = memberNameOf(access);
  if (method === undefined) return UNRESOLVED_RESOLUTION;
  const receiver = unwrapCalleeExpression(access.expression);
  if (globalOf(receiver) === 'Reflect') {
    if (method === 'apply') return resolveReflectApply(ctx);
    if (method === 'construct') return resolveReflectConstruct(ctx);
  }
  if (
    (method === 'call' || method === 'apply') &&
    isStableMember(access.getSourceFile(), method) &&
    isCallableDispatchReceiver(receiver)
  ) {
    return resolveCallOrApplyDispatch(access.expression, method, ctx);
  }
  return resolveReceiverMember(access.expression, method, ctx);
}

function isCallableDispatchReceiver(receiver: Expression): boolean {
  if (isAnswering(receiver)) return true;
  if (isPropertyAccessExpression(receiver) || isElementAccessExpression(receiver)) {
    const inner = unwrapCalleeExpression(receiver.expression);
    if (isPropertyAccessExpression(inner) || isElementAccessExpression(inner)) {
      return memberNameOf(inner) === 'prototype';
    }
    return false;
  }
  if (!isIdentifier(receiver)) return false;
  const decl = frameDeclarationOf(receiver);
  if (decl === undefined || !isUnreassignedDeclaration(decl)) return false;
  if (isFunctionDeclaration(decl)) return true;
  return (
    isVariableDeclaration(decl) &&
    decl.initializer !== undefined &&
    isAnswering(unwrapCalleeExpression(decl.initializer))
  );
}

function resolveCallOrApplyDispatch(
  rawFnExpr: Expression,
  method: 'apply' | 'call',
  ctx: CalleeContext,
): TargetResolution {
  const fnExpr = unwrapCalleeExpression(rawFnExpr);
  const receivers = ctx.slots.get(0) ?? [];
  if (method === 'apply') return resolveApplyDispatch(fnExpr, receivers, ctx);
  const shiftedSlots = shiftSlotsLeft(ctx.slots, 1);
  const shiftedCtx: CalleeContext = withMode({ ...ctx, slots: shiftedSlots }, 'call');
  if (isPrototypeMemberReference(fnExpr, shiftedCtx)) return EMPTY_RESOLUTION;
  const res = resolveExpressionTargets(rawFnExpr, shiftedCtx);
  if (res.unresolvable) return UNRESOLVED_RESOLUTION;
  const targets: TargetCallable[] = res.targets.map((target) => {
    return {
      ...target,
      callSlotSkip: target.callSlotSkip + 1,
    };
  });
  return withReceivers(
    { effectiveSlots: undefined, receiverExprs: [], targets, unresolvable: false },
    res.receiverExprs.length > 0 ? res.receiverExprs : receivers,
  );
}

function resolveApplyDispatch(
  fnExpr: Expression,
  receivers: readonly Expression[],
  ctx: CalleeContext,
): TargetResolution {
  const listSlots = unfoldApplyListCandidates(ctx.slots.get(1), ctx.owner);
  if (listSlots === undefined) return UNRESOLVED_RESOLUTION;
  const applyCtx: CalleeContext = { ...ctx, slots: listSlots };
  if (isPrototypeMemberReference(fnExpr, applyCtx)) {
    return { ...EMPTY_RESOLUTION, effectiveSlots: listSlots };
  }
  const res = resolveExpressionTargets(fnExpr, applyCtx);
  if (res.unresolvable) return UNRESOLVED_RESOLUTION;
  const withRecv = withReceivers(res, res.receiverExprs.length > 0 ? res.receiverExprs : receivers);
  return { ...withRecv, effectiveSlots: listSlots };
}

function resolveReflectApply(ctx: CalleeContext): TargetResolution {
  if (!isStableMember(ctx.owner.getSourceFile(), 'apply')) return UNRESOLVED_RESOLUTION;
  const targetCandidates = ctx.slots.get(0);
  if (targetCandidates === undefined || targetCandidates.length === 0) return UNRESOLVED_RESOLUTION;
  const receivers = ctx.slots.get(1) ?? [];
  const listSlots = unfoldApplyListCandidates(ctx.slots.get(2), ctx.owner);
  if (listSlots === undefined) return UNRESOLVED_RESOLUTION;
  const applyCtx: CalleeContext = { ...ctx, slots: listSlots };
  let combined: TargetResolution = { ...EMPTY_RESOLUTION, effectiveSlots: listSlots };
  for (const targetExpr of targetCandidates) {
    const unwrapped = unwrapCalleeExpression(targetExpr);
    if (isPrototypeMemberReference(unwrapped, applyCtx)) continue;
    const res = resolveExpressionTargets(targetExpr, applyCtx);
    if (res.unresolvable) return UNRESOLVED_RESOLUTION;
    const withRecv = withReceivers(
      res,
      res.receiverExprs.length > 0 ? res.receiverExprs : receivers,
    );
    combined = mergeResolutions(combined, { ...withRecv, effectiveSlots: listSlots });
  }
  return combined;
}

function resolveReflectConstruct(ctx: CalleeContext): TargetResolution {
  if (!isStableMember(ctx.owner.getSourceFile(), 'construct')) return UNRESOLVED_RESOLUTION;
  const targetCandidates = ctx.slots.get(0);
  if (targetCandidates === undefined || targetCandidates.length === 0) return UNRESOLVED_RESOLUTION;
  const listSlots = unfoldApplyListCandidates(ctx.slots.get(1), ctx.owner);
  if (listSlots === undefined) return UNRESOLVED_RESOLUTION;
  const constructCtx: CalleeContext = { ...ctx, mode: 'construct', slots: listSlots };
  const protoTargetCandidates = ctx.slots.get(2);
  if (
    protoTargetCandidates !== undefined &&
    !allConstructTargetsResolvable(protoTargetCandidates, constructCtx)
  ) {
    return UNRESOLVED_RESOLUTION;
  }
  let combined: TargetResolution = { ...EMPTY_RESOLUTION, effectiveSlots: listSlots };
  for (const targetExpr of targetCandidates) {
    const res = resolveExpressionTargets(targetExpr, constructCtx);
    if (res.unresolvable) return UNRESOLVED_RESOLUTION;
    combined = mergeResolutions(combined, { ...res, effectiveSlots: listSlots });
  }
  return combined;
}

function allConstructTargetsResolvable(
  candidates: readonly Expression[],
  ctx: CalleeContext,
): boolean {
  for (const candidate of candidates) {
    if (resolveExpressionTargets(candidate, ctx).unresolvable) return false;
  }
  return true;
}

function isPrototypeMemberReference(expr: Expression, ctx: CalleeContext): boolean {
  if (!isPropertyAccessExpression(expr) && !isElementAccessExpression(expr)) return false;
  const method = memberNameOf(expr);
  if (method === undefined) return false;
  const protoAccess = unwrapCalleeExpression(expr.expression);
  if (!isPropertyAccessExpression(protoAccess) && !isElementAccessExpression(protoAccess)) {
    return false;
  }
  if (memberNameOf(protoAccess) !== 'prototype') return false;
  return isBenignPrototypeMemberCall(
    unwrapCalleeExpression(protoAccess.expression),
    method,
    builtInCheckOf(ctx),
  );
}

function shiftSlotsLeft(
  slots: ReadonlyMap<number, readonly Expression[]>,
  amount: number,
): ReadonlyMap<number, readonly Expression[]> {
  const shifted = new Map<number, readonly Expression[]>();
  for (const [slot, exprs] of slots) {
    if (slot >= amount) shifted.set(slot - amount, exprs);
  }
  return shifted;
}

function unfoldApplyListCandidates(
  candidates: readonly Expression[] | undefined,
  owner: Node,
): ReadonlyMap<number, readonly Expression[]> | undefined {
  if (candidates === undefined || candidates.length === 0) return EMPTY_SLOTS;
  const combined = new Map<number, Expression[]>();
  for (const candidate of candidates) {
    const unfolded = unfoldApplyOperand(candidate, owner);
    if (!unfolded.resolved) return undefined;
    for (const [slot, exprs] of unfolded.slots) {
      const existing = combined.get(slot);
      if (existing === undefined) combined.set(slot, [...exprs]);
      else existing.push(...exprs);
    }
  }
  return combined;
}

function resolveBranchTargets(expr: Expression, ctx: CalleeContext): TargetResolution {
  if (isConditionalExpression(expr)) {
    return mergeResolutions(
      resolveExpressionTargets(expr.whenTrue, ctx),
      resolveExpressionTargets(expr.whenFalse, ctx),
    );
  }
  if (!isBinaryExpression(expr)) return UNRESOLVED_RESOLUTION;
  const op = expr.operatorToken.kind;
  if (op === SyntaxKind.CommaToken || isAssignmentOperator(op)) {
    return resolveExpressionTargets(expr.right, ctx);
  }
  if (LOGICAL_OPERATORS.has(op)) {
    return mergeResolutions(
      resolveExpressionTargets(expr.left, ctx),
      resolveExpressionTargets(expr.right, ctx),
    );
  }
  return UNRESOLVED_RESOLUTION;
}
