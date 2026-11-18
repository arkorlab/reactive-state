import {
  type ArrayLiteralExpression,
  isArrayLiteralExpression,
  isClassDeclaration,
  isClassExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyAssignment,
  type SyntaxKind,
} from 'typescript/ast';

import {
  attachReceiver,
  evaluateAccessor,
  type MemberQuery,
  projectClassMembers,
  type ResolvedValue,
  type TargetContext,
  valueIdentityKey,
} from './statement-call-classes.ts';
import {
  addToSet,
  ARRAY_SLICE_KIND,
  formatExcludedKeys,
  isArrayIndexKey,
  isProtoSetterProperty,
  OBJECT_REST_KIND,
  type ScopeTable,
} from './statement-call-scopes.ts';
import { staticPropertyNameKey } from './statement-call-writes.ts';

interface KeyedObjectScanState {
  readonly seenGetter: boolean;
  readonly seenSetter: boolean;
  readonly selfReceiver: ResolvedValue;
  readonly targetKey: string;
}

interface KeyedObjectStep {
  readonly matchedStatic: boolean;
  readonly seenGetter: boolean;
  readonly seenSetter: boolean;
  readonly stop: boolean;
  readonly values: readonly ResolvedValue[];
}

function projectionCacheKey(
  receiver: ResolvedValue,
  query: MemberQuery,
  table: ScopeTable,
): string {
  const excludedPart =
    query.excluded === undefined || query.excluded.size === 0
      ? ''
      : `-${formatExcludedKeys(query.excluded)}`;
  return `${valueIdentityKey(receiver, table)}|${query.mode}|${query.key ?? '*'}|${query.ownOnly ? '1' : '0'}${excludedPart}`;
}

export function projectMemberFromValue(
  receiver: ResolvedValue,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  const cacheKey = projectionCacheKey(receiver, query, ctx.scopes);
  if (query.seenProjections.has(cacheKey)) {
    return [];
  }
  const nextQuery: MemberQuery = {
    ...query,
    seenProjections: addToSet(query.seenProjections, cacheKey),
  };
  return receiver.kind === 'super'
    ? projectMemberWithSelf(receiver.base, receiver.self, nextQuery, ctx)
    : projectMemberWithSelf(receiver, receiver, nextQuery, ctx);
}

function projectMemberWithSelf(
  rawTarget: ResolvedValue,
  selfReceiver: ResolvedValue,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  let target = rawTarget;
  while (target.kind === 'super') {
    target = target.base;
  }
  if (target.kind === OBJECT_REST_KIND) {
    return projectObjectRestMembers(target, selfReceiver, query, ctx);
  }
  if (target.kind === ARRAY_SLICE_KIND) {
    return query.mode === 'write'
      ? []
      : asElementsOf(projectArraySliceMembers(target, query, ctx), selfReceiver);
  }
  if (target.kind === 'instance') {
    return projectClassMembers(
      { cls: target.cls, isPrototype: target.isPrototype === true, wantStatic: false },
      selfReceiver,
      query,
      ctx,
    );
  }
  const { node } = target;
  if (isObjectLiteralExpression(node)) {
    return query.key === undefined
      ? projectAllObjectMembers(node, selfReceiver, query, ctx)
      : projectKeyedObjectMembers(node, selfReceiver, query, ctx);
  }
  if (isArrayLiteralExpression(node)) {
    return query.mode === 'write'
      ? []
      : asElementsOf(projectArrayMembers(node, 0, query, ctx), selfReceiver);
  }
  if (isClassDeclaration(node) || isClassExpression(node)) {
    return projectClassMembers(
      { cls: node, isPrototype: false, wantStatic: true },
      selfReceiver,
      query,
      ctx,
    );
  }
  return [];
}

