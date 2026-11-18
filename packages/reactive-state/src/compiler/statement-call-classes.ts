import {
  type ClassDeclaration,
  type ClassExpression,
  type GetAccessorDeclaration,
  isArrowFunction,
  isBlock,
  isClassDeclaration,
  isClassExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isPropertyDeclaration,
  isReturnStatement,
  isSetAccessorDeclaration,
  type MethodDeclaration,
  type Node,
  type PropertyDeclaration,
  type SetAccessorDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import {
  type AccessMode,
  addToSet,
  ARRAY_SLICE_KIND,
  type Binding,
  type CallableNode,
  extendsExpressionOf,
  formatExcludedKeys,
  hasModifier,
  isCallableNode,
  isDeferredMember,
  isErasedOrAmbient,
  isPassiveDeferredFunction,
  nodeIdOf,
  OBJECT_REST_KIND,
  type ScopeTable,
} from './statement-call-scopes.ts';
import { staticPropertyNameKey } from './statement-call-writes.ts';

export type ResolvedValue =
  | {
      readonly base: ResolvedValue;
      readonly kind: 'super';
      readonly self: ResolvedValue;
    }
  | {
      readonly cls: ClassDeclaration | ClassExpression;
      readonly isPrototype?: boolean | undefined;
      readonly kind: 'instance';
    }
  | {
      readonly excluded: ReadonlySet<string>;
      readonly kind: typeof OBJECT_REST_KIND;
      readonly source: ResolvedValue;
    }
  | {
      readonly kind: typeof ARRAY_SLICE_KIND;
      readonly offset: number;
      readonly source: ResolvedValue;
    }
  | {
      readonly kind: 'node';
      readonly node: Node;
      /** Set by `bind`: the receiver is fixed, and a later copy of the function keeps it. */
      readonly bound?: boolean | undefined;
      readonly receiver?: ResolvedValue | undefined;
    };

export interface MemberQuery {
  readonly excluded?: ReadonlySet<string> | undefined;
  readonly key: string | undefined;
  readonly mode: AccessMode;
  readonly ownOnly: boolean;
  readonly seenBindings?: Set<Binding> | undefined;
  readonly seenNodes: ReadonlySet<Node>;
  readonly seenProjections: ReadonlySet<string>;
}

export interface ReturnQuery {
  readonly receiver?: ResolvedValue | undefined;
  readonly seenBindings?: Set<Binding> | undefined;
  readonly seenNodes: ReadonlySet<Node>;
}

export interface TargetContext {
  readonly activeReceiverFor: (owner: Node) => ResolvedValue | undefined;
  readonly ensureScope: (execRoot: Node) => void;
  readonly onActivate: (callable: CallableNode, receiver?: ResolvedValue) => void;
  readonly project: (receiver: ResolvedValue, query: MemberQuery) => readonly ResolvedValue[];
  readonly resolve: (
    expr: Node,
    seenNodes: ReadonlySet<Node>,
    seenBindings?: Set<Binding>,
  ) => readonly ResolvedValue[];
  readonly scopes: ScopeTable;
  readonly withActiveReceiver: <T>(
    owner: Node,
    receiver: ResolvedValue | undefined,
    run: () => T,
  ) => T;
}

export interface LookupReceiver {
  readonly cls: ClassDeclaration | ClassExpression;
  readonly isPrototype: boolean;
  readonly wantStatic: boolean;
}

interface KeyedMemberState {
  readonly seenGetter: boolean;
  readonly seenSetter: boolean;
  readonly selfReceiver: ResolvedValue;
  readonly targetKey: string;
}

type NamedClassMember =
  | GetAccessorDeclaration
  | MethodDeclaration
  | PropertyDeclaration
  | SetAccessorDeclaration;

export const EMPTY_NODE_SET: ReadonlySet<Node> = new Set();
export const EMPTY_PROJECT_SET: ReadonlySet<string> = new Set();

export function valueIdentityKey(value: ResolvedValue, table: ScopeTable): string {
  switch (value.kind) {
    case 'node': {
      const base = `n:${nodeIdOf(value.node, table)}`;
      return value.receiver === undefined
        ? base
        : `${base}@${valueIdentityKey(value.receiver, table)}`;
    }
    case 'instance': {
      return `${value.isPrototype === true ? 'proto' : 'inst'}:${nodeIdOf(value.cls, table)}`;
    }
    case 'super': {
      return `sup:${valueIdentityKey(value.base, table)}>${valueIdentityKey(value.self, table)}`;
    }
    case ARRAY_SLICE_KIND: {
      return `asl:${value.offset}:${valueIdentityKey(value.source, table)}`;
    }
    case OBJECT_REST_KIND: {
      return `orst:${formatExcludedKeys(value.excluded)}:${valueIdentityKey(value.source, table)}`;
    }
  }
}

/**
 * The value an object or a class holds under a key. A function that was read off another object
 * runs against the object it is now called on, so the receiver the read gave it is replaced; only
 * a function `bind` fixed keeps its own.
 */
export function attachReceiver(value: ResolvedValue, selfReceiver: ResolvedValue): ResolvedValue {
  if (
    value.kind === 'node' &&
    value.bound !== true &&
    isCallableNode(value.node) &&
    !isArrowFunction(value.node)
  ) {
    return { kind: 'node', node: value.node, receiver: selfReceiver };
  }
  return value;
}

export function evaluateAccessor(
  accessor: GetAccessorDeclaration | SetAccessorDeclaration,
  selfReceiver: ResolvedValue,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  if (isGetAccessorDeclaration(accessor)) {
    if (query.mode === 'write') {
      return [];
    }
    ctx.onActivate(accessor, selfReceiver);
    return returnedTargetsOf(accessor, ctx, {
      receiver: selfReceiver,
      seenBindings: query.seenBindings,
      seenNodes: query.seenNodes,
    }).map((item) => attachReceiver(item, selfReceiver));
  }
  if (query.mode !== 'read') {
    ctx.onActivate(accessor, selfReceiver);
  }
  return [];
}

export function returnedTargetsOf(
  callable: CallableNode,
  ctx: TargetContext,
  options: ReturnQuery,
): readonly ResolvedValue[] {
  if (options.seenNodes.has(callable)) {
    return [];
  }
  ctx.ensureScope(callable);
  const { body } = callable;
  if (body === undefined) {
    return [];
  }
  const nextSeen = addToSet(options.seenNodes, callable);
  return ctx.withActiveReceiver(callable, options.receiver, () => {
    if (!isBlock(body)) {
      return ctx.resolve(body, nextSeen, options.seenBindings);
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
    return returns.flatMap((expr) => ctx.resolve(expr, nextSeen, options.seenBindings));
  });
}

export function projectClassMembers(
  receiver: LookupReceiver,
  selfReceiver: ResolvedValue,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  if (receiver.wantStatic && query.key === 'prototype' && query.mode !== 'write') {
    return query.ownOnly ? [] : [{ cls: receiver.cls, isPrototype: true, kind: 'instance' }];
  }
  return query.key === undefined
    ? projectAllClassMembers(receiver, selfReceiver, query, ctx)
    : projectKeyedClassMembers(receiver, selfReceiver, query, ctx);
}

function memberAppliesToReceiver(
  member: Node,
  receiver: LookupReceiver,
): member is NamedClassMember {
  if (isErasedOrAmbient(member) || !isNamedClassMember(member)) {
    return false;
  }
  if (hasModifier(member, SyntaxKind.StaticKeyword) !== receiver.wantStatic) {
    return false;
  }
  return !(receiver.isPrototype && isPropertyDeclaration(member));
}

function projectAllClassMembers(
  receiver: LookupReceiver,
  selfReceiver: ResolvedValue,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  const found: ResolvedValue[] = [];
  if (receiver.wantStatic && !query.ownOnly && query.mode !== 'write') {
    found.push({ cls: receiver.cls, isPrototype: true, kind: 'instance' });
  }
  for (const member of receiver.cls.members) {
    if (!memberAppliesToReceiver(member, receiver)) {
      continue;
    }
    const declared = staticPropertyNameKey(member.name, ctx.scopes, query.seenBindings);
    if (declared === undefined || query.excluded?.has(declared) !== true) {
      found.push(...evaluateClassMember(member, selfReceiver, query, ctx));
    }
  }
  if (!query.ownOnly) {
    found.push(...projectInheritedMembers(receiver, selfReceiver, query, ctx));
  }
  return found;
}

function projectKeyedClassMembers(
  receiver: LookupReceiver,
  selfReceiver: ResolvedValue,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  const targetKey = query.key;
  if (targetKey === undefined) {
    return [];
  }
  const found: ResolvedValue[] = [];
  let definitelyDefined = false;
  let seenGetter = false;
  let seenSetter = false;

  for (let index = receiver.cls.members.length - 1; index >= 0; index -= 1) {
    const member = receiver.cls.members[index];
    if (member === undefined || !memberAppliesToReceiver(member, receiver)) {
      continue;
    }
    const step = stepKeyedClassMember(
      member,
      { seenGetter, seenSetter, selfReceiver, targetKey },
      query,
      ctx,
    );
    found.push(...step.values);
    seenGetter = step.seenGetter;
    seenSetter = step.seenSetter;
    definitelyDefined ||= step.definitelyDefined;
    if (step.stop) {
      break;
    }
  }

  // A private name belongs to the class that declares it: a subclass's `#read` does not override
  // its base's, and the access that is written in the base reaches the base's. The lookup of one
  // goes on to the bases whether or not this class declares it.
  if ((!definitelyDefined || isPrivateName(targetKey)) && !query.ownOnly) {
    found.push(...projectInheritedMembers(receiver, selfReceiver, query, ctx));
  }
  return found;
}

function isPrivateName(key: string): boolean {
  return key.startsWith('#');
}

function stepKeyedClassMember(
  member: NamedClassMember,
  state: KeyedMemberState,
  query: MemberQuery,
  ctx: TargetContext,
): {
  readonly definitelyDefined: boolean;
  readonly seenGetter: boolean;
  readonly seenSetter: boolean;
  readonly stop: boolean;
  readonly values: readonly ResolvedValue[];
} {
  const declared = staticPropertyNameKey(member.name, ctx.scopes, query.seenBindings);
  if (declared !== undefined && declared !== state.targetKey) {
    return { ...state, definitelyDefined: false, stop: false, values: [] };
  }
  if (declared === undefined) {
    const values = evaluateClassMember(member, state.selfReceiver, query, ctx);
    return { ...state, definitelyDefined: false, stop: false, values };
  }
  if (query.excluded?.has(declared) === true) {
    return { ...state, definitelyDefined: true, stop: true, values: [] };
  }
  if (isGetAccessorDeclaration(member)) {
    const values = state.seenGetter ? [] : evaluateAccessor(member, state.selfReceiver, query, ctx);
    return {
      definitelyDefined: true,
      seenGetter: true,
      seenSetter: state.seenSetter,
      stop: state.seenSetter,
      values,
    };
  }
  if (isSetAccessorDeclaration(member)) {
    const values = state.seenSetter ? [] : evaluateAccessor(member, state.selfReceiver, query, ctx);
    return {
      definitelyDefined: true,
      seenGetter: state.seenGetter,
      seenSetter: true,
      stop: state.seenGetter,
      values,
    };
  }
  if (isPropertyDeclaration(member) && member.initializer === undefined) {
    return { ...state, definitelyDefined: false, stop: false, values: [] };
  }
  const values =
    state.seenGetter || state.seenSetter
      ? []
      : evaluateClassMember(member, state.selfReceiver, query, ctx);
  return { ...state, definitelyDefined: true, stop: true, values };
}

function projectInheritedMembers(
  receiver: LookupReceiver,
  selfReceiver: ResolvedValue,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  const baseExpr = extendsExpressionOf(receiver.cls);
  if (baseExpr === undefined) {
    return [];
  }
  const found: ResolvedValue[] = [];
  const baseValues = ctx.resolve(baseExpr, query.seenNodes, query.seenBindings);
  for (const baseVal of baseValues) {
    if (
      baseVal.kind === 'node' &&
      (isClassDeclaration(baseVal.node) || isClassExpression(baseVal.node))
    ) {
      const nextBase: ResolvedValue = receiver.wantStatic
        ? baseVal
        : { cls: baseVal.node, isPrototype: receiver.isPrototype, kind: 'instance' };
      found.push(
        ...ctx.project(
          { base: nextBase, kind: 'super', self: selfReceiver },
          { ...query, excluded: undefined, ownOnly: false },
        ),
      );
    }
  }
  return found;
}

function evaluateClassMember(
  member: NamedClassMember,
  selfReceiver: ResolvedValue,
  query: MemberQuery,
  ctx: TargetContext,
): readonly ResolvedValue[] {
  if (isGetAccessorDeclaration(member) || isSetAccessorDeclaration(member)) {
    return evaluateAccessor(member, selfReceiver, query, ctx);
  }
  if (query.mode === 'write') {
    return [];
  }
  if (isMethodDeclaration(member)) {
    return [{ kind: 'node', node: member, receiver: selfReceiver }];
  }
  return member.initializer === undefined
    ? []
    : ctx
        .resolve(member.initializer, query.seenNodes, query.seenBindings)
        .map((item) => attachReceiver(item, selfReceiver));
}

function isNamedClassMember(member: Node): member is NamedClassMember {
  return (
    isPropertyDeclaration(member) ||
    isMethodDeclaration(member) ||
    isGetAccessorDeclaration(member) ||
    isSetAccessorDeclaration(member)
  );
}
