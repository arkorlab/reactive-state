import {
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSuperExpression,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { frameDeclarationOf } from './framed-bindings.ts';
import { isBenignBuiltInMemberCall } from './framed-template-argument-builtins.ts';
import {
  builtInCheckOf,
  type CalleeContext,
  consumeCalleeStep,
  EMPTY_RESOLUTION,
  enclosingThisHost,
  mergeResolutions,
  mergeSubclassOverrides,
  resolveClassMember,
  resolveSuperMember,
  singleTarget,
  type TargetResolution,
  targetFromCallable,
  UNRESOLVED_RESOLUTION,
  withMode,
  withReceivers,
  withSeen,
} from './framed-template-argument-classes.ts';
import { resolveConstructedClasses } from './framed-template-argument-instances.ts';
import {
  type ClassLike,
  declarationValueExpressions,
  declaredMemberKey,
  isNullishExpression,
  isStableMember,
  isUnreassignedDeclaration,
  memberNameOf,
  unwrapCalleeExpression,
} from './framed-template-argument-receivers.ts';
import { LOGICAL_OPERATORS } from './framed-template-argument-spreads.ts';

/**
 * Receiver member (`o.f`, `this.f`, `super.f`, spreads, nested objects, and constructed instances)
 * and object-property expression resolution for template-tag `arguments` taint analysis.
 */

export function resolveThisMember(
  thisExpr: Expression,
  method: string,
  ctx: CalleeContext,
): TargetResolution {
  const host = enclosingThisHost(thisExpr);
  if (host === undefined) return UNRESOLVED_RESOLUTION;
  if (host.kind === 'class') {
    const baseRes = resolveClassMember(host.cls, method, host.isStatic, ctx);
    if (baseRes.unresolvable || host.isStatic) return baseRes;
    return mergeSubclassOverrides(host.cls, method, baseRes, ctx);
  }
  if (host.kind === 'object') {
    return isStableMember(thisExpr.getSourceFile(), method)
      ? resolveObjectLiteralMember(host.obj, method, ctx)
      : UNRESOLVED_RESOLUTION;
  }
  return UNRESOLVED_RESOLUTION;
}

export function resolveReceiverMember(
  rawReceiver: Expression,
  method: string,
  ctx: CalleeContext,
): TargetResolution {
  const res = resolveReceiverMemberInner(rawReceiver, method, ctx);
  return withReceivers(res, [rawReceiver]);
}

function resolveReceiverMemberInner(
  rawReceiver: Expression,
  method: string,
  ctx: CalleeContext,
): TargetResolution {
  if (!consumeCalleeStep(ctx)) return UNRESOLVED_RESOLUTION;
  const current = unwrapCalleeExpression(rawReceiver);
  if (ctx.seen.has(current)) return UNRESOLVED_RESOLUTION;
  const nextCtx = withSeen(ctx, current);
  if (current.kind === SyntaxKind.ThisKeyword) return resolveThisMember(current, method, nextCtx);
  if (isSuperExpression(current)) return resolveSuperMember(current, method, nextCtx);
  if (isNullishExpression(current)) return EMPTY_RESOLUTION;
  if (isBenignBuiltInMemberCall(current, method, builtInCheckOf(nextCtx))) return EMPTY_RESOLUTION;
  const ownerDecl = isIdentifier(current) ? frameDeclarationOf(current) : undefined;
  if (!isStableMember(current.getSourceFile(), method, ownerDecl)) return UNRESOLVED_RESOLUTION;
  if (isObjectLiteralExpression(current)) {
    return resolveObjectLiteralMember(current, method, nextCtx);
  }
  if (isClassExpression(current)) return resolveClassMember(current, method, true, nextCtx);
  if (isNewExpression(current) || isCallExpression(current)) {
    return resolveConstructedInstanceMember(current, method, ctx);
  }
  if (isIdentifier(current)) return resolveIdentifierReceiverMember(current, method, nextCtx);
  if (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    return resolveNestedAccessReceiverMember(current, method, nextCtx);
  }
  return resolveBranchReceiverMember(current, method, nextCtx);
}

function resolveConstructedInstanceMember(
  expr: Expression,
  method: string,
  ctx: CalleeContext,
): TargetResolution {
  const classes = resolveConstructedClasses(expr, ctx);
  return classes === undefined || classes.length === 0
    ? UNRESOLVED_RESOLUTION
    : resolveClassListMember(classes, method, withSeen(ctx, expr));
}

function resolveIdentifierReceiverMember(
  id: Identifier,
  method: string,
  ctx: CalleeContext,
): TargetResolution {
  const decl = frameDeclarationOf(id);
  if (decl === undefined || ctx.seen.has(decl)) return UNRESOLVED_RESOLUTION;
  const seenCtx = withSeen(ctx, decl);
  if (isClassDeclaration(decl)) {
    return isUnreassignedDeclaration(decl)
      ? resolveClassMember(decl, method, true, seenCtx)
      : UNRESOLVED_RESOLUTION;
  }
  const values = declarationValueExpressions(decl);
  if (values === undefined || values.length === 0) return UNRESOLVED_RESOLUTION;
  let combined = EMPTY_RESOLUTION;
  for (const val of values) {
    combined = mergeResolutions(combined, resolveCandidateReceiverMember(val, method, seenCtx));
    if (combined.unresolvable) return UNRESOLVED_RESOLUTION;
  }
  return combined;
}

function resolveCandidateReceiverMember(
  rawInit: Expression,
  method: string,
  ctx: CalleeContext,
): TargetResolution {
  const init = unwrapCalleeExpression(rawInit);
  if (isClassExpression(init)) return resolveClassMember(init, method, true, ctx);
  const classes = resolveConstructedClasses(init, ctx);
  return classes !== undefined && classes.length > 0
    ? resolveClassListMember(classes, method, ctx)
    : resolveReceiverMemberInner(init, method, ctx);
}

function resolveClassListMember(
  classes: readonly ClassLike[],
  method: string,
  ctx: CalleeContext,
): TargetResolution {
  let combined = EMPTY_RESOLUTION;
  for (const cls of classes) {
    combined = mergeResolutions(combined, resolveClassMember(cls, method, false, ctx));
    if (combined.unresolvable) return UNRESOLVED_RESOLUTION;
  }
  return combined;
}

function resolveNestedAccessReceiverMember(
  access: Expression,
  method: string,
  ctx: CalleeContext,
): TargetResolution {
  if (!isPropertyAccessExpression(access) && !isElementAccessExpression(access)) {
    return UNRESOLVED_RESOLUTION;
  }
  const outerKey = memberNameOf(access);
  if (outerKey === undefined) return UNRESOLVED_RESOLUTION;
  const values = resolveObjectPropertyExpressions(access.expression, outerKey, ctx);
  if (values === undefined || values.length === 0) return UNRESOLVED_RESOLUTION;
  let combined = EMPTY_RESOLUTION;
  for (const val of values) {
    combined = mergeResolutions(combined, resolveReceiverMemberInner(val, method, ctx));
    if (combined.unresolvable) return UNRESOLVED_RESOLUTION;
  }
  return combined;
}

function resolveBranchReceiverMember(
  expr: Expression,
  method: string,
  ctx: CalleeContext,
): TargetResolution {
  if (isConditionalExpression(expr)) {
    return mergeResolutions(
      resolveReceiverMemberInner(expr.whenTrue, method, ctx),
      resolveReceiverMemberInner(expr.whenFalse, method, ctx),
    );
  }
  if (!isBinaryExpression(expr)) return UNRESOLVED_RESOLUTION;
  const op = expr.operatorToken.kind;
  if (op === SyntaxKind.CommaToken || op === SyntaxKind.EqualsToken) {
    return resolveReceiverMemberInner(expr.right, method, ctx);
  }
  if (LOGICAL_OPERATORS.has(op)) {
    return mergeResolutions(
      resolveReceiverMemberInner(expr.left, method, ctx),
      resolveReceiverMemberInner(expr.right, method, ctx),
    );
  }
  return UNRESOLVED_RESOLUTION;
}

export function resolveObjectPropertyExpressions(
  rawReceiver: Expression,
  key: string,
  ctx: CalleeContext,
): readonly Expression[] | undefined {
  let curExpr = rawReceiver;
  let curCtx = ctx;
  for (;;) {
    const stepped = preparePropertyLookupStep(curExpr, key, curCtx);
    if (stepped === undefined) return undefined;
    const { current, nextCtx } = stepped;
    if (isNullishExpression(current)) return [];
    if (isObjectLiteralExpression(current)) return findObjectLiteralValues(current, key, nextCtx);
    const forwarded = forwardLinearExpression(current, nextCtx);
    if (forwarded !== undefined) {
      curExpr = forwarded.expr;
      curCtx = forwarded.ctx;
      continue;
    }
    return resolveBranchObjectPropertyExpressions(current, key, nextCtx);
  }
}

function preparePropertyLookupStep(
  rawExpr: Expression,
  key: string,
  ctx: CalleeContext,
): { readonly current: Expression; readonly nextCtx: CalleeContext } | undefined {
  if (!consumeCalleeStep(ctx)) return undefined;
  const current = unwrapCalleeExpression(rawExpr);
  if (ctx.seen.has(current)) return undefined;
  const ownerDecl = isIdentifier(current) ? frameDeclarationOf(current) : undefined;
  if (!isStableMember(current.getSourceFile(), key, ownerDecl)) return undefined;
  return { current, nextCtx: withSeen(ctx, current) };
}

function forwardLinearExpression(
  current: Expression,
  nextCtx: CalleeContext,
): { readonly ctx: CalleeContext; readonly expr: Expression } | undefined {
  if (isIdentifier(current)) return stepSingleBindingValue(current, nextCtx);
  if (isBinaryExpression(current)) {
    const op = current.operatorToken.kind;
    if (op === SyntaxKind.CommaToken || op === SyntaxKind.EqualsToken) {
      return { ctx: nextCtx, expr: current.right };
    }
  }
  return undefined;
}

function resolveBranchObjectPropertyExpressions(
  current: Expression,
  key: string,
  nextCtx: CalleeContext,
): readonly Expression[] | undefined {
  if (isIdentifier(current)) {
    return resolveMultiBindingList(current, nextCtx, (val, seenCtx) =>
      resolveObjectPropertyExpressions(val, key, seenCtx),
    );
  }
  if (isConditionalExpression(current)) {
    return mergeOptionalLists(
      resolveObjectPropertyExpressions(current.whenTrue, key, nextCtx),
      resolveObjectPropertyExpressions(current.whenFalse, key, nextCtx),
    );
  }
  if (isBinaryExpression(current) && LOGICAL_OPERATORS.has(current.operatorToken.kind)) {
    return mergeOptionalLists(
      resolveObjectPropertyExpressions(current.left, key, nextCtx),
      resolveObjectPropertyExpressions(current.right, key, nextCtx),
    );
  }
  return undefined;
}

function stepSingleBindingValue(
  id: Identifier,
  ctx: CalleeContext,
): { readonly ctx: CalleeContext; readonly expr: Expression } | undefined {
  const decl = frameDeclarationOf(id);
  if (decl === undefined || ctx.seen.has(decl)) return undefined;
  const values = declarationValueExpressions(decl);
  if (values?.length !== 1 || values[0] === undefined) return undefined;
  return { ctx: withSeen(ctx, decl), expr: values[0] };
}

function resolveMultiBindingList<T>(
  id: Identifier,
  ctx: CalleeContext,
  step: (expr: Expression, nextCtx: CalleeContext) => readonly T[] | undefined,
): readonly T[] | undefined {
  const decl = frameDeclarationOf(id);
  if (decl === undefined || ctx.seen.has(decl)) return undefined;
  const values = declarationValueExpressions(decl);
  if (values === undefined || values.length === 0) return undefined;
  const seenCtx = withSeen(ctx, decl);
  let all: readonly T[] = [];
  for (const val of values) {
    const resolved = step(val, seenCtx);
    if (resolved === undefined) return undefined;
    all = [...all, ...resolved];
  }
  return all;
}

function mergeOptionalLists<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): readonly T[] | undefined {
  return left === undefined || right === undefined ? undefined : [...left, ...right];
}

