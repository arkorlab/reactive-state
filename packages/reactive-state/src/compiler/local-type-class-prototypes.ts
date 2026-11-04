import {
  factory,
  type ExpressionWithTypeArguments,
  isIdentifier,
  isQualifiedName,
  isTypeQueryNode,
  SyntaxKind,
  type TypeQueryNode,
} from 'typescript/ast';

import { heritageReference } from './local-type-class-bases.ts';
import type { TypeReading } from './local-type-environment.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** A local constructor's prototype query keeps its written class heritage and lexical value scope. */

const ERRORS = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException']);
const PROTOTYPES = new WeakMap<TypeQueryNode, ExpressionWithTypeArguments>();

/** Class parameters are erased on the constructor's prototype rather than instantiated at defaults. */
export function localClassPrototypeReading(at: TypeReading): TypeReading | undefined {
  const query = at.type;
  if (!isTypeQueryNode(query)) return undefined;
  const member = query.exprName;
  if (!isQualifiedName(member) || !isIdentifier(member.left) || member.right.text !== 'prototype')
    return undefined;
  const constructor = heritageReference(member.left);
  if (
    constructor.binding === null ||
    (constructor.binding === undefined && !ERRORS.has(constructor.builtin ?? ''))
  )
    return undefined;
  let type = PROTOTYPES.get(query);
  if (type === undefined) {
    const parameters = constructor.binding?.typeParameters ?? [];
    type = factory.createExpressionWithTypeArguments(
      member.left,
      parameters.map(() => factory.createKeywordTypeNode(SyntaxKind.AnyKeyword)),
    );
    PROTOTYPES.set(query, type);
  }
  return { ...at, type };
}
