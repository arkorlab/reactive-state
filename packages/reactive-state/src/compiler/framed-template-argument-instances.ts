import {
  type Expression,
  type Identifier,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isConditionalExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, overloadsOf, returnedBy } from './answers.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import {
  type CalleeContext,
  consumeCalleeStep,
  withSeen,
} from './framed-template-argument-classes.ts';
import {
  type ClassLike,
  declarationValueExpressions,
  isNullishExpression,
  isUnreassignedDeclaration,
  unwrapCalleeExpression,
} from './framed-template-argument-receivers.ts';
import { LOGICAL_OPERATORS } from './framed-template-argument-spreads.ts';

/**
 * Constructed class instance and factory-instance target resolution for template-tag `arguments`
 * taint analysis.
 */

export function resolveConstructedClasses(
  rawExpr: Expression,
  ctx: CalleeContext,
): readonly ClassLike[] | undefined {
  let curExpr = rawExpr;
  let curCtx = ctx;
  for (;;) {
    if (!consumeCalleeStep(curCtx)) return undefined;
    const current = unwrapCalleeExpression(curExpr);
    if (curCtx.seen.has(current)) return undefined;
    const nextCtx = withSeen(curCtx, current);
    if (isNullishExpression(current)) return [];
    if (isNewExpression(current)) return resolveClassCalleeTargets(current.expression);
    const forwarded = forwardSingleExpression(current, nextCtx);
    if (forwarded !== undefined) {
      curExpr = forwarded.expr;
      curCtx = forwarded.ctx;
      continue;
    }
    return resolveCompoundConstructedClasses(current, nextCtx);
  }
}

function forwardSingleExpression(
  current: Expression,
  nextCtx: CalleeContext,
): { readonly ctx: CalleeContext; readonly expr: Expression } | undefined {
  if (isIdentifier(current)) {
    const decl = frameDeclarationOf(current);
    if (decl === undefined || nextCtx.seen.has(decl)) return undefined;
    const values = declarationValueExpressions(decl);
    if (values?.length !== 1 || values[0] === undefined) return undefined;
    return { ctx: withSeen(nextCtx, decl), expr: values[0] };
  }
  if (isBinaryExpression(current)) {
    const op = current.operatorToken.kind;
    if (op === SyntaxKind.CommaToken || op === SyntaxKind.EqualsToken) {
      return { ctx: nextCtx, expr: current.right };
    }
  }
  return undefined;
}

function resolveCompoundConstructedClasses(
  current: Expression,
  nextCtx: CalleeContext,
): readonly ClassLike[] | undefined {
  if (isIdentifier(current)) return resolveMultiBindingClasses(current, nextCtx);
  if (isCallExpression(current)) return resolveFactoryConstructedClasses(current, nextCtx);
  if (isConditionalExpression(current)) {
    return mergeClassLists(
      resolveConstructedClasses(current.whenTrue, nextCtx),
      resolveConstructedClasses(current.whenFalse, nextCtx),
    );
  }
  if (isBinaryExpression(current) && LOGICAL_OPERATORS.has(current.operatorToken.kind)) {
    return mergeClassLists(
      resolveConstructedClasses(current.left, nextCtx),
      resolveConstructedClasses(current.right, nextCtx),
    );
  }
  return undefined;
}

function resolveMultiBindingClasses(
  id: Identifier,
  ctx: CalleeContext,
): readonly ClassLike[] | undefined {
  const decl = frameDeclarationOf(id);
  if (decl === undefined || ctx.seen.has(decl)) return undefined;
  const values = declarationValueExpressions(decl);
  if (values === undefined || values.length === 0) return undefined;
  const seenCtx = withSeen(ctx, decl);
  let all: readonly ClassLike[] = [];
  for (const val of values) {
    const resolved = resolveConstructedClasses(val, seenCtx);
    if (resolved === undefined) return undefined;
    all = [...all, ...resolved];
  }
  return all;
}

function resolveFactoryConstructedClasses(
  call: Expression,
  ctx: CalleeContext,
): readonly ClassLike[] | undefined {
  if (!isCallExpression(call)) return undefined;
  const fns = resolveFactoryFunctions(call.expression);
  if (fns === undefined || fns.length === 0) return undefined;
  let all: readonly ClassLike[] = [];
  for (const fn of fns) {
    if (ctx.seen.has(fn)) return undefined;
    const returns = returnedBy(fn);
    if (returns.length === 0) return undefined;
    const fnCtx = withSeen(ctx, fn);
    for (const ret of returns) {
      const next = resolveConstructedClasses(ret, fnCtx);
      if (next === undefined) return undefined;
      all = [...all, ...next];
    }
  }
  return all;
}

