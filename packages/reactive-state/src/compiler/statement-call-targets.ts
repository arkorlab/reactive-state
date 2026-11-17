import {
  type ArrayLiteralExpression,
  type CallExpression,
  type ClassDeclaration,
  type ClassExpression,
  type ElementAccessExpression,
  type GetAccessorDeclaration,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isConditionalExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type MethodDeclaration,
  type NewExpression,
  type Node,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type PropertyDeclaration,
  type SetAccessorDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import {
  type AccessMode,
  extendsExpressionOf,
  type Binding,
  type CallableNode,
  hasModifier,
  isCallableNode,
  isDeferredMember,
  isErasedOrAmbient,
  isPassiveDeferredFunction,
  resolveLexicalBinding,
  type ScopeTable,
  type TargetSpec,
  unwrapExpression,
} from './statement-call-scopes.ts';
import { staticExpressionKey, staticPropertyNameKey } from './statement-call-writes.ts';

export type ResolvedValue =
  | { readonly cls: ClassDeclaration | ClassExpression; readonly kind: 'instance' }
  | { readonly kind: 'node'; readonly node: Node };

export interface TargetContext {
  readonly onActivate: (callable: CallableNode) => void;
  readonly scopes: ScopeTable;
}

export interface MemberQuery {
  readonly key: string | undefined;
  readonly mode: AccessMode;
  readonly seen: Set<Node>;
}

type NamedClassMember =
  | GetAccessorDeclaration
  | MethodDeclaration
  | PropertyDeclaration
  | SetAccessorDeclaration;

const FORWARDED_BINARY_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.QuestionQuestionToken,
]);

export function resolveTargets(
  expr: Node,
  ctx: TargetContext,
  seen = new Set<Node>(),
  seenBindings?: Set<Binding>,
): readonly ResolvedValue[] {
  const clean = unwrapExpression(expr);
  if (seen.has(clean)) {
    return [];
  }
  seen.add(clean);
  if (isIdentifier(clean)) {
    const binding = resolveLexicalBinding(clean, ctx.scopes);
    if (binding === undefined) {
      return [];
    }
    seenBindings?.add(binding);
    return binding.specs.flatMap((spec) => resolveSpecTargets(spec, ctx, seen, seenBindings));
  }
  if (clean.kind === SyntaxKind.ThisKeyword) {
    return resolveThisTargets(clean);
  }
  if (isConditionalExpression(clean)) {
    return [
      ...resolveTargets(clean.whenTrue, ctx, seen, seenBindings),
      ...resolveTargets(clean.whenFalse, ctx, seen, seenBindings),
    ];
  }
  if (isBinaryExpression(clean)) {
    return resolveBinaryTargets(clean, ctx, seen, seenBindings);
  }
  return resolveStructuredTargets(clean, ctx, seen, seenBindings);
}

export function resolveSpecTargets(
  spec: TargetSpec,
  ctx: TargetContext,
  seen = new Set<Node>(),
  seenBindings?: Set<Binding>,
): readonly ResolvedValue[] {
  if (spec.kind === 'value') {
    return resolveTargets(spec.node, ctx, seen, seenBindings);
  }
  const key = spec.kind === 'member' ? spec.key : undefined;
  return resolveTargets(spec.source, ctx, seen).flatMap((src) =>
    projectMemberFromValue(src, { key, mode: 'read', seen }, ctx),
  );
}

export function projectMemberFromValue(
  receiver: ResolvedValue,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  if (receiver.kind === 'instance') {
    return projectClassMembers({ cls: receiver.cls, wantStatic: false }, query, ctx);
  }
  const { node } = receiver;
  if (isObjectLiteralExpression(node)) {
    return projectObjectMembers(node, query, ctx);
  }
  if (isArrayLiteralExpression(node)) {
    return query.mode === 'write' ? [] : projectArrayMembers(node, query, ctx);
  }
  if (isClassDeclaration(node) || isClassExpression(node)) {
    return projectClassMembers({ cls: node, wantStatic: true }, query, ctx);
  }
  return [];
}

export function staticAccessKey(
  access: ElementAccessExpression | PropertyAccessExpression,
  scopes: ScopeTable,
): string | undefined {
  return isPropertyAccessExpression(access)
    ? access.name.text
    : staticExpressionKey(access.argumentExpression, scopes);
}

function resolveStructuredTargets(
  clean: Node,
  ctx: TargetContext,
  seen: Set<Node>,
  seenBindings?: Set<Binding>,
): readonly ResolvedValue[] {
  if (isPropertyAccessExpression(clean) || isElementAccessExpression(clean)) {
    const key = staticAccessKey(clean, ctx.scopes);
    return resolveTargets(clean.expression, ctx, seen).flatMap((receiver) =>
      projectMemberFromValue(receiver, { key, mode: 'read', seen }, ctx),
    );
  }
  if (isCallExpression(clean)) {
    return resolveCallReturnTargets(clean, ctx, seen, seenBindings);
  }
  if (isNewExpression(clean)) {
    return resolveNewTargets(clean, ctx, seen);
  }
  return [{ kind: 'node', node: clean }];
}