/** A function an array holds runs against that array (`steps[0]()` reads `this[1]`), as an object's does. */
function asElementsOf(
  elements: readonly ResolvedValue[],
  array: ResolvedValue,
): readonly ResolvedValue[] {
  return elements.map((element) => attachReceiver(element, array));
}

function projectObjectRestMembers(
  rest: { readonly excluded: ReadonlySet<string>; readonly source: ResolvedValue },
  selfReceiver: ResolvedValue,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  if (query.mode === 'write') {
    return [];
  }
  if (query.key !== undefined && rest.excluded.has(query.key)) {
    return [];
  }
  const mergedExcluded =
    query.excluded === undefined ? rest.excluded : new Set([...query.excluded, ...rest.excluded]);
  return projectMemberWithSelf(
    rest.source,
    selfReceiver,
    { ...query, excluded: mergedExcluded, ownOnly: true },
    ctx,
  );
}

function projectArraySliceMembers(
  slice: { readonly offset: number; readonly source: ResolvedValue },
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  if (query.key !== undefined) {
    if (!isArrayIndexKey(query.key)) {
      return [];
    }
    const shifted = String(Number(query.key) + slice.offset);
    return projectMemberFromValue(slice.source, { ...query, key: shifted }, ctx);
  }
  if (slice.source.kind === 'node' && isArrayLiteralExpression(slice.source.node)) {
    return projectArrayMembers(slice.source.node, slice.offset, query, ctx);
  }
  return projectMemberFromValue(slice.source, query, ctx);
}

function projectAllObjectMembers(
  object: ObjectLiteralExpression,
  selfReceiver: ResolvedValue,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  const found: ResolvedValue[] = [];
  for (const property of object.properties) {
    if (isProtoSetterProperty(property)) {
      if (!query.ownOnly) {
        found.push(...projectProtoAssignment(property, selfReceiver, query, ctx));
      }
      continue;
    }
    if (isSpreadAssignment(property)) {
      found.push(
        ...projectObjectSpreadWithShadow(property.expression, selfReceiver, query, ctx).values,
      );
      continue;
    }
    const declared = staticPropertyNameKey(property.name, ctx.scopes, query.seenBindings);
    if (declared === undefined || query.excluded?.has(declared) !== true) {
      found.push(...evaluateObjectProperty(property, selfReceiver, query, ctx));
    }
  }
  return found;
}

function projectKeyedObjectMembers(
  object: ObjectLiteralExpression,
  selfReceiver: ResolvedValue,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  const targetKey = query.key;
  if (targetKey === undefined) {
    return [];
  }
  const found: ResolvedValue[] = [];
  const protoProperties: PropertyAssignment[] = [];
  let definitelyDefined = false;
  let seenGetter = false;
  let seenSetter = false;

  for (let index = object.properties.length - 1; index >= 0; index -= 1) {
    const property = object.properties[index];
    if (property === undefined) {
      continue;
    }
    if (isProtoSetterProperty(property)) {
      protoProperties.push(property);
      continue;
    }
    const step = stepKeyedObjectElement(
      property,
      { seenGetter, seenSetter, selfReceiver, targetKey },
      query,
      ctx,
    );
    found.push(...step.values);
    seenGetter = step.seenGetter;
    seenSetter = step.seenSetter;
    definitelyDefined ||= step.matchedStatic;
    if (step.stop) {
      break;
    }
  }

  if (!definitelyDefined && !query.ownOnly) {
    found.push(...projectProtoList(protoProperties, selfReceiver, query, ctx));
  }
  return found;
}

function stepKeyedObjectElement(
  property: ObjectLiteralElementLike,
  state: KeyedObjectScanState,
  query: MemberQuery,
  ctx: TargetContext,
): KeyedObjectStep {
  if (isSpreadAssignment(property)) {
    const spreadOut = projectObjectSpreadWithShadow(
      property.expression,
      state.selfReceiver,
      query,
      ctx,
    );
    return {
      matchedStatic: spreadOut.definitelyDefines,
      seenGetter: state.seenGetter,
      seenSetter: state.seenSetter,
      stop: spreadOut.definitelyDefines,
      values: spreadOut.values,
    };
  }
  return stepKeyedObjectProperty(property, state, query, ctx);
}

