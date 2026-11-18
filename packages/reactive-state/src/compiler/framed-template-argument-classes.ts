import {
  type ClassElement,
  type ConstructorDeclaration,
  type Expression,
  type GetAccessorDeclaration,
  isArrowFunction,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isDecorator,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isSourceFile,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type PropertyDeclaration,
  type SetAccessorDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import type { Answering } from './answers.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import {
  type BuiltInCallCheck,
  isBenignGlobalCallable,
} from './framed-template-argument-builtins.ts';
import {
  callableParametersOf,
  type ClassLike,
  declaredMemberKey,
  fileMutationSummary,
  hasParameterProperty,
  isStableMember,
  resolveDirectBaseClass,
  resolveDirectBaseExpression,
  type TaintKey,
  unwrapCalleeExpression,
} from './framed-template-argument-receivers.ts';
import { outermost } from './framed-written-targets.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/**
 * Class constructor, `this`/`super` host, class member, subclass override, and constructed-class
 * resolution for template-tag `arguments` taint analysis.
 */

export type EnclosingThisHost =
  | { readonly cls: ClassLike; readonly isStatic: boolean; readonly kind: 'class' }
  | { readonly fn: TaintKey; readonly kind: 'function' }
  | { readonly kind: 'object'; readonly obj: ObjectLiteralExpression };

export type InvocationMode = 'call' | 'construct';

export interface TargetCallable {
  readonly bodyNodes: readonly Node[];
  readonly callSlotSkip: number;
  readonly callableNode: Answering | ConstructorDeclaration | undefined;
  readonly mentionsThis: boolean;
  readonly paramOffset: number;
  readonly parameters: readonly ParameterDeclaration[];
  readonly readsOwnArguments: boolean;
  readonly thisKey: TaintKey | undefined;
}

export interface TargetResolution {
  readonly effectiveSlots: ReadonlyMap<number, readonly Expression[]> | undefined;
  readonly receiverExprs: readonly Expression[];
  readonly targets: readonly TargetCallable[];
  readonly unresolvable: boolean;
}

export interface CalleeContext {
  readonly budget: { steps: number };
  readonly isResolvedCallback: (expr: Expression) => boolean;
  readonly mode: InvocationMode;
  readonly owner: Node;
  readonly resolveExpr: (expr: Expression, ctx: CalleeContext) => TargetResolution;
  readonly seen: ReadonlySet<Node>;
  readonly slots: ReadonlyMap<number, readonly Expression[]>;
}

type NamedClassMember =
  | GetAccessorDeclaration
  | MethodDeclaration
  | PropertyDeclaration
  | SetAccessorDeclaration;

const MAX_CALLEE_STEPS = 64;
const NO_EXPRESSIONS: readonly Expression[] = [];
const NO_PARAMS: readonly ParameterDeclaration[] = [];
const NO_TARGETS: readonly TargetCallable[] = [];

export const EMPTY_RESOLUTION: TargetResolution = {
  effectiveSlots: undefined,
  receiverExprs: NO_EXPRESSIONS,
  targets: NO_TARGETS,
  unresolvable: false,
};

export const UNRESOLVED_RESOLUTION: TargetResolution = {
  effectiveSlots: undefined,
  receiverExprs: NO_EXPRESSIONS,
  targets: NO_TARGETS,
  unresolvable: true,
};

export function consumeCalleeStep(ctx: CalleeContext): boolean {
  ctx.budget.steps += 1;
  return ctx.budget.steps <= MAX_CALLEE_STEPS;
}

export function withSeen(ctx: CalleeContext, node: Node): CalleeContext {
  return { ...ctx, seen: new Set([...ctx.seen, node]) };
}

export function withMode(ctx: CalleeContext, mode: InvocationMode): CalleeContext {
  return ctx.mode === mode ? ctx : { ...ctx, mode };
}

export function builtInCheckOf(ctx: CalleeContext): BuiltInCallCheck {
  return { isResolvedCallback: ctx.isResolvedCallback, slots: ctx.slots };
}

export function singleTarget(target: TargetCallable): TargetResolution {
  return {
    effectiveSlots: undefined,
    receiverExprs: NO_EXPRESSIONS,
    targets: [target],
    unresolvable: false,
  };
}

export function withReceivers(
  res: TargetResolution,
  receivers: readonly Expression[],
): TargetResolution {
  if (res.unresolvable || res.targets.length === 0 || receivers.length === 0) return res;
  return { ...res, receiverExprs: [...res.receiverExprs, ...receivers] };
}

