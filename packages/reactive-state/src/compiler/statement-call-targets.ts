import {
  type CallExpression,
  type ClassDeclaration,
  type ClassExpression,
  type ElementAccessExpression,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isConditionalExpression,
  isConstructorDeclaration,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSpreadElement,
  type NewExpression,
  type Node,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  SyntaxKind,
} from 'typescript/ast';

import {
  EMPTY_NODE_SET,
  EMPTY_PROJECT_SET,
  type ResolvedValue,
  returnedTargetsOf,
  type TargetContext,
} from './statement-call-classes.ts';
import { projectMemberFromValue } from './statement-call-members.ts';
import {
  addToSet,
  ARRAY_SLICE_KIND,
  type Binding,
  extendsExpressionOf,
  hasModifier,
  isCallableNode,
  isDeferredMember,
  isProtoSetterProperty,
  OBJECT_REST_KIND,
  resolveLexicalBinding,
  type ScopeTable,
  unwrapExpression,
  type ValueSpec,
} from './statement-call-scopes.ts';
import { staticExpressionKey } from './statement-call-writes.ts';

export { EMPTY_NODE_SET, EMPTY_PROJECT_SET } from './statement-call-classes.ts';

interface ResolutionTrace {
  readonly seenBindings?: Set<Binding> | undefined;
  readonly seenNodes: ReadonlySet<Node>;
  readonly seenSpecs: ReadonlySet<ValueSpec>;
}

const EMPTY_SPEC_SET: ReadonlySet<ValueSpec> = new Set();

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
  seenNodes: ReadonlySet<Node> = EMPTY_NODE_SET,
  seenBindings?: Set<Binding>,
): readonly ResolvedValue[] {
  return resolveTargetsWithTrace(expr, ctx, {
    seenBindings,
    seenNodes,
    seenSpecs: EMPTY_SPEC_SET,
  });
}

function resolveTargetsWithTrace(
  expr: Node,
  ctx: TargetContext,
  trace: ResolutionTrace,
): readonly ResolvedValue[] {
  const clean = unwrapExpression(expr);
  if (trace.seenNodes.has(clean)) {
    return [];
  }
  const nextTrace: ResolutionTrace = {
    ...trace,
    seenNodes: addToSet(trace.seenNodes, clean),
  };
  if (isIdentifier(clean)) {
    const binding = resolveLexicalBinding(clean, ctx.scopes);
    if (binding === undefined) {
      return [];
    }
    nextTrace.seenBindings?.add(binding);
    return binding.specs.flatMap((spec) =>
      resolveSpecTargets(spec, ctx, { ...nextTrace, seenSpecs: EMPTY_SPEC_SET }),
    );
  }
  if (clean.kind === SyntaxKind.ThisKeyword) {
    return resolveThisTargets(clean, ctx);
  }
  if (clean.kind === SyntaxKind.SuperKeyword) {
    return resolveSuperTargets(clean, ctx, nextTrace);
  }
  if (isConditionalExpression(clean)) {
    return [
      ...resolveTargetsWithTrace(clean.whenTrue, ctx, nextTrace),
      ...resolveTargetsWithTrace(clean.whenFalse, ctx, nextTrace),
    ];
  }
  if (isBinaryExpression(clean)) {
    return resolveBinaryTargets(clean, ctx, nextTrace);
  }
  return resolveStructuredTargets(clean, ctx, nextTrace);
}

function resolveSpecTargets(
  spec: ValueSpec,
  ctx: TargetContext,
  trace: ResolutionTrace,
): readonly ResolvedValue[] {
  if (trace.seenSpecs.has(spec)) {
    return [];
  }
  const nextTrace: ResolutionTrace = {
    ...trace,
    seenSpecs: addToSet(trace.seenSpecs, spec),
  };
  switch (spec.kind) {
    case 'unknown': {
      return [];
    }
    case 'value': {
      return resolveTargetsWithTrace(spec.node, ctx, nextTrace);
    }
    case 'union': {
      return [
        ...resolveSpecTargets(spec.left, ctx, nextTrace),
        ...resolveSpecTargets(spec.right, ctx, nextTrace),
      ];
    }
    case 'array-rest': {
      return resolveSpecTargets(spec.source, ctx, nextTrace).map((src) => {
        return src.kind === ARRAY_SLICE_KIND
          ? { kind: ARRAY_SLICE_KIND, offset: src.offset + spec.offset, source: src.source }
          : { kind: ARRAY_SLICE_KIND, offset: spec.offset, source: src };
      });
    }
    case OBJECT_REST_KIND: {
      return resolveSpecTargets(spec.source, ctx, nextTrace).map((src) => {
        return src.kind === OBJECT_REST_KIND
          ? {
              excluded: new Set([...src.excluded, ...spec.excluded]),
              kind: OBJECT_REST_KIND,
              source: src.source,
            }
          : { excluded: spec.excluded, kind: OBJECT_REST_KIND, source: src };
      });
    }
    case 'elements':
    case 'member': {
      const key = spec.kind === 'member' ? spec.key : undefined;
      return resolveSpecTargets(spec.source, ctx, nextTrace).flatMap((src) => {
        return projectMemberFromValue(
          src,
          {
            key,
            mode: 'read',
            ownOnly: false,
            seenBindings: nextTrace.seenBindings,
            seenNodes: nextTrace.seenNodes,
            seenProjections: EMPTY_PROJECT_SET,
          },
          ctx,
        );
      });
    }
  }
}