function stepKeyedObjectProperty(
  property: Exclude<ObjectLiteralElementLike, { readonly kind: SyntaxKind.SpreadAssignment }>,
  state: KeyedObjectScanState,
  query: MemberQuery,
  ctx: TargetContext,
): KeyedObjectStep {
  const declared = staticPropertyNameKey(property.name, ctx.scopes, query.seenBindings);
  if (declared !== undefined && declared !== state.targetKey) {
    return { ...state, matchedStatic: false, stop: false, values: [] };
  }
  if (declared === undefined) {
    const values = evaluateObjectProperty(property, state.selfReceiver, query, ctx);
    return { ...state, matchedStatic: false, stop: false, values };
  }
  if (query.excluded?.has(declared) === true) {
    return { ...state, matchedStatic: true, stop: true, values: [] };
  }
  if (isGetAccessorDeclaration(property)) {
    const values = state.seenGetter
      ? []
      : evaluateAccessor(property, state.selfReceiver, query, ctx);
    return {
      matchedStatic: true,
      seenGetter: true,
      seenSetter: state.seenSetter,
      stop: state.seenSetter,
      values,
    };
  }
  if (isSetAccessorDeclaration(property)) {
    const values = state.seenSetter
      ? []
      : evaluateAccessor(property, state.selfReceiver, query, ctx);
    return {
      matchedStatic: true,
      seenGetter: state.seenGetter,
      seenSetter: true,
      stop: state.seenGetter,
      values,
    };
  }
  const values =
    state.seenGetter || state.seenSetter
      ? []
      : evaluateObjectProperty(property, state.selfReceiver, query, ctx);
  return { ...state, matchedStatic: true, stop: true, values };
}

function projectProtoList(
  protoProperties: readonly PropertyAssignment[],
  selfReceiver: ResolvedValue,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  const found: ResolvedValue[] = [];
  for (const protoProp of protoProperties) {
    if (query.key === '__proto__' && query.mode !== 'write') {
      found.push(...ctx.resolve(protoProp.initializer, query.seenNodes, query.seenBindings));
    } else {
      found.push(...projectProtoAssignment(protoProp, selfReceiver, query, ctx));
    }
  }
  return found;
}

function projectProtoAssignment(
  protoProp: PropertyAssignment,
  selfReceiver: ResolvedValue,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  const found: ResolvedValue[] = [];
  const protoValues = ctx.resolve(protoProp.initializer, query.seenNodes, query.seenBindings);
  for (const protoVal of protoValues) {
    found.push(
      ...projectMemberFromValue(
        { base: protoVal, kind: 'super', self: selfReceiver },
        { ...query, excluded: undefined, ownOnly: false },
        ctx,
      ),
    );
  }
  return found;
}

function projectObjectSpreadWithShadow(
  spreadExpr: Node,
  selfReceiver: ResolvedValue,
  query: MemberQuery,
  ctx: TargetContext,
): { readonly definitelyDefines: boolean; readonly values: readonly ResolvedValue[] } {
  const values: ResolvedValue[] = [];
  const spreadTargets = ctx.resolve(spreadExpr, query.seenNodes, query.seenBindings);
  for (const target of spreadTargets) {
    const projected = projectMemberFromValue(target, { ...query, ownOnly: true }, ctx);
    for (const item of projected) {
      values.push(attachReceiver(item, selfReceiver));
    }
  }
  const definitelyDefines =
    query.key !== undefined &&
    spreadTargets.length > 0 &&
    spreadTargets.every((target) =>
      valueDefinitelyDefinesOwnKey(target, query.key ?? '', ctx, query.seenNodes),
    );
  return { definitelyDefines, values };
}