function findObjectLiteralValues(
  obj: ObjectLiteralExpression,
  key: string,
  ctx: CalleeContext,
): readonly Expression[] | undefined {
  const collected: Expression[] = [];
  for (let index = obj.properties.length - 1; index >= 0; index -= 1) {
    const prop = obj.properties[index];
    if (prop === undefined) continue;
    const outcome = stepObjectPropertyValue(prop, key, collected, ctx);
    if (outcome === 'abort') return undefined;
    if (outcome === 'done') return collected;
  }
  return collected.length > 0 ? collected : undefined;
}

function stepObjectPropertyValue(
  prop: ObjectLiteralElementLike,
  key: string,
  collected: Expression[],
  ctx: CalleeContext,
): 'abort' | 'continue' | 'done' {
  if (isSpreadAssignment(prop)) {
    const spreadVals = resolveObjectPropertyExpressions(prop.expression, key, ctx);
    if (spreadVals === undefined) return 'abort';
    collected.push(...spreadVals);
    return 'continue';
  }
  const info = declaredMemberKey(objectElementName(prop));
  if (info.dynamic) return 'abort';
  if (info.key !== key) return 'continue';
  if (isPropertyAssignment(prop)) {
    collected.push(prop.initializer);
    return 'done';
  }
  if (isShorthandPropertyAssignment(prop) && isIdentifier(prop.name)) {
    collected.push(prop.name);
    return 'done';
  }
  return 'abort';
}