function resolveBinaryTargets(
  node: Node & {
    readonly left: Node;
    readonly operatorToken: { readonly kind: SyntaxKind };
    readonly right: Node;
  },
  ctx: TargetContext,
  seen: Set<Node>,
  seenBindings?: Set<Binding>,
): readonly ResolvedValue[] {
  const operator = node.operatorToken.kind;
  if (operator === SyntaxKind.CommaToken || operator === SyntaxKind.EqualsToken) {
    return resolveTargets(node.right, ctx, seen, seenBindings);
  }
  return FORWARDED_BINARY_OPERATORS.has(operator)
    ? [
        ...resolveTargets(node.left, ctx, seen, seenBindings),
        ...resolveTargets(node.right, ctx, seen, seenBindings),
      ]
    : [];
}

function resolveCallReturnTargets(
  call: CallExpression,
  ctx: TargetContext,
  seen: Set<Node>,
  seenBindings?: Set<Binding>,
): readonly ResolvedValue[] {
  const results: ResolvedValue[] = [];
  const callee = unwrapExpression(call.expression);
  if (
    (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
    staticAccessKey(callee, ctx.scopes) === 'bind'
  ) {
    const boundTargets = resolveTargets(callee.expression, ctx, seen, seenBindings);
    for (const boundTarget of boundTargets) {
      if (boundTarget.kind === 'node' && isCallableNode(boundTarget.node)) {
        results.push(boundTarget);
      }
    }
  }
  const calleeValues = resolveTargets(call.expression, ctx, seen);
  for (const calleeVal of calleeValues) {
    if (calleeVal.kind === 'node' && isCallableNode(calleeVal.node)) {
      results.push(...returnedTargetsOf(calleeVal.node, ctx, seen));
    }
  }
  return results;
}

function resolveNewTargets(
  node: NewExpression,
  ctx: TargetContext,
  seen: Set<Node>,
): readonly ResolvedValue[] {
  const instances: ResolvedValue[] = [];
  const candidates = resolveTargets(node.expression, ctx, seen);
  for (const target of candidates) {
    if (
      target.kind === 'node' &&
      (isClassDeclaration(target.node) || isClassExpression(target.node))
    ) {
      instances.push({ cls: target.node, kind: 'instance' });
    }
  }
  return instances;
}

function resolveThisTargets(thisNode: Node): readonly ResolvedValue[] {
  let current: Node = thisNode.parent;
  for (;;) {
    if (isArrowFunction(current)) {
      current = current.parent;
      continue;
    }
    if (isClassStaticBlockDeclaration(current)) {
      const owner = current.parent;
      return isClassDeclaration(owner) || isClassExpression(owner)
        ? [{ kind: 'node', node: owner }]
        : [];
    }
    if (isDeferredMember(current) || isPropertyDeclaration(current)) {
      return ownerTargetOfMember(current);
    }
    if (
      isFunctionDeclaration(current) ||
      isFunctionExpression(current) ||
      current.kind === SyntaxKind.SourceFile
    ) {
      return [];
    }
    current = current.parent;
  }
}

function ownerTargetOfMember(member: Node): readonly ResolvedValue[] {
  const owner = member.parent;
  if (isObjectLiteralExpression(owner)) {
    return [{ kind: 'node', node: owner }];
  }
  if (isClassDeclaration(owner) || isClassExpression(owner)) {
    return hasModifier(member, SyntaxKind.StaticKeyword)
      ? [{ kind: 'node', node: owner }]
      : [{ cls: owner, kind: 'instance' }];
  }
  return [];
}

function projectObjectMembers(
  object: ObjectLiteralExpression,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  const found: ResolvedValue[] = [];
  for (const property of object.properties) {
    if (isSpreadAssignment(property)) {
      const spreadValues = resolveTargets(property.expression, ctx, new Set(query.seen));
      for (const spreadVal of spreadValues) {
        found.push(
          ...projectMemberFromValue(spreadVal, { ...query, seen: new Set(query.seen) }, ctx),
        );
      }
      continue;
    }
    if (matchesKey(query.key, staticPropertyNameKey(property.name, ctx.scopes))) {
      found.push(...evaluateObjectMember(property, query, ctx));
    }
  }
  return found;
}

function evaluateObjectMember(
  property: Node,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  if (isGetAccessorDeclaration(property) || isSetAccessorDeclaration(property)) {
    return evaluateAccessor(property, query, ctx);
  }
  if (query.mode === 'write') {
    return [];
  }
  if (isMethodDeclaration(property)) {
    return [{ kind: 'node', node: property }];
  }
  if (isPropertyAssignment(property)) {
    return resolveTargets(property.initializer, ctx, new Set(query.seen));
  }
  return isShorthandPropertyAssignment(property)
    ? resolveTargets(property.name, ctx, new Set(query.seen))
    : [];
}

function projectArraySpread(
  spreadExpr: Node,
  seen: ReadonlySet<Node>,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  const found: ResolvedValue[] = [];
  const innerTargets = resolveTargets(spreadExpr, ctx, new Set(seen));
  for (const inner of innerTargets) {
    found.push(
      ...projectMemberFromValue(inner, { key: undefined, mode: 'read', seen: new Set(seen) }, ctx),
    );
  }
  return found;
}

function arraySlotMatches(
  targetIndex: number | undefined,
  fixedIndex: number,
  spreadSeen: boolean,
): boolean {
  if (targetIndex === undefined) {
    return true;
  }
  return spreadSeen ? fixedIndex <= targetIndex : fixedIndex === targetIndex;
}

function projectArrayMembers(
  array: ArrayLiteralExpression,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  const targetIndex =
    query.key !== undefined && /^\d+$/u.test(query.key) ? Number(query.key) : undefined;
  const found: ResolvedValue[] = [];
  let fixedIndex = 0;
  let spreadSeen = false;
  for (const element of array.elements) {
    if (isSpreadElement(element)) {
      spreadSeen = true;
      if (targetIndex === undefined || fixedIndex <= targetIndex) {
        found.push(...projectArraySpread(element.expression, query.seen, ctx));
      }
      continue;
    }
    if (arraySlotMatches(targetIndex, fixedIndex, spreadSeen) && !isOmittedExpression(element)) {
      found.push(...resolveTargets(element, ctx, new Set(query.seen)));
    }
    fixedIndex += 1;
  }
  return found;
}

function projectClassMembers(
  receiver: { readonly cls: ClassDeclaration | ClassExpression; readonly wantStatic: boolean },
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  const found: ResolvedValue[] = [];
  for (const member of receiver.cls.members) {
    if (
      !isErasedOrAmbient(member) &&
      isNamedClassMember(member) &&
      hasModifier(member, SyntaxKind.StaticKeyword) === receiver.wantStatic &&
      matchesKey(query.key, staticPropertyNameKey(member.name, ctx.scopes))
    ) {
      found.push(...evaluateClassMember(member, query, ctx));
    }
  }
  found.push(...projectInheritedMembers(receiver, query, ctx));
  return found;
}

function projectInheritedMembers(
  receiver: { readonly cls: ClassDeclaration | ClassExpression; readonly wantStatic: boolean },
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  const baseExpr = extendsExpressionOf(receiver.cls);
  if (baseExpr === undefined) {
    return [];
  }
  const found: ResolvedValue[] = [];
  const baseValues = resolveTargets(baseExpr, ctx, new Set(query.seen));
  for (const baseVal of baseValues) {
    if (
      baseVal.kind === 'node' &&
      (isClassDeclaration(baseVal.node) || isClassExpression(baseVal.node))
    ) {
      const nextReceiver: ResolvedValue = receiver.wantStatic
        ? baseVal
        : { cls: baseVal.node, kind: 'instance' };
      found.push(
        ...projectMemberFromValue(nextReceiver, { ...query, seen: new Set(query.seen) }, ctx),
      );
    }
  }
  return found;
}

function evaluateClassMember(
  member: NamedClassMember,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  if (isGetAccessorDeclaration(member) || isSetAccessorDeclaration(member)) {
    return evaluateAccessor(member, query, ctx);
  }
  if (query.mode === 'write') {
    return [];
  }
  if (isMethodDeclaration(member)) {
    return [{ kind: 'node', node: member }];
  }
  return member.initializer === undefined
    ? []
    : resolveTargets(member.initializer, ctx, new Set(query.seen));
}

function evaluateAccessor(
  accessor: GetAccessorDeclaration | SetAccessorDeclaration,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  if (isGetAccessorDeclaration(accessor)) {
    if (query.mode === 'write') {
      return [];
    }
    ctx.onActivate(accessor);
    return returnedTargetsOf(accessor, ctx, query.seen);
  }
  if (query.mode !== 'read') {
    ctx.onActivate(accessor);
  }
  return [];
}

function returnedTargetsOf(
  callable: CallableNode,
  ctx: TargetContext,
  seen: Set<Node>,
): readonly ResolvedValue[] {
  const { body } = callable;
  if (body === undefined) {
    return [];
  }
  if (!isBlock(body)) {
    return resolveTargets(body, ctx, new Set(seen));
  }
  const returns: Node[] = [];
  const collectReturns = (node: Node): void => {
    if (node !== body && (isPassiveDeferredFunction(node) || isDeferredMember(node))) {
      return;
    }
    if (isReturnStatement(node) && node.expression !== undefined) {
      returns.push(node.expression);
      return;
    }
    node.forEachChild(collectReturns);
  };
  collectReturns(body);
  return returns.flatMap((expr) => resolveTargets(expr, ctx, new Set(seen)));
}

function isNamedClassMember(member: Node): member is NamedClassMember {
  return (
    isPropertyDeclaration(member) ||
    isMethodDeclaration(member) ||
    isGetAccessorDeclaration(member) ||
    isSetAccessorDeclaration(member)
  );
}

function matchesKey(queried: string | undefined, declared: string | undefined): boolean {
  return queried === undefined || declared === undefined || declared === queried;
}