function valueDefinitelyDefinesOwnKey(
  target: ResolvedValue,
  key: string,
  ctx: TargetContext,
  seenNodes: ReadonlySet<Node>,
): boolean {
  if (target.kind === OBJECT_REST_KIND) {
    return (
      !target.excluded.has(key) && valueDefinitelyDefinesOwnKey(target.source, key, ctx, seenNodes)
    );
  }
  if (
    target.kind !== 'node' ||
    !isObjectLiteralExpression(target.node) ||
    seenNodes.has(target.node)
  ) {
    return false;
  }
  const nextSeen = addToSet(seenNodes, target.node);
  for (let index = target.node.properties.length - 1; index >= 0; index -= 1) {
    const property = target.node.properties[index];
    if (property === undefined || isProtoSetterProperty(property)) {
      continue;
    }
    if (isSpreadAssignment(property)) {
      const inner = ctx.resolve(property.expression, nextSeen);
      if (
        inner.length > 0 &&
        inner.every((item) => valueDefinitelyDefinesOwnKey(item, key, ctx, nextSeen))
      ) {
        return true;
      }
      continue;
    }
    if (staticPropertyNameKey(property.name, ctx.scopes) === key) {
      return true;
    }
  }
  return false;
}

function evaluateObjectProperty(
  property: ObjectLiteralElementLike,
  selfReceiver: ResolvedValue,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  if (isGetAccessorDeclaration(property) || isSetAccessorDeclaration(property)) {
    return evaluateAccessor(property, selfReceiver, query, ctx);
  }
  if (query.mode === 'write') {
    return [];
  }
  if (isMethodDeclaration(property)) {
    return [{ kind: 'node', node: property, receiver: selfReceiver }];
  }
  if (isPropertyAssignment(property)) {
    return ctx
      .resolve(property.initializer, query.seenNodes, query.seenBindings)
      .map((item) => attachReceiver(item, selfReceiver));
  }
  return isShorthandPropertyAssignment(property)
    ? ctx
        .resolve(property.name, query.seenNodes, query.seenBindings)
        .map((item) => attachReceiver(item, selfReceiver))
    : [];
}

function projectArrayMembers(
  array: ArrayLiteralExpression,
  minOffset: number,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  if (query.key !== undefined && !isArrayIndexKey(query.key)) {
    return [];
  }
  const targetIndex = query.key === undefined ? undefined : Number(query.key);
  const found: ResolvedValue[] = [];
  let fixedIndex = 0;
  let spreadSeen = false;
  for (const element of array.elements) {
    if (isSpreadElement(element)) {
      spreadSeen = true;
      if (targetIndex === undefined || fixedIndex <= targetIndex) {
        found.push(...projectArraySpread(element.expression, query, ctx));
      }
      continue;
    }
    if (
      arraySlotMatches(targetIndex, minOffset, fixedIndex, spreadSeen) &&
      !isOmittedExpression(element)
    ) {
      found.push(...ctx.resolve(element, query.seenNodes, query.seenBindings));
    }
    fixedIndex += 1;
  }
  return found;
}

function projectArraySpread(
  spreadExpr: Node,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  const found: ResolvedValue[] = [];
  const innerTargets = ctx.resolve(spreadExpr, query.seenNodes, query.seenBindings);
  for (const inner of innerTargets) {
    found.push(
      ...projectMemberFromValue(
        inner,
        { ...query, excluded: undefined, key: undefined, mode: 'read', ownOnly: false },
        ctx,
      ),
    );
  }
  return found;
}

function arraySlotMatches(
  targetIndex: number | undefined,
  minOffset: number,
  fixedIndex: number,
  spreadSeen: boolean,
): boolean {
  if (targetIndex === undefined) {
    return spreadSeen || fixedIndex >= minOffset;
  }
  return spreadSeen ? fixedIndex <= targetIndex : fixedIndex === targetIndex;
}