function resolveObjectLiteralMember(
  obj: ObjectLiteralExpression,
  method: string,
  ctx: CalleeContext,
): TargetResolution {
  let combined: TargetResolution | undefined;
  for (let index = obj.properties.length - 1; index >= 0; index -= 1) {
    const prop = obj.properties[index];
    if (prop === undefined) continue;
    if (isSpreadAssignment(prop)) {
      combined = accumulateSpreadMember(prop.expression, method, combined, ctx);
      if (combined?.unresolvable === true) return UNRESOLVED_RESOLUTION;
      continue;
    }
    const matched = matchDirectObjectPropertyMember(prop, method, ctx);
    if (matched !== undefined) {
      return combined === undefined ? matched : mergeResolutions(combined, matched);
    }
  }
  return combined ?? UNRESOLVED_RESOLUTION;
}

function accumulateSpreadMember(
  spreadExpr: Expression,
  method: string,
  combined: TargetResolution | undefined,
  ctx: CalleeContext,
): TargetResolution | undefined {
  const spreadRes = resolveReceiverMemberInner(spreadExpr, method, ctx);
  if (spreadRes.unresolvable) return UNRESOLVED_RESOLUTION;
  if (spreadRes.targets.length === 0) return combined;
  return combined === undefined ? spreadRes : mergeResolutions(combined, spreadRes);
}

