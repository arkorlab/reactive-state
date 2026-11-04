import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadElement,
  isVariableStatement,
  type Node,
  type ObjectLiteralElementLike,
  type PropertyAssignment,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { literalKey } from './exported-values.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';

/** Written invalid transfer entries, or a stable native construction listed by two const aliases. */
export function transferListThrows(
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  return transferThrows(given[1], resolve) || repeatedOrigin(given);
}

/**
 * Whether `structuredClone` throws of the options the code writes it, where it writes their transfer
 * list: of no array — a value of no object but nothing, `null` among them — or of what transfers
 * not, a value of no object, an array, an object or a function written there, or of a name twice,
 * `[buffer, buffer]`; none of what it does not write.
 */
function transferThrows(given: Expression | undefined, resolve: Resolve | undefined): boolean {
  const options = given === undefined ? undefined : writtenOf(given, resolve);
  const transfer =
    options !== undefined && isObjectLiteralExpression(options)
      ? options.properties.find((each) => isPropertyAssignment(each) && keyOf(each) === 'transfer')
      : undefined;
  if (transfer === undefined || !isPropertyAssignment(transfer)) {
    return false;
  }
  const list = writtenOf(transfer.initializer, resolve);
  if (!isArrayLiteralExpression(list)) {
    const kind = primitiveOf(list, resolve);
    return list.kind === SyntaxKind.NullKeyword || (kind !== undefined && kind !== 'nothing');
  }
  const named = new Set<string>();
  for (const element of list.elements) {
    if (isSpreadElement(element) || isOmittedExpression(element)) {
      return false;
    }
    const item = unwrapped(element);
    const value = writtenOf(element, resolve);
    if (
      primitiveOf(value, resolve) !== undefined ||
      isArrayLiteralExpression(value) ||
      isObjectLiteralExpression(value) ||
      isArrowFunction(value) ||
      isFunctionExpression(value) ||
      (isIdentifier(item) && named.has(item.text))
    ) {
      return true;
    }
    if (isIdentifier(item)) {
      named.add(item.text);
    }
  }
  return false;
}

/** The name an entry the code writes is of: of a name, of text or a number; none of another. */
function keyOf(property: PropertyAssignment): string | undefined {
  return isIdentifier(property.name) ? property.name.text : literalKey(property.name);
}

/** Only unchanged const captures are followed; application call results retain their identities. */
function heldOf(node: Expression): Expression {
  let value = unwrapped(node);
  const seen = new Set<Expression>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const held = metadataInitializer(value);
    if (held === undefined) {
      break;
    }
    value = unwrapped(held);
  }
  return value;
}

/** A duplicate proof is local to quiet argument creation and the preceding executed statements. */
function repeatedOrigin(given: readonly Expression[]): boolean {
  const call = given[0]?.parent;
  if (
    call === undefined ||
    !isCallExpression(call) ||
    earlierExpressionEffect(call) ||
    given.some((each) => !quietValue(each)) ||
    earlierEffect(call)
  ) {
    return false;
  }
  const list = capturedList(given[1]);
  if (list === undefined) {
    return false;
  }
  const seen = new Set<Expression>();
  for (const each of list.elements) {
    if (isSpreadElement(each) || isOmittedExpression(each)) {
      return false;
    }
    const origin = heldOf(each);
    if (!isNewExpression(origin)) {
      continue;
    }
    if (seen.has(origin)) {
      return true;
    }
    seen.add(origin);
  }
  return false;
}

/** The final own transfer data entry of a dictionary without spreads, accessors or unknown keys. */
function capturedList(node: Expression | undefined): ArrayLiteralExpression | undefined {
  const options = node === undefined ? undefined : heldOf(node);
  if (options === undefined || !isObjectLiteralExpression(options)) {
    return undefined;
  }
  let transfer: Expression | undefined;
  for (const each of options.properties) {
    const entry = dataEntry(each);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.key === 'transfer') {
      transfer = entry.value;
    }
  }
  const value = transfer === undefined ? undefined : heldOf(transfer);
  return value !== undefined && isArrayLiteralExpression(value) ? value : undefined;
}

/** Static own data names retain dictionary priority without invoking accessors. */
function dataEntry(
  node: ObjectLiteralElementLike,
): { readonly key: string; readonly value: Expression } | undefined {
  if (isPropertyAssignment(node)) {
    const key = keyOf(node);
    return key === undefined ? undefined : { key, value: node.initializer };
  }
  return isShorthandPropertyAssignment(node) && isIdentifier(node.name)
    ? { key: node.name.text, value: node.name }
    : undefined;
}

/** Known buffer creation is quiet only for primitive arguments; other application work is opaque. */
function quietValue(node: Node): boolean {
  const pending = [node];
  const seen = new Set<Node>();
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (seen.has(each)) {
      continue;
    }
    seen.add(each);
    const parts = creationParts(each);
    if (parts === undefined) {
      return false;
    }
    pending.push(...parts);
  }
  return true;
}

/** Captures follow their declaration; only definition-time work participates for deferred bodies. */
function creationParts(node: Node): readonly Node[] | undefined {
  if (isIdentifier(node)) {
    const held = metadataInitializer(node);
    return held === undefined ? [] : [held];
  }
  if (isNewExpression(node)) {
    return quietBuffer(node) ? [] : undefined;
  }
  if (callbackCreationEffect(node)) {
    return undefined;
  }
  if (isAnswering(node)) {
    return [];
  }
  const parts: Node[] = [];
  node.forEachChild((each) => {
    parts.push(each);
  });
  return parts;
}

/** A written native ArrayBuffer of quiet primitive arguments does not invoke application code. */
function quietBuffer(node: Expression): boolean {
  if (!isNewExpression(node)) {
    return false;
  }
  return (
    globalCalleePath(node.expression, (name) => metadataInitializer(name))?.join('.') ===
      'ArrayBuffer' &&
    (node.arguments ?? []).every((each) => {
      return (
        !callbackCreationEffect(each) &&
        primitiveOf(heldOf(each), (name) => metadataInitializer(name)) !== undefined
      );
    })
  );
}

/** Earlier repairs in an enclosing immediate body must also keep the native operation opaque. */
function earlierEffect(call: CallExpression): boolean {
  for (let each: Node = call; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      (isBlock(parent) || isSourceFile(parent)) &&
      parent.statements.some((statement) => {
        return (
          statement.end <= each.pos &&
          (isVariableStatement(statement)
            ? statement.declarationList.declarations.some(
                (declaration) =>
                  declaration.initializer !== undefined && !quietValue(declaration.initializer),
              )
            : callbackCreationEffect(statement))
        );
      })
    ) {
      return true;
    }
  }
  return false;
}
