import {
  type ClassDeclaration,
  type ClassExpression,
  isClassDeclaration,
  isClassExpression,
  isObjectLiteralExpression,
  isPropertyDeclaration,
  isSpreadAssignment,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import {
  EMPTY_NODE_SET,
  type ResolvedValue,
  type TargetContext,
} from './statement-call-classes.ts';
import {
  type Binding,
  extendsExpressionOf,
  hasModifier,
  isErasedOrAmbient,
  isProtoSetterProperty,
  OBJECT_REST_KIND,
} from './statement-call-scopes.ts';

type ClassNode = ClassDeclaration | ClassExpression;

/** A class, or an object literal, that may take its methods from another. */
type Heir = ClassNode | ObjectLiteralExpression;

const HEIRS_WITHIN = new WeakMap<Node, readonly Heir[]>();

/** The scope tables whose heirs are being searched: a base that reads `this` stops there. */
const SEARCHING = new WeakSet<TargetContext['scopes']>();

/** Every class and every object literal written anywhere within `root`. */
function heirsWithin(root: Node): readonly Heir[] {
  const known = HEIRS_WITHIN.get(root);
  if (known !== undefined) {
    return known;
  }
  const found: Heir[] = [];
  const visit = (node: Node): void => {
    if (
      isObjectLiteralExpression(node) ||
      ((isClassDeclaration(node) || isClassExpression(node)) && !isErasedOrAmbient(node))
    ) {
      found.push(node);
    }
    node.forEachChild(visit);
  };
  visit(root);
  HEIRS_WITHIN.set(root, found);
  return found;
}

/** The object literals among `values`, through the copies an object rest makes of them. */
function literalsAmong(values: readonly ResolvedValue[]): readonly ObjectLiteralExpression[] {
  const found: ObjectLiteralExpression[] = [];
  for (const value of values) {
    let source = value;
    while (source.kind === OBJECT_REST_KIND) {
      source = source.source;
    }
    if (source.kind === 'node' && isObjectLiteralExpression(source.node)) {
      found.push(source.node);
    }
  }
  return found;
}

/** The classes among `values`. */
function classesAmong(values: readonly ResolvedValue[]): readonly ClassNode[] {
  const found: ClassNode[] = [];
  for (const value of values) {
    if (
      value.kind === 'node' &&
      (isClassDeclaration(value.node) || isClassExpression(value.node))
    ) {
      found.push(value.node);
    }
  }
  return found;
}

/**
 * What `heir` takes methods from directly: the class it extends, or the object literals it spreads
 * or names as its `__proto__`.
 */
function basesOf(
  heir: Heir,
  ctx: TargetContext,
  seenBindings: Set<Binding> | undefined,
): readonly Node[] {
  const resolveAll = (expr: Node): readonly ResolvedValue[] =>
    ctx.resolve(expr, EMPTY_NODE_SET, seenBindings);
  if (!isObjectLiteralExpression(heir)) {
    const baseExpr = extendsExpressionOf(heir);
    return baseExpr === undefined ? [] : classesAmong(resolveAll(baseExpr));
  }
  return heir.properties.flatMap((property) => {
    if (isSpreadAssignment(property)) {
      return literalsAmong(resolveAll(property.expression));
    }
    return isProtoSetterProperty(property) ? literalsAmong(resolveAll(property.initializer)) : [];
  });
}

/** For each class or object literal, the ones written within the statement that take from it directly. */
function directHeirs(
  ctx: TargetContext,
  seenBindings: Set<Binding> | undefined,
): ReadonlyMap<Node, readonly Heir[]> {
  const directOf = new Map<Node, Heir[]>();
  for (const heir of heirsWithin(ctx.scopes.root)) {
    for (const base of basesOf(heir, ctx, seenBindings)) {
      directOf.set(base, [...(directOf.get(base) ?? []), heir]);
    }
  }
  return directOf;
}

/**
 * The classes and object literals written within the statement that take methods from `owner`,
 * through any number of steps. A `this` the analysis cannot place (an arrow function that outlived
 * the call that made it, a method kept in a variable, a receiver returned inside an object) is read
 * as `owner` and as each of these, as an override in any of them may be the one that runs.
 */
function heirsOf(
  owner: Heir,
  ctx: TargetContext,
  seenBindings: Set<Binding> | undefined,
): readonly Heir[] {
  if (SEARCHING.has(ctx.scopes)) {
    return [];
  }
  SEARCHING.add(ctx.scopes);
  try {
    const direct = directHeirs(ctx, seenBindings);
    const found = new Set<Heir>();
    const pending: Node[] = [owner];
    for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
      const heirs = direct.get(current);
      if (heirs === undefined) {
        continue;
      }
      for (const heir of heirs) {
        if (heir !== owner && !found.has(heir)) {
          found.add(heir);
          pending.push(heir);
        }
      }
    }
    return [...found];
  } finally {
    SEARCHING.delete(ctx.scopes);
  }
}

/** What `this` is in a function written as a property of `owner`: `owner` and every copy of it. */
export function objectTargetsOf(
  owner: ObjectLiteralExpression,
  ctx: TargetContext,
  seenBindings?: Set<Binding>,
): readonly ResolvedValue[] {
  return [owner, ...heirsOf(owner, ctx, seenBindings)].map((node) => ({ kind: 'node', node }));
}

/**
 * What `this` is in `member` when no call of it is being followed: the object literal it is in and
 * every object literal copied from it, or its class and every class extending it, as the call may
 * have been made on any of them. A static field's initializer runs once, on the class that
 * declares it.
 */
export function ownerTargetsOfMember(
  member: Node,
  ctx: TargetContext,
  seenBindings?: Set<Binding>,
): readonly ResolvedValue[] {
  const owner = member.parent;
  if (isObjectLiteralExpression(owner)) {
    return objectTargetsOf(owner, ctx, seenBindings);
  }
  if (!isClassDeclaration(owner) && !isClassExpression(owner)) {
    return [];
  }
  const isStatic = hasModifier(member, SyntaxKind.StaticKeyword);
  if (isStatic && isPropertyDeclaration(member)) {
    return [{ kind: 'node', node: owner }];
  }
  return [owner, ...heirsOf(owner, ctx, seenBindings)].flatMap((heir): readonly ResolvedValue[] => {
    if (!isClassDeclaration(heir) && !isClassExpression(heir)) {
      return [];
    }
    return [isStatic ? { kind: 'node', node: heir } : { cls: heir, kind: 'instance' }];
  });
}