function objectElementName(prop: ObjectLiteralElementLike): PropertyName | undefined {
  if (
    isMethodDeclaration(prop) ||
    isPropertyAssignment(prop) ||
    isShorthandPropertyAssignment(prop) ||
    isGetAccessorDeclaration(prop) ||
    isSetAccessorDeclaration(prop)
  ) {
    return prop.name;
  }
  return undefined;
}

function matchDirectObjectPropertyMember(
  prop: ObjectLiteralElementLike,
  method: string,
  ctx: CalleeContext,
): TargetResolution | undefined {
  const info = declaredMemberKey(objectElementName(prop));
  if (info.dynamic) return UNRESOLVED_RESOLUTION;
  if (info.key !== method) return undefined;
  return resolveObjectPropertyMember(prop, ctx);
}

function resolveObjectPropertyMember(
  prop: ObjectLiteralElementLike,
  ctx: CalleeContext,
): TargetResolution {
  if (isMethodDeclaration(prop)) {
    return prop.body === undefined
      ? UNRESOLVED_RESOLUTION
      : singleTarget(targetFromCallable(prop, [prop]));
  }
  if (isPropertyAssignment(prop)) {
    return ctx.resolveExpr(prop.initializer, withMode(ctx, 'call'));
  }
  if (isShorthandPropertyAssignment(prop) && isIdentifier(prop.name)) {
    return ctx.resolveExpr(prop.name, withMode(ctx, 'call'));
  }
  return UNRESOLVED_RESOLUTION;
}
