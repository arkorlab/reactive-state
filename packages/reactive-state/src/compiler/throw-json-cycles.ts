import {
  type Block,
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadElement,
  isVariableStatement,
  type Node,
  type ObjectLiteralExpression,
  type Statement,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { globalOf, unwrapped } from './bounded.ts';
import { callbackCreationEffect } from './callback-evaluation.ts';
import { literalKey } from './exported-values.ts';
import { declarationOf } from './framed.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { primitiveOf } from './throw-shapes.ts';

/** Plain local data whose sequentially established references JSON will visit. */
interface Container {
  readonly array: boolean;
  readonly entries: Map<string, Value>;
}

type Value = Container | null;
type Bindings = Map<Node, Value | undefined>;

const ARRAY_INDEX_LIMIT = 4_294_967_295;
const HOOK_KEYS: ReadonlySet<string> = new Set(['__proto__', 'toJSON']);

/** A source-established cycle of plain local objects or array elements before serialization. */
export function jsonCycleThrows(node: Node, resolve: Resolve | undefined): boolean {
  if (
    !isCallExpression(node) ||
    globalCalleePath(node.expression, resolve)?.join('.') !== 'JSON.stringify' ||
    node.arguments.some((argument) => isSpreadElement(argument))
  ) {
    return false;
  }
  const block = blockOf(node);
  const bindings: Bindings = new Map();
  if (block === undefined || !readBefore(block, node, bindings)) {
    return false;
  }
  const [root, ...later] = node.arguments;
  if (root === undefined || later.some((argument) => readValue(argument, bindings) !== null)) {
    return false;
  }
  const value = readValue(root, bindings);
  return value !== undefined && value !== null && containsCycle(value);
}

/** A sequential block without crossing another function's deferred execution. */
function blockOf(node: Node): Block | undefined {
  for (let each = node.parent; !isSourceFile(each); each = each.parent) {
    if (isBlock(each)) {
      return each;
    }
    if (isAnswering(each)) {
      return undefined;
    }
  }
  return undefined;
}

/** Statements before the call establish data; unknown control flow or application work stops proof. */
function readBefore(block: Block, call: CallExpression, bindings: Bindings): boolean {
  for (const statement of block.statements) {
    if (statement.pos <= call.pos && statement.end >= call.end) {
      const expression =
        isExpressionStatement(statement) || isReturnStatement(statement)
          ? statement.expression
          : undefined;
      return expression !== undefined && expressionBefore(expression, call, bindings);
    }
    if (statement.pos >= call.pos) {
      return false;
    }
    if (!readStatement(statement, bindings)) {
      return false;
    }
  }
  return false;
}

/** Only declarations and direct writes contribute to this local data snapshot. */
function readStatement(node: Statement, bindings: Bindings): boolean {
  if (isFunctionDeclaration(node)) {
    return true;
  }
  if (isVariableStatement(node)) {
    return node.declarationList.declarations.every((declaration) =>
      readBinding(declaration, bindings),
    );
  }
  return isExpressionStatement(node) && applyExpression(node.expression, bindings);
}

/** Unknown quiet values may be declared, but cannot later establish a serialization edge. */
function readBinding(node: VariableDeclaration, bindings: Bindings): boolean {
  if (!isIdentifier(node.name)) {
    return false;
  }
  const held = node.initializer;
  const value = held === undefined ? null : readValue(held, bindings);
  if (held !== undefined && value === undefined && callbackCreationEffect(held)) {
    return false;
  }
  bindings.set(node, value);
  return true;
}

/** Earlier comma operands finish before serialization; other enclosing operations stay opaque. */
function expressionBefore(node: Expression, call: CallExpression, bindings: Bindings): boolean {
  let value = unwrapped(node);
  while (value !== call) {
    if (!isBinaryExpression(value) || value.operatorToken.kind !== SyntaxKind.CommaToken) {
      return false;
    }
    if (call.end <= value.left.end) {
      value = unwrapped(value.left);
    } else {
      if (!applyExpression(value.left, bindings)) {
        return false;
      }
      value = unwrapped(value.right);
    }
  }
  return true;
}

/** A direct own-data assignment or deletion changes the snapshot in statement order. */
function applyExpression(node: Expression, bindings: Bindings): boolean {
  const value = unwrapped(node);
  if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.CommaToken) {
    return applyExpression(value.left, bindings) && applyExpression(value.right, bindings);
  }
  if (isDeleteExpression(value)) {
    const target = memberOf(value.expression, bindings);
    return target?.of.entries.delete(target.key) ?? false;
  }
  if (!isBinaryExpression(value) || value.operatorToken.kind !== SyntaxKind.EqualsToken) {
    return !callbackCreationEffect(value);
  }
  const held = readValue(value.right, bindings);
  const target = memberOf(value.left, bindings);
  if (held === undefined || target === undefined || target.key === 'length') {
    return false;
  }
  if (!target.of.array || arrayKey(target.key)) {
    target.of.entries.set(target.key, held);
  }
  return true;
}

