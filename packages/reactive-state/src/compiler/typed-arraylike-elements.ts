import {
  type Expression,
  isBlock,
  isCallExpression,
  isComputedPropertyName,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSourceFile,
  isVariableStatement,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { literalKey } from './exported-values.ts';
import { metadataInitializer } from './input-callees.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { typedSymbolElement } from './throw-typed-symbols.ts';

/** A quiet own array-like prefix whose elements the native typed conversion necessarily reads. */
export function typedArrayLikeElements(
  source: Expression,
  outer: Resolve | undefined,
): readonly Expression[] | undefined {
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  const value = writtenOf(source, resolve);
  const call = source.parent;
  if (!isObjectLiteralExpression(value) || (!isCallExpression(call) && !isNewExpression(call))) {
    return undefined;
  }
  const fields = ownFields(value, resolve);
  const length = fields === undefined ? undefined : knownLength(fields.get('length'), resolve);
  if (
    fields === undefined ||
    length === undefined ||
    calleeUncertain(value, source) ||
    earlierExpressionEffect(call) ||
    priorEffect(call, value, resolve) ||
    (call.arguments ?? []).some(
      (argument) => argument !== source && callbackCreationEffect(argument),
    )
  ) {
    return undefined;
  }
  return convertedPrefix(fields, length, resolve);
}

/** Ordinary data definitions exclude iterator, length and element getters and unknown key effects. */
function ownFields(
  value: ObjectLiteralExpression,
  resolve: Resolve,
): ReadonlyMap<string, Expression> | undefined {
  const fields = new Map<string, Expression>();
  for (const property of value.properties) {
    if (!isPropertyAssignment(property) || isComputedPropertyName(property.name)) {
      return undefined;
    }
    const key = isIdentifier(property.name) ? property.name.text : literalKey(property.name);
    if (key === undefined || key === '__proto__' || !quietField(property.initializer, resolve)) {
      return undefined;
    }
    fields.set(key, property.initializer);
  }
  return fields;
}

/** Primitive Symbol creation is quiet only under the existing native freshness proof. */
function quietField(value: Expression, resolve: Resolve): boolean {
  return !callbackCreationEffect(value) || typedSymbolElement(value, resolve);
}

/** Literal numeric/text lengths use ToLength without executing a source conversion. */
function knownLength(value: Expression | undefined, resolve: Resolve): number | undefined {
  const size = value === undefined ? undefined : constantValue(value, resolve);
  if (size === undefined) {
    return undefined;
  }
  const whole = Math.trunc(Number(size)) || 0;
  return Math.min(Math.max(whole, 0), Number.MAX_SAFE_INTEGER);
}

/** Only contiguous quiet own entries before the first invalid Symbol need native conversion. */
function convertedPrefix(
  fields: ReadonlyMap<string, Expression>,
  length: number,
  resolve: Resolve,
): readonly Expression[] | undefined {
  const entries = [...fields].flatMap(([key, value]) => {
    const index = Number(key);
    return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
      ? [{ index, value }]
      : [];
  });
  const result: Expression[] = [];
  let next = 0;
  const ordered = entries.toSorted((left, right) => left.index - right.index);
  for (const { index, value } of ordered) {
    const symbol = typedSymbolElement(value, resolve);
    if (
      index !== next ||
      (!symbol && primitiveOf(writtenOf(value, resolve), resolve) === undefined)
    ) {
      return undefined;
    }
    result.push(value);
    if (symbol) {
      return result;
    }
    next += 1;
  }
  return result;
}

/** Prior application evaluation can repair a captured input or replace a native constructor. */
function priorEffect(node: Node, value: Expression, resolve: Resolve): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    if (
      isBlock(each.parent) &&
      each.parent.statements.some(
        (statement) => statement.end <= each.pos && statementEffect(statement, value, resolve),
      )
    ) {
      return true;
    }
  }
  return false;
}

/** The already-validated source declaration creates data without invoking application code. */
function statementEffect(node: Node, value: Expression, resolve: Resolve): boolean {
  if (!isVariableStatement(node)) {
    return callbackCreationEffect(node);
  }
  return node.declarationList.declarations.some((declaration) => {
    const held = declaration.initializer;
    return held !== undefined && writtenOf(held, resolve) !== value && callbackCreationEffect(held);
  });
}
