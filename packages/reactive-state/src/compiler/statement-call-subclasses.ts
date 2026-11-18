import {
  type ClassDeclaration,
  type ClassExpression,
  isClassDeclaration,
  isClassExpression,
  isObjectLiteralExpression,
  isPropertyDeclaration,
  type Node,
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
} from './statement-call-scopes.ts';

type ClassNode = ClassDeclaration | ClassExpression;

const CLASSES_WITHIN = new WeakMap<Node, readonly ClassNode[]>();

/** The scope tables whose subclasses are being searched: a heritage that reads `this` stops there. */
const SEARCHING = new WeakSet<TargetContext['scopes']>();

/** Every class declaration and class expression written anywhere within `root`. */
function classesWithin(root: Node): readonly ClassNode[] {
  const known = CLASSES_WITHIN.get(root);
  if (known !== undefined) {
    return known;
  }
  const found: ClassNode[] = [];
  const visit = (node: Node): void => {
    if ((isClassDeclaration(node) || isClassExpression(node)) && !isErasedOrAmbient(node)) {
      found.push(node);
    }
    node.forEachChild(visit);
  };
  visit(root);
  CLASSES_WITHIN.set(root, found);
  return found;
}

/** For each class, the classes written within the statement that name it directly as their base. */
function directSubclasses(
  ctx: TargetContext,
  seenBindings: Set<Binding> | undefined,
): ReadonlyMap<ClassNode, readonly ClassNode[]> {
  const subclassesOf = new Map<ClassNode, ClassNode[]>();
  for (const cls of classesWithin(ctx.scopes.root)) {
    const baseExpr = extendsExpressionOf(cls);
    if (baseExpr === undefined) {
      continue;
    }
    for (const base of ctx.resolve(baseExpr, EMPTY_NODE_SET, seenBindings)) {
      if (base.kind === 'node' && (isClassDeclaration(base.node) || isClassExpression(base.node))) {
        subclassesOf.set(base.node, [...(subclassesOf.get(base.node) ?? []), cls]);
      }
    }
  }
  return subclassesOf;
}

/**
 * The classes written within the statement that extend `owner`, through any number of steps. A
 * `this` the analysis cannot place (an arrow function that outlived the call that made it, a method
 * kept in a variable, a receiver returned inside an object) is read as `owner` and as each of these,
 * as an override in any of them may be the one that runs.
 */
function classesExtending(
  owner: ClassNode,
  ctx: TargetContext,
  seenBindings: Set<Binding> | undefined,
): readonly ClassNode[] {
  if (SEARCHING.has(ctx.scopes)) {
    return [];
  }
  SEARCHING.add(ctx.scopes);
  try {
    const subclassesOf = directSubclasses(ctx, seenBindings);
    const found = new Set<ClassNode>();
    const pending: ClassNode[] = [owner];
    for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
      const direct = subclassesOf.get(current);
      if (direct === undefined) {
        continue;
      }
      for (const subclass of direct) {
        if (subclass !== owner && !found.has(subclass)) {
          found.add(subclass);
          pending.push(subclass);
        }
      }
    }
    return [...found];
  } finally {
    SEARCHING.delete(ctx.scopes);
  }
}

/**
 * What `this` is in `member` when no call of it is being followed: the object literal it is in, or
 * its class and every class extending it, as the call may have been made on an instance of any.
 * A static field's initializer runs once, on the class that declares it.
 */
export function ownerTargetsOfMember(
  member: Node,
  ctx: TargetContext,
  seenBindings?: Set<Binding>,
): readonly ResolvedValue[] {
  const owner = member.parent;
  if (isObjectLiteralExpression(owner)) {
    return [{ kind: 'node', node: owner }];
  }
  if (!isClassDeclaration(owner) && !isClassExpression(owner)) {
    return [];
  }
  const isStatic = hasModifier(member, SyntaxKind.StaticKeyword);
  const receiverOf = (cls: ClassNode): ResolvedValue =>
    isStatic ? { kind: 'node', node: cls } : { cls, kind: 'instance' };
  if (isStatic && isPropertyDeclaration(member)) {
    return [receiverOf(owner)];
  }
  return [owner, ...classesExtending(owner, ctx, seenBindings)].map((cls) => receiverOf(cls));
}