export function staticAccessKey(
  access: ElementAccessExpression | PropertyAccessExpression,
  scopes: ScopeTable,
  seenBindings?: Set<Binding>,
): string | undefined {
  return isPropertyAccessExpression(access)
    ? access.name.text
    : staticExpressionKey(access.argumentExpression, scopes, seenBindings);
}

function resolveStructuredTargets(
  clean: Node,
  ctx: TargetContext,
  trace: ResolutionTrace,
): readonly ResolvedValue[] {
  if (isPropertyAccessExpression(clean) || isElementAccessExpression(clean)) {
    const key = staticAccessKey(clean, ctx.scopes, trace.seenBindings);
    return resolveTargetsWithTrace(clean.expression, ctx, trace).flatMap((receiver) => {
      return projectMemberFromValue(
        receiver,
        {
          key,
          mode: 'read',
          ownOnly: false,
          seenBindings: trace.seenBindings,
          seenNodes: trace.seenNodes,
          seenProjections: EMPTY_PROJECT_SET,
        },
        ctx,
      );
    });
  }
  if (isCallExpression(clean)) {
    return resolveCallReturnTargets(clean, ctx, trace);
  }
  if (isNewExpression(clean)) {
    return resolveNewTargets(clean, ctx, trace);
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
  trace: ResolutionTrace,
): readonly ResolvedValue[] {
  const operator = node.operatorToken.kind;
  if (operator === SyntaxKind.CommaToken || operator === SyntaxKind.EqualsToken) {
    return resolveTargetsWithTrace(node.right, ctx, trace);
  }
  return FORWARDED_BINARY_OPERATORS.has(operator)
    ? [
        ...resolveTargetsWithTrace(node.left, ctx, trace),
        ...resolveTargetsWithTrace(node.right, ctx, trace),
      ]
    : [];
}

function resolveCallReturnTargets(
  call: CallExpression,
  ctx: TargetContext,
  trace: ResolutionTrace,
): readonly ResolvedValue[] {
  const callee = unwrapExpression(call.expression);
  if (callee.kind === SyntaxKind.SuperKeyword) {
    return resolveThisTargets(callee, ctx);
  }
  const results: ResolvedValue[] = [];
  if (
    (isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) &&
    staticAccessKey(callee, ctx.scopes, trace.seenBindings) === 'bind'
  ) {
    results.push(...resolveBindCallTargets(call, callee.expression, ctx, trace));
  }
  const calleeValues = resolveTargetsWithTrace(call.expression, ctx, trace);
  for (const calleeVal of calleeValues) {
    if (calleeVal.kind === 'node' && isCallableNode(calleeVal.node)) {
      results.push(
        ...returnedTargetsOf(calleeVal.node, ctx, {
          receiver: calleeVal.receiver,
          seenBindings: trace.seenBindings,
          seenNodes: trace.seenNodes,
        }),
      );
    }
  }
  return results;
}

function resolveBindCallTargets(
  call: CallExpression,
  targetExpr: Node,
  ctx: TargetContext,
  trace: ResolutionTrace,
): readonly ResolvedValue[] {
  const boundTargets = resolveTargetsWithTrace(targetExpr, ctx, trace);
  const firstArg = call.arguments[0];
  const thisTargets =
    firstArg === undefined || isSpreadElement(firstArg)
      ? []
      : resolveTargetsWithTrace(firstArg, ctx, trace);
  const results: ResolvedValue[] = [];
  for (const boundTarget of boundTargets) {
    if (boundTarget.kind !== 'node' || !isCallableNode(boundTarget.node)) {
      continue;
    }
    if (
      isArrowFunction(boundTarget.node) ||
      boundTarget.receiver !== undefined ||
      thisTargets.length === 0
    ) {
      results.push(boundTarget);
      continue;
    }
    for (const receiver of thisTargets) {
      results.push({ kind: 'node', node: boundTarget.node, receiver });
    }
  }
  return results;
}

function resolveNewTargets(
  node: NewExpression,
  ctx: TargetContext,
  trace: ResolutionTrace,
): readonly ResolvedValue[] {
  return resolveTargetsWithTrace(node.expression, ctx, trace).flatMap((target) => {
    return target.kind === 'node' &&
      (isClassDeclaration(target.node) || isClassExpression(target.node))
      ? [{ cls: target.node, kind: 'instance' as const }]
      : [];
  });
}

export function resolveThisTargets(thisNode: Node, ctx: TargetContext): readonly ResolvedValue[] {
  let current: Node = thisNode.parent;
  for (;;) {
    if (isArrowFunction(current)) {
      current = current.parent;
      continue;
    }
    const resolved = thisTargetsAtBoundary(current, ctx);
    if (resolved !== undefined) {
      return resolved;
    }
    current = current.parent;
  }
}

function thisTargetsAtBoundary(
  current: Node,
  ctx: TargetContext,
): readonly ResolvedValue[] | undefined {
  if (isClassStaticBlockDeclaration(current)) {
    const owner = current.parent;
    return isClassDeclaration(owner) || isClassExpression(owner)
      ? [{ kind: 'node', node: owner }]
      : [];
  }
  if (isDeferredMember(current) || isPropertyDeclaration(current)) {
    const active = ctx.activeReceiverFor(current);
    return active === undefined ? ownerTargetOfMember(current) : [active];
  }
  if (isFunctionDeclaration(current) || isFunctionExpression(current)) {
    return functionThisFallback(current, ctx);
  }
  return current.kind === SyntaxKind.SourceFile ? [] : undefined;
}

function functionThisFallback(fn: Node, ctx: TargetContext): readonly ResolvedValue[] {
  const active = ctx.activeReceiverFor(fn);
  if (active !== undefined) {
    return [active];
  }
  if (
    isFunctionExpression(fn) &&
    isPropertyAssignment(fn.parent) &&
    isObjectLiteralExpression(fn.parent.parent)
  ) {
    return [{ kind: 'node', node: fn.parent.parent }];
  }
  return [];
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

function enclosingSuperMember(superNode: Node): Node | undefined {
  let current: Node = superNode.parent;
  for (;;) {
    if (isArrowFunction(current)) {
      current = current.parent;
      continue;
    }
    if (
      isClassStaticBlockDeclaration(current) ||
      isDeferredMember(current) ||
      isPropertyDeclaration(current)
    ) {
      return current;
    }
    if (
      isFunctionDeclaration(current) ||
      isFunctionExpression(current) ||
      current.kind === SyntaxKind.SourceFile
    ) {
      return undefined;
    }
    current = current.parent;
  }
}

function resolveSuperTargets(
  superNode: Node,
  ctx: TargetContext,
  trace: ResolutionTrace,
): readonly ResolvedValue[] {
  const member = enclosingSuperMember(superNode);
  if (member === undefined) {
    return [];
  }
  const owner = member.parent;
  const selfTargets = resolveThisTargets(superNode, ctx);
  if (isObjectLiteralExpression(owner)) {
    return resolveObjectSuperTargets(owner, selfTargets, ctx, trace);
  }
  if (!isClassDeclaration(owner) && !isClassExpression(owner)) {
    return [];
  }
  const wantStatic =
    isClassStaticBlockDeclaration(member) || hasModifier(member, SyntaxKind.StaticKeyword);
  return resolveClassSuperTargets({ owner, selfTargets, wantStatic }, ctx, trace);
}

function resolveObjectSuperTargets(
  owner: ObjectLiteralExpression,
  selfTargets: readonly ResolvedValue[],
  ctx: TargetContext,
  trace: ResolutionTrace,
): readonly ResolvedValue[] {
  const results: ResolvedValue[] = [];
  for (const prop of owner.properties) {
    if (!isProtoSetterProperty(prop)) {
      continue;
    }
    for (const protoVal of resolveTargetsWithTrace(prop.initializer, ctx, trace)) {
      for (const self of selfTargets) {
        results.push({ base: protoVal, kind: 'super', self });
      }
    }
  }
  return results;
}

function resolveClassSuperTargets(
  spec: {
    readonly owner: ClassDeclaration | ClassExpression;
    readonly selfTargets: readonly ResolvedValue[];
    readonly wantStatic: boolean;
  },
  ctx: TargetContext,
  trace: ResolutionTrace,
): readonly ResolvedValue[] {
  const baseExpr = extendsExpressionOf(spec.owner);
  if (baseExpr === undefined) {
    return [];
  }
  const results: ResolvedValue[] = [];
  for (const baseVal of resolveTargetsWithTrace(baseExpr, ctx, trace)) {
    if (
      baseVal.kind === 'node' &&
      (isClassDeclaration(baseVal.node) || isClassExpression(baseVal.node))
    ) {
      const baseTarget: ResolvedValue = spec.wantStatic
        ? baseVal
        : { cls: baseVal.node, isPrototype: true, kind: 'instance' };
      for (const self of spec.selfTargets) {
        results.push({ base: baseTarget, kind: 'super', self });
      }
    }
  }
  return results;
}

export function superConstructorTargets(
  superNode: Node,
  ctx: TargetContext,
  seenBindings?: Set<Binding>,
): { readonly bases: readonly ResolvedValue[]; readonly selves: readonly ResolvedValue[] } {
  const member = enclosingSuperMember(superNode);
  if (member === undefined || !isConstructorDeclaration(member)) {
    return { bases: [], selves: [] };
  }
  const owner = member.parent;
  if (!isClassDeclaration(owner) && !isClassExpression(owner)) {
    return { bases: [], selves: [] };
  }
  const baseExpr = extendsExpressionOf(owner);
  if (baseExpr === undefined) {
    return { bases: [], selves: [] };
  }
  return {
    bases: resolveTargets(baseExpr, ctx, EMPTY_NODE_SET, seenBindings),
    selves: resolveThisTargets(superNode, ctx),
  };
}
