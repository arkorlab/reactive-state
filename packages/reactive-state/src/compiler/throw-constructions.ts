import {
  type ClassLikeDeclaration,
  type ConstructorDeclaration,
  type Expression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isConstructorDeclaration,
  isElementAccessExpression,
  isExpressionWithTypeArguments,
  isFunctionDeclaration,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isSpreadElement,
  isTaggedTemplateExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { calleeUncertain } from './callee-evaluation.ts';
import { runsLater } from './deferred-syntax.ts';
import { metadataParameters } from './input-bindings.ts';
import { metadataCallee } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { eagerClassOf } from './throw-classes.ts';
import { writtenOf } from './throw-shapes.ts';
import { writtenBy } from './written.ts';

/** A source class's ordered initialization prefix or proven implicit null-super failure. */
interface ConstructedClass {
  readonly initializers: readonly Expression[];
  readonly constructor: ConstructorDeclaration | undefined;
  readonly invalid?: boolean;
}

/** A constructed source class; unknown delegation, replacements and prior effects stay opaque. */
function constructedClass(node: Node, resolve: Resolve | undefined): ConstructedClass | undefined {
  if (
    !isNewExpression(node) ||
    node.arguments?.some((argument) => isSpreadElement(argument) || eagerEffect(argument)) === true
  ) {
    return undefined;
  }
  const target = writtenOf(node.expression, resolve);
  const source = metadataCallee(target);
  if (
    source === undefined ||
    (!isClassDeclaration(source) && !isClassExpression(source)) ||
    uncertainDefinition(source, implicitNullConstructor(source, resolve)) ||
    (isClassExpression(source) && calleeUncertain(source, node.expression))
  ) {
    return undefined;
  }
  return implicitNullConstructor(source, resolve)
    ? { constructor: undefined, initializers: [], invalid: true }
    : initializationOf(source);
}

/** Escaping construction work, bounded by the active invocation's syntax node on recursive entry. */
export function constructionThrows(
  node: Node,
  resolve: Resolve | undefined,
  active: Set<Node>,
  visit: (node: Node, resolve: Resolve | undefined) => Node | undefined,
): Node | undefined {
  if (active.has(node)) {
    return undefined;
  }
  const work = constructedClass(node, resolve);
  if (work === undefined) {
    return undefined;
  }
  if (work.invalid === true) {
    return node;
  }
  active.add(node);
  try {
    for (const expression of work.initializers) {
      const thrown = visit(expression, resolve);
      if (thrown !== undefined) {
        return thrown;
      }
    }
    const body = work.constructor?.body;
    return body === undefined || work.constructor === undefined
      ? undefined
      : visit(body, constructorResolve(work.constructor, resolve));
  } finally {
    active.delete(node);
  }
}

/** A constructor's formals shadow outer names in its body, including more deeply shadowed reads. */
function constructorResolve(
  constructor: ConstructorDeclaration,
  outer: Resolve | undefined,
): Resolve | undefined {
  const names = new Set(
    metadataParameters(constructor).flatMap((parameter) =>
      isIdentifier(parameter.name) ? [parameter.name.text] : [],
    ),
  );
  return names.size === 0 ? outer : (name) => (names.has(name.text) ? undefined : outer?.(name));
}

/** Base fields run before the body; the first opaque effect prevents assuming later code is stable. */
function initializationOf(source: ClassLikeDeclaration): ConstructedClass {
  const initializers: Expression[] = [];
  for (const member of source.members) {
    if (
      isPropertyDeclaration(member) &&
      member.initializer !== undefined &&
      member.modifiers?.some((modifier) => modifier.kind === SyntaxKind.StaticKeyword) !== true
    ) {
      initializers.push(member.initializer);
      if (eagerEffect(member.initializer)) {
        return { constructor: undefined, initializers };
      }
    }
  }
  const constructor = source.members.find(
    (member) => isConstructorDeclaration(member) && member.body !== undefined,
  );
  return {
    constructor:
      constructor !== undefined &&
      isConstructorDeclaration(constructor) &&
      metadataParameters(constructor).every((parameter) => {
        return (
          isIdentifier(parameter.name) &&
          (parameter.initializer === undefined || !eagerEffect(parameter.initializer))
        );
      })
        ? constructor
        : undefined,
    initializers,
  };
}

/** Unproven derived initialization, decorators and effectful definitions need a different proof. */
function uncertainDefinition(source: ClassLikeDeclaration, implicitNull: boolean): boolean {
  if (
    !implicitNull &&
    source.heritageClauses?.some((clause) => clause.token === SyntaxKind.ExtendsKeyword) === true
  ) {
    return true;
  }
  const status = { decorated: false };
  const visit = (node: Node): void => {
    status.decorated ||= node.kind === SyntaxKind.Decorator;
    if (!status.decorated) {
      node.forEachChild(visit);
    }
  };
  visit(source);
  const eager = eagerClassOf(source);
  return (
    status.decorated ||
    (eager !== undefined &&
      (eager.keys.length > 0 ||
        eager.blocks.length > 0 ||
        eager.expressions.some((each) => eagerEffect(each))))
  );
}

/** An implicit derived constructor always attempts super when its unchanged source base is null. */
function implicitNullConstructor(
  source: ClassLikeDeclaration,
  resolve: Resolve | undefined,
): boolean {
  if (source.members.some((member) => isConstructorDeclaration(member))) {
    return false;
  }
  const extendsClause = source.heritageClauses?.find(
    (clause) => clause.token === SyntaxKind.ExtendsKeyword,
  );
  const heritage = extendsClause?.types[0];
  const base =
    heritage !== undefined && isExpressionWithTypeArguments(heritage)
      ? heritage.expression
      : undefined;
  return base !== undefined && writtenOf(base, resolve).kind === SyntaxKind.NullKeyword;
}

/** Eager reads, calls, writes and key coercions; nested function bodies run only when invoked. */
function eagerEffect(node: Node): boolean {
  let effect = false;
  const visit = (each: Node): void => {
    if (isClassExpression(each)) {
      effect = true;
      return;
    }
    if (effect || runsLater(each) || isFunctionDeclaration(each)) {
      return;
    }
    effect =
      isCallExpression(each) ||
      isNewExpression(each) ||
      isPropertyAccessExpression(each) ||
      isElementAccessExpression(each) ||
      isTaggedTemplateExpression(each) ||
      isComputedPropertyName(each) ||
      isClassDeclaration(each) ||
      writtenBy(each) !== undefined;
    if (!effect) {
      each.forEachChild(visit);
    }
  };
  visit(node);
  return effect;
}
