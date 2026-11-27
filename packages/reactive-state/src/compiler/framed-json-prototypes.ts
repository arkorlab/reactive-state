import {
  type Expression,
  isGetAccessorDeclaration,
  isIdentifier,
  isObjectLiteralExpression,
  isReturnStatement,
  isSpreadAssignment,
  isStringLiteral,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { jsonConstantDeclaration } from './framed-json-keys.ts';
import { framedLiteralPrototypes } from './framed-object-members.ts';
import { framedRecordOrigin } from './framed-record-origins.ts';
import { isTypeOnly } from './scope.ts';

/** Source-written literal prototypes retain only unchanged lexical JSON hook origins. */

/**
 * A receiver's literal record, and whether its uses through the whole JSON call leave it unchanged:
 * one they may change may have lost or replaced a prototype hook before native lookup, or not.
 */
export function jsonLiteralReceiver(
  expression: Expression,
  value: Expression,
  consumer: Node,
): { readonly unchanged: boolean } | undefined {
  const origin = framedRecordOrigin(expression, consumer, true);
  if (origin === undefined) return undefined;
  return origin.record === value ? origin : undefined;
}

/**
 * One explicit literal prototype and its whole const aliases keep their original record at JSON
 * time, unless a use may change it first: its hook then stays possible beside the receiver itself.
 */
export function jsonWrittenPrototype(
  object: ObjectLiteralExpression,
  consumer: Node,
): { readonly prototype: ObjectLiteralExpression; readonly unchanged: boolean } | undefined {
  const prototypes = framedLiteralPrototypes(object);
  const prototype = prototypes[0];
  if (prototype === undefined || prototypes.length !== 1) return undefined;
  let value = unwrapped(prototype);
  const seen = new Set<Node>();
  while (isIdentifier(value)) {
    const declared = jsonConstantDeclaration(value);
    if (declared?.initializer === undefined || seen.has(declared)) return undefined;
    seen.add(declared);
    value = unwrapped(declared.initializer);
  }
  if (!isObjectLiteralExpression(value) || !quietHookGetters(value)) return undefined;
  const origin = framedRecordOrigin(prototype, consumer, true);
  return origin?.record === value ? { prototype: value, unchanged: origin.unchanged } : undefined;
}

/** An inherited method's bare this denotes the serialized receiver; other this-dependent results stay opaque. */
export function jsonIndependentResult(result: Expression): boolean {
  const pending: Node[] = [result];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (node.kind === SyntaxKind.ThisKeyword) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** Only a direct getter return adds an inherited callable without receiver-dependent or prefix work. */
function quietHookGetters(object: ObjectLiteralExpression): boolean {
  const pending = [...object.properties];
  for (let property = pending.pop(); property !== undefined; property = pending.pop()) {
    if (isSpreadAssignment(property)) {
      const source = unwrapped(property.expression);
      if (!isObjectLiteralExpression(source)) return false;
      pending.push(...source.properties);
      continue;
    }
    if (!isGetAccessorDeclaration(property)) continue;
    const name = property.name;
    if ((!isIdentifier(name) && !isStringLiteral(name)) || name.text !== 'toJSON') continue;
    const statements = property.body?.statements;
    const statement = statements?.[0];
    if (
      statement === undefined ||
      statements?.length !== 1 ||
      !isReturnStatement(statement) ||
      statement.expression === undefined ||
      !jsonIndependentResult(statement.expression)
    )
      return false;
  }
  return true;
}