export function mergeResolutions(
  left: TargetResolution,
  right: TargetResolution,
): TargetResolution {
  if (left.unresolvable || right.unresolvable) return UNRESOLVED_RESOLUTION;
  if (left.targets.length === 0 && left.effectiveSlots === undefined) return right;
  if (right.targets.length === 0 && right.effectiveSlots === undefined) return left;
  return {
    effectiveSlots: mergeEffectiveSlots(left.effectiveSlots, right.effectiveSlots),
    receiverExprs: [...left.receiverExprs, ...right.receiverExprs],
    targets: [...left.targets, ...right.targets],
    unresolvable: false,
  };
}

function mergeEffectiveSlots(
  left: ReadonlyMap<number, readonly Expression[]> | undefined,
  right: ReadonlyMap<number, readonly Expression[]> | undefined,
): ReadonlyMap<number, readonly Expression[]> | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  const merged = new Map<number, Expression[]>();
  for (const [slot, exprs] of left) merged.set(slot, [...exprs]);
  for (const [slot, exprs] of right) {
    const existing = merged.get(slot);
    if (existing === undefined) merged.set(slot, [...exprs]);
    else existing.push(...exprs);
  }
  return merged;
}

export function targetFromCallable(
  fn: Answering | ConstructorDeclaration,
  bodyNodes: readonly Node[],
): TargetCallable {
  const parameters = callableParametersOf(fn);
  const mentionsThis =
    callableMentionsThis(fn) ||
    (isConstructorDeclaration(fn) && parameters.some((param) => hasParameterProperty(param)));
  return {
    bodyNodes,
    callSlotSkip: 0,
    callableNode: fn,
    mentionsThis,
    paramOffset: 0,
    parameters,
    readsOwnArguments: callableReadsOwnArguments(fn),
    thisKey: thisKeyOfCallable(fn),
  };
}

function emptyConstructorTarget(cls: ClassLike, bodyNodes: readonly Node[]): TargetCallable {
  return {
    bodyNodes,
    callSlotSkip: 0,
    callableNode: undefined,
    mentionsThis: bodyNodes.some((node) => callableMentionsThis(node)),
    paramOffset: 0,
    parameters: NO_PARAMS,
    readsOwnArguments: false,
    thisKey: hasClassDecorators(cls) ? undefined : cls,
  };
}

export function hasClassDecorators(cls: ClassLike): boolean {
  if (cls.modifiers?.some((mod) => isDecorator(mod)) === true) return true;
  return cls.members.some((member) => {
    return (
      (isNamedClassMember(member) || isConstructorDeclaration(member)) &&
      member.modifiers?.some((mod) => isDecorator(mod)) === true
    );
  });
}

export function bindsOwnArguments(node: Node): boolean {
  return (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isPropertyDeclaration(node) ||
    isClassStaticBlockDeclaration(node)
  );
}

export function enclosingArgumentsCallable(node: Node): Node | undefined {
  let within: Node = node;
  let fromParamDecorator = false;
  for (let at: Node = node.parent; !isSourceFile(at); within = at, at = at.parent) {
    const inHeader =
      isDecorator(within) ||
      (isParameterDeclaration(within) && fromParamDecorator) ||
      isComputedPropertyName(within);
    fromParamDecorator = isDecorator(within) && isParameterDeclaration(at);
    if (inHeader || !bindsOwnArguments(at)) continue;
    return isClassStaticBlockDeclaration(at) || isPropertyDeclaration(at) ? undefined : at;
  }
  return undefined;
}

export function enclosingThisHost(node: Node): EnclosingThisHost | undefined {
  let within: Node = node;
  for (let at: Node = node.parent; !isSourceFile(at); within = at, at = at.parent) {
    if (isDecorator(within) || isComputedPropertyName(within)) continue;
    if (!bindsOwnArguments(at)) continue;
    if (isFunctionDeclaration(at)) return { fn: at, kind: 'function' };
    if (isFunctionExpression(at)) return hostFromFunctionExpression(at);
    return hostFromMemberContainer(at);
  }
  return undefined;
}

function hostFromMemberContainer(member: Node): EnclosingThisHost | undefined {
  const { parent } = member;
  if (isClassDeclaration(parent) || isClassExpression(parent)) {
    const isStatic =
      isClassStaticBlockDeclaration(member) ||
      (isNamedClassMember(member) && isStaticMember(member));
    return { cls: parent, isStatic, kind: 'class' };
  }
  return isObjectLiteralExpression(parent) ? { kind: 'object', obj: parent } : undefined;
}

function hostFromFunctionExpression(fn: Node): EnclosingThisHost | undefined {
  if (!isFunctionExpression(fn)) return undefined;
  const outer = outermost(fn);
  const { parent } = outer;
  return isPropertyAssignment(parent) &&
    parent.initializer === outer &&
    isObjectLiteralExpression(parent.parent)
    ? { kind: 'object', obj: parent.parent }
    : { fn, kind: 'function' };
}