/** A literal own member of a tracked container, excluding prototype and serialization hooks. */
function memberOf(
  node: Expression,
  bindings: Bindings,
): { readonly of: Container; readonly key: string } | undefined {
  const value = unwrapped(node);
  if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) {
    return undefined;
  }
  const key = isPropertyAccessExpression(value)
    ? value.name.text
    : literalKey(unwrapped(value.argumentExpression));
  const of = readValue(value.expression, bindings);
  return key === undefined || of === null || of === undefined || HOOK_KEYS.has(key)
    ? undefined
    : { key, of };
}

/** Primitive values and literal own data alone cannot run a repair hook before a later cycle. */
function readValue(node: Expression, bindings: Bindings): Value | undefined {
  const value = unwrapped(node);
  if (isIdentifier(value)) {
    const declared = declarationOf(value);
    if (declared === undefined) {
      return globalOf(value) === 'undefined' ? null : undefined;
    }
    return bindings.get(declared);
  }
  if (isObjectLiteralExpression(value)) {
    return objectOf(value, bindings);
  }
  if (isArrayLiteralExpression(value)) {
    return arrayOf(value, bindings);
  }
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const member = memberOf(value, bindings);
    return member?.of.entries.get(member.key);
  }
  return callbackCreationEffect(value) || primitiveOf(value, undefined) === undefined
    ? undefined
    : null;
}

/** Array elements retain their identities; holes serialize as primitive null values. */
function arrayOf(
  node: Expression & { readonly elements: readonly Expression[] },
  bindings: Bindings,
): Container | undefined {
  const entries = new Map<string, Value>();
  for (const [index, element] of node.elements.entries()) {
    const held = isOmittedExpression(element) ? null : readValue(element, bindings);
    if (held === undefined || isSpreadElement(element)) {
      return undefined;
    }
    entries.set(String(index), held);
  }
  return { array: true, entries };
}

/** A literal with only static data properties has no getter, spread or custom toJSON effect. */
function objectOf(node: ObjectLiteralExpression, bindings: Bindings): Container | undefined {
  const entries = new Map<string, Value>();
  for (const property of node.properties) {
    if (!isPropertyAssignment(property) && !isShorthandPropertyAssignment(property)) {
      return undefined;
    }
    const key = isIdentifier(property.name) ? property.name.text : literalKey(property.name);
    if (key === undefined || HOOK_KEYS.has(key)) {
      return undefined;
    }
    let held: Value | undefined;
    if (isPropertyAssignment(property)) {
      held = readValue(property.initializer, bindings);
    } else if (isIdentifier(property.name)) {
      held = readValue(property.name, bindings);
    }
    if (held === undefined) {
      return undefined;
    }
    entries.set(key, held);
  }
  return { array: false, entries };
}

/** Array serialization follows indices alone, leaving named properties out. */
function arrayKey(key: string): boolean {
  const number = Number(key);
  return (
    Number.isSafeInteger(number) &&
    number >= 0 &&
    number < ARRAY_INDEX_LIMIT &&
    String(number) === key
  );
}

/** A repeated reference is harmless unless its object is still on the current serialization path. */
function containsCycle(root: Container): boolean {
  const active = new Set<Container>();
  const complete = new Set<Container>();
  const pending: { readonly value: Container; readonly leaving?: boolean }[] = [{ value: root }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { value } = next;
    if (next.leaving === true) {
      active.delete(value);
      complete.add(value);
    } else if (active.has(value)) {
      return true;
    } else if (!complete.has(value)) {
      active.add(value);
      pending.push({ value, leaving: true });
      for (const held of value.entries.values()) {
        if (held !== null) {
          pending.push({ value: held });
        }
      }
    }
  }
  return false;
}
