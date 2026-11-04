import {
  type Block,
  type ClassLikeDeclaration,
  type ComputedPropertyName,
  type Expression,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isComputedPropertyName,
  isExpressionWithTypeArguments,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import type { Resolve } from './numbers.ts';
import { constructorTargetThrows } from './throw-callability.ts';
import { writtenOf } from './throw-shapes.ts';

/** The expressions, computed names and static blocks evaluated when a class is defined. */
export interface EagerClass {
  readonly expressions: readonly Expression[];
  readonly keys: readonly ComputedPropertyName[];
  readonly blocks: readonly Block[];
}

/** Class definition requires a constructable base or the explicitly permitted null prototype. */
export function heritageThrows(node: Node, resolve: Resolve | undefined): boolean {
  if (!isClassDeclaration(node) && !isClassExpression(node)) {
    return false;
  }
  const bases: Expression[] = [];
  heritageValues(node, bases);
  return bases.some((base) => {
    const value = writtenOf(base, resolve);
    return value.kind !== SyntaxKind.NullKeyword && constructorTargetThrows(value, resolve);
  });
}

/** Eager class expressions and key conversions; static blocks need statement-flow checking. */
export function eagerClassExpressions(node: Node): readonly Node[] | undefined {
  const eager = eagerClassOf(node);
  if (eager === undefined) {
    return undefined;
  }
  return [eager.keys, eager.expressions].flat();
}

/** Eager class work, excluding constructors, methods and instance field initializers. */
export function eagerClassOf(node: Node): EagerClass | undefined {
  if (!isClassDeclaration(node) && !isClassExpression(node)) {
    return undefined;
  }
  const expressions: Expression[] = [];
  const keys: ComputedPropertyName[] = [];
  const blocks: Block[] = [];
  heritageValues(node, expressions);
  for (const member of node.members) {
    const key = computedName(member);
    if (key !== undefined) {
      keys.push(key);
    }
    if (isClassStaticBlockDeclaration(member)) {
      blocks.push(member.body);
    } else if (
      isPropertyDeclaration(member) &&
      member.initializer !== undefined &&
      member.modifiers?.some((modifier) => modifier.kind === SyntaxKind.StaticKeyword) === true
    ) {
      expressions.push(member.initializer);
    }
  }
  return { expressions, keys, blocks };
}

/** Runtime heritage expressions, excluding TypeScript's implements-only types. */
function heritageValues(node: ClassLikeDeclaration, expressions: Expression[]): void {
  const clauses = node.heritageClauses;
  if (clauses === undefined) {
    return;
  }
  for (const clause of clauses) {
    if (clause.token === SyntaxKind.ExtendsKeyword) {
      for (const type of clause.types) {
        if (isExpressionWithTypeArguments(type)) {
          expressions.push(type.expression);
        }
      }
    }
  }
}

/** The computed name of a field, method or accessor, each evaluated at class definition. */
function computedName(node: Node): ComputedPropertyName | undefined {
  if (
    isPropertyDeclaration(node) ||
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)
  ) {
    return isComputedPropertyName(node.name) ? node.name : undefined;
  }
  return undefined;
}