function resolveFactoryFunctions(
  rawCallee: Expression,
  seen: ReadonlySet<Node> = new Set(),
): readonly Answering[] | undefined {
  const callee = unwrapCalleeExpression(rawCallee);
  if (seen.has(callee)) return undefined;
  if (isNullishExpression(callee)) return [];
  if (isArrowFunction(callee) || isFunctionExpression(callee)) return [callee];
  const nextSeen = new Set([...seen, callee]);
  if (isIdentifier(callee)) return resolveIdentifierFactoryFunctions(callee, nextSeen);
  if (isConditionalExpression(callee)) {
    return mergeClassLists(
      resolveFactoryFunctions(callee.whenTrue, nextSeen),
      resolveFactoryFunctions(callee.whenFalse, nextSeen),
    );
  }
  return resolveBinaryFactoryFunctions(callee, nextSeen);
}

function resolveIdentifierFactoryFunctions(
  id: Identifier,
  seen: ReadonlySet<Node>,
): readonly Answering[] | undefined {
  const decl = frameDeclarationOf(id);
  if (decl === undefined || seen.has(decl)) return undefined;
  if (isFunctionDeclaration(decl)) {
    if (!isUnreassignedDeclaration(decl)) return undefined;
    const impls = overloadsOf(decl).filter((each) => each.body !== undefined);
    return impls.length === 1 && impls[0] !== undefined ? [impls[0]] : undefined;
  }
  const values = declarationValueExpressions(decl);
  if (values === undefined || values.length === 0) return undefined;
  const nextSeen = new Set([...seen, decl]);
  let all: readonly Answering[] = [];
  for (const val of values) {
    const resolved = resolveFactoryFunctions(val, nextSeen);
    if (resolved === undefined) return undefined;
    all = [...all, ...resolved];
  }
  return all;
}

function resolveBinaryFactoryFunctions(
  expr: Expression,
  seen: ReadonlySet<Node>,
): readonly Answering[] | undefined {
  if (!isBinaryExpression(expr)) return undefined;
  const op = expr.operatorToken.kind;
  if (op === SyntaxKind.CommaToken || op === SyntaxKind.EqualsToken) {
    return resolveFactoryFunctions(expr.right, seen);
  }
  return LOGICAL_OPERATORS.has(op)
    ? mergeClassLists(
        resolveFactoryFunctions(expr.left, seen),
        resolveFactoryFunctions(expr.right, seen),
      )
    : undefined;
}

export function resolveClassCalleeTargets(
  rawCallee: Expression,
  seen: ReadonlySet<Node> = new Set(),
): readonly ClassLike[] | undefined {
  const current = unwrapCalleeExpression(rawCallee);
  if (seen.has(current)) return undefined;
  if (isNullishExpression(current)) return [];
  if (isClassExpression(current)) return [current];
  const nextSeen = new Set([...seen, current]);
  if (isIdentifier(current)) return resolveIdentifierClassTargets(current, nextSeen);
  if (isConditionalExpression(current)) {
    return mergeClassLists(
      resolveClassCalleeTargets(current.whenTrue, nextSeen),
      resolveClassCalleeTargets(current.whenFalse, nextSeen),
    );
  }
  return resolveBinaryClassTargets(current, nextSeen);
}

function resolveIdentifierClassTargets(
  id: Identifier,
  seen: ReadonlySet<Node>,
): readonly ClassLike[] | undefined {
  const decl = frameDeclarationOf(id);
  if (decl === undefined || seen.has(decl)) return undefined;
  if (isClassDeclaration(decl)) return isUnreassignedDeclaration(decl) ? [decl] : undefined;
  const values = declarationValueExpressions(decl);
  if (values === undefined || values.length === 0) return undefined;
  const nextSeen = new Set([...seen, decl]);
  let collected: readonly ClassLike[] = [];
  for (const candidate of values) {
    const resolved = resolveClassCalleeTargets(candidate, nextSeen);
    if (resolved === undefined) return undefined;
    collected = [...collected, ...resolved];
  }
  return collected.length > 0 ? collected : undefined;
}

function resolveBinaryClassTargets(
  expr: Expression,
  seen: ReadonlySet<Node>,
): readonly ClassLike[] | undefined {
  if (!isBinaryExpression(expr)) return undefined;
  const op = expr.operatorToken.kind;
  if (op === SyntaxKind.CommaToken || op === SyntaxKind.EqualsToken) {
    return resolveClassCalleeTargets(expr.right, seen);
  }
  return LOGICAL_OPERATORS.has(op)
    ? mergeClassLists(
        resolveClassCalleeTargets(expr.left, seen),
        resolveClassCalleeTargets(expr.right, seen),
      )
    : undefined;
}

function mergeClassLists<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): readonly T[] | undefined {
  return left === undefined || right === undefined ? undefined : [...left, ...right];
}