function thisKeyOfHost(host: EnclosingThisHost | undefined): TaintKey | undefined {
  if (host === undefined) return undefined;
  if (host.kind === 'class') return hasClassDecorators(host.cls) ? undefined : host.cls;
  return host.kind === 'object' ? host.obj : host.fn;
}

export function thisKeyOfNode(node: Node): TaintKey | undefined {
  return thisKeyOfHost(enclosingThisHost(node));
}

export function thisKeyOfCallable(fn: Node): TaintKey | undefined {
  if (isArrowFunction(fn)) return thisKeyOfNode(fn);
  if (isFunctionDeclaration(fn)) return fn;
  if (isFunctionExpression(fn)) return thisKeyOfHost(hostFromFunctionExpression(fn));
  if (
    isConstructorDeclaration(fn) ||
    isMethodDeclaration(fn) ||
    isGetAccessorDeclaration(fn) ||
    isSetAccessorDeclaration(fn)
  ) {
    return thisKeyOfHost(hostFromMemberContainer(fn));
  }
  return undefined;
}

export function callableReadsOwnArguments(fn: Node): boolean {
  if (!bindsOwnArguments(fn)) return false;
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (isImplicitOwnArgumentsRead(node, fn)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

function isImplicitOwnArgumentsRead(node: Node, fn: Node): boolean {
  if (!isIdentifier(node) || node.text !== 'arguments' || !readsBinding(node)) return false;
  if (enclosingArgumentsCallable(node) !== fn) return false;
  const decl = frameDeclarationOf(node);
  return decl === undefined || decl.pos < fn.pos || decl.end > fn.end;
}

export function callableMentionsThis(fn: Node): boolean {
  const pending: Node[] = [fn];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (node !== fn && bindsOwnArguments(node)) continue;
    if (node.kind === SyntaxKind.ThisKeyword || node.kind === SyntaxKind.SuperKeyword) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

export function resolveClassConstructor(cls: ClassLike, ctx: CalleeContext): TargetResolution {
  const extraBodies: Node[] = [];
  let curCtx = ctx;
  for (let current: ClassLike = cls; ;) {
    if (!consumeCalleeStep(curCtx) || curCtx.seen.has(current) || hasClassDecorators(current)) {
      return UNRESOLVED_RESOLUTION;
    }
    collectInstancePropertyInitializers(current, extraBodies);
    const ctor = findConstructorImplementation(current.members);
    if (ctor !== undefined) return buildClassConstructorResolution(cls, ctor, extraBodies);
    const baseExpr = resolveDirectBaseExpression(current);
    if (baseExpr === undefined) return singleTarget(emptyConstructorTarget(cls, extraBodies));
    const baseCls = resolveDirectBaseClass(current);
    if (baseCls === undefined) return resolveExternalBaseConstructor(baseExpr, curCtx);
    curCtx = withSeen(curCtx, current);
    current = baseCls;
  }
}

function buildClassConstructorResolution(
  cls: ClassLike,
  ctor: ConstructorDeclaration,
  extraBodies: readonly Node[],
): TargetResolution {
  const target = targetFromCallable(ctor, [ctor, ...extraBodies]);
  return singleTarget({ ...target, thisKey: hasClassDecorators(cls) ? undefined : cls });
}

function resolveExternalBaseConstructor(
  baseExpr: Expression,
  ctx: CalleeContext,
): TargetResolution {
  const unwrappedBase = unwrapCalleeExpression(baseExpr);
  return isIdentifier(unwrappedBase) && isBenignGlobalCallable(unwrappedBase, builtInCheckOf(ctx))
    ? EMPTY_RESOLUTION
    : UNRESOLVED_RESOLUTION;
}

function collectInstancePropertyInitializers(cls: ClassLike, into: Node[]): void {
  for (const member of cls.members) {
    if (
      isPropertyDeclaration(member) &&
      !isStaticMember(member) &&
      member.initializer !== undefined
    ) {
      into.push(member);
    }
  }
}

function findConstructorImplementation(
  members: readonly ClassElement[],
): ConstructorDeclaration | undefined {
  let fallback: ConstructorDeclaration | undefined;
  for (const member of members) {
    if (!isConstructorDeclaration(member)) continue;
    if (member.body !== undefined) return member;
    fallback = member;
  }
  return fallback;
}

export function resolveSuperMember(
  superExpr: Expression,
  method: string,
  ctx: CalleeContext,
): TargetResolution {
  const host = enclosingThisHost(superExpr);
  if (host?.kind !== 'class') return UNRESOLVED_RESOLUTION;
  const baseCls = resolveDirectBaseClass(host.cls);
  return baseCls === undefined
    ? UNRESOLVED_RESOLUTION
    : resolveClassMember(baseCls, method, host.isStatic, ctx);
}

export function resolveSuperConstructor(
  superExpr: Expression,
  ctx: CalleeContext,
): TargetResolution {
  const host = enclosingThisHost(superExpr);
  if (host?.kind !== 'class' || host.isStatic) return UNRESOLVED_RESOLUTION;
  const baseExpr = resolveDirectBaseExpression(host.cls);
  if (baseExpr === undefined) return UNRESOLVED_RESOLUTION;
  const baseCls = resolveDirectBaseClass(host.cls);
  if (baseCls !== undefined) return resolveClassConstructor(baseCls, ctx);
  const unwrappedBase = unwrapCalleeExpression(baseExpr);
  return isIdentifier(unwrappedBase) && isBenignGlobalCallable(unwrappedBase, builtInCheckOf(ctx))
    ? EMPTY_RESOLUTION
    : UNRESOLVED_RESOLUTION;
}

export function resolveClassMember(
  cls: ClassLike,
  method: string,
  isStatic: boolean,
  ctx: CalleeContext,
): TargetResolution {
  if (!isStableMember(cls.getSourceFile(), method)) return UNRESOLVED_RESOLUTION;
  const visited = new Set<ClassLike>();
  for (let current: ClassLike = cls; ;) {
    if (!consumeCalleeStep(ctx) || visited.has(current) || hasClassDecorators(current)) {
      return UNRESOLVED_RESOLUTION;
    }
    visited.add(current);
    const own = resolveOwnClassMemberOnly(current, method, isStatic, ctx);
    if (own !== undefined) return own;
    if (resolveDirectBaseExpression(current) === undefined) return UNRESOLVED_RESOLUTION;
    const next = resolveDirectBaseClass(current);
    if (next === undefined) return UNRESOLVED_RESOLUTION;
    current = next;
  }
}

function resolveOwnClassMemberOnly(
  cls: ClassLike,
  method: string,
  isStatic: boolean,
  ctx: CalleeContext,
): TargetResolution | undefined {
  if (hasClassDecorators(cls)) return UNRESOLVED_RESOLUTION;
  for (let index = cls.members.length - 1; index >= 0; index -= 1) {
    const member = cls.members[index];
    if (member === undefined || !isNamedClassMember(member)) continue;
    if (isStaticMember(member) !== isStatic) continue;
    const info = declaredMemberKey(member.name);
    if (info.dynamic) return UNRESOLVED_RESOLUTION;
    if (info.key !== method) continue;
    return resolveMatchedClassElement(member, ctx);
  }
  return undefined;
}

function resolveMatchedClassElement(
  member: NamedClassMember,
  ctx: CalleeContext,
): TargetResolution {
  if (isMethodDeclaration(member)) {
    return member.body === undefined
      ? UNRESOLVED_RESOLUTION
      : singleTarget(targetFromCallable(member, [member]));
  }
  if (isPropertyDeclaration(member) && member.initializer !== undefined) {
    return ctx.resolveExpr(member.initializer, withMode(withSeen(ctx, member), 'call'));
  }
  return UNRESOLVED_RESOLUTION;
}

export function mergeSubclassOverrides(
  rootCls: ClassLike,
  method: string,
  initial: TargetResolution,
  ctx: CalleeContext,
): TargetResolution {
  const { subclassesByBase } = fileMutationSummary(rootCls.getSourceFile());
  const rootSubs = subclassesByBase.get(rootCls);
  if (rootSubs === undefined) return initial;
  const pending: ClassLike[] = [...rootSubs];
  const visited = new Set<ClassLike>([rootCls]);
  let combined = initial;
  for (let sub = pending.pop(); sub !== undefined; sub = pending.pop()) {
    if (visited.has(sub)) continue;
    visited.add(sub);
    const directRes = resolveOwnClassMemberOnly(sub, method, false, ctx);
    if (directRes !== undefined) {
      combined = mergeResolutions(combined, directRes);
      if (combined.unresolvable) return UNRESOLVED_RESOLUTION;
    }
    const children = subclassesByBase.get(sub);
    if (children !== undefined) pending.push(...children);
  }
  return combined;
}

function isNamedClassMember(member: Node): member is NamedClassMember {
  return (
    isMethodDeclaration(member) ||
    isPropertyDeclaration(member) ||
    isGetAccessorDeclaration(member) ||
    isSetAccessorDeclaration(member)
  );
}

function isStaticMember(member: NamedClassMember): boolean {
  return member.modifiers?.some((mod) => mod.kind === SyntaxKind.StaticKeyword) === true;
}
