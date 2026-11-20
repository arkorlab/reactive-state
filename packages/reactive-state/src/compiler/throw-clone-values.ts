import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isVariableStatement,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyName,
  type SetAccessorDeclaration,
  type SpreadAssignment,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { literalKey } from './exported-values.ts';
import { metadataCallee, metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** Native objects whose identities structured cloning never serializes. */
const UNCLONEABLE: ReadonlySet<string> = new Set([
  'FinalizationRegistry',
  'Promise',
  'Proxy',
  'WeakMap',
  'WeakRef',
  'WeakSet',
]);

/** A captured primary value whose source proves an identity the cloning algorithm rejects. */
export function cloneValueThrows(
  given: readonly Expression[],
  resolve: Resolve | undefined,
): boolean {
  const [first] = given;
  if (first === undefined || !isCallExpression(first.parent)) {
    return false;
  }
  const call = first.parent;
  const follow: Resolve = (name) => {
    const held = resolve?.(name) ?? metadataInitializer(name);
    return held === undefined || calleeUncertain(held, call.expression) ? undefined : held;
  };
  const value = writtenOf(first, follow);
  return (
    !earlierExpressionEffect(call) &&
    !earlierEffect(call, value, follow) &&
    !calleeUncertain(value, call) &&
    uncloneable(value, follow)
  );
}

/** Functions, symbols and native weak, proxy or promise identities cannot become cloneable data. */
function uncloneable(node: Expression, resolve: Resolve): boolean {
  if (primaryUncloneable(node, resolve)) {
    return true;
  }
  if (!quietGraph(node, resolve)) {
    return false;
  }
  const pending: (Expression | MethodDeclaration)[] = [node];
  const seen = new Set<Node>();
  let invalid = false;
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (isMethodDeclaration(each)) {
      invalid = true;
      continue;
    }
    const value = writtenOf(each, resolve);
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    if (primaryUncloneable(value, resolve)) {
      invalid = true;
      continue;
    }
    const children = cloneChildren(value, resolve);
    if (children === undefined) {
      return false;
    }
    pending.push(...children);
  }
  return invalid;
}

/** A primary identity alone makes the clone operation fail before it returns. */
function primaryUncloneable(node: Expression, resolve: Resolve): boolean {
  if (
    isArrowFunction(node) ||
    isFunctionExpression(node) ||
    isClassExpression(node) ||
    isSymbolWritten(node, resolve)
  ) {
    return true;
  }
  const declared = metadataCallee(node);
  if (declared !== undefined && (isFunctionDeclaration(declared) || isClassDeclaration(declared))) {
    return true;
  }
  if (isCallExpression(node)) {
    const path = globalCalleePath(node.expression, resolve)?.join('.');
    return path === 'Symbol' || path === 'Symbol.for';
  }
  return (
    isNewExpression(node) &&
    UNCLONEABLE.has(globalCalleePath(node.expression, resolve)?.join('.') ?? '')
  );
}

/** Literal containers expose their selected values; unknown objects keep their runtime work. */
function cloneChildren(
  value: Expression,
  resolve: Resolve,
): readonly (Expression | MethodDeclaration)[] | undefined {
  if (isArrayLiteralExpression(value)) {
    return value.elements.filter((element) => !isOmittedExpression(element));
  }
  if (isObjectLiteralExpression(value)) {
    return ownValues(value, resolve);
  }
  return primitiveOf(value, resolve) === undefined ? undefined : [];
}

/** Surviving enumerable string-keyed values; accessors and unknown entries retain their effects. */
function ownValues(
  value: ObjectLiteralExpression,
  resolve: Resolve,
): readonly (Expression | MethodDeclaration)[] | undefined {
  const entries = stringEntries(value, resolve);
  if (entries === undefined) {
    return undefined;
  }
  const result: (Expression | MethodDeclaration)[] = [];
  const selected = new Set<string>();
  const setters = new Set<string>();
  for (const { key, property } of entries.toReversed()) {
    if (selected.has(key)) {
      continue;
    }
    if (isGetAccessorDeclaration(property)) {
      return undefined;
    }
    if (isSetAccessorDeclaration(property)) {
      setters.add(key);
      continue;
    }
    selected.add(key);
    const held = setters.has(key) ? undefined : ownDataValue(property, key);
    if (held !== undefined) {
      result.push(held);
    }
  }
  return result;
}

interface CloneEntry {
  readonly key: string;
  readonly property: Exclude<ObjectLiteralElementLike, SpreadAssignment>;
}

/** Unknown keys and spreads can introduce getters; symbol keys are never consumed. */
function stringEntries(
  value: ObjectLiteralExpression,
  resolve: Resolve,
): readonly CloneEntry[] | undefined {
  const result: CloneEntry[] = [];
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) {
      return undefined;
    }
    if (symbolKey(property.name, resolve)) {
      continue;
    }
    const key = cloneKey(property.name, resolve);
    if (key === undefined) {
      return undefined;
    }
    result.push({ key, property });
  }
  return result;
}

/** Literal data definitions keep their values; the prototype setter is not an own entry. */
function ownDataValue(
  property: CloneEntry['property'],
  key: string,
): Expression | MethodDeclaration | undefined {
  if (isMethodDeclaration(property)) {
    return property;
  }
  if (isPropertyAssignment(property)) {
    return key !== '__proto__' || isComputedPropertyName(property.name)
      ? property.initializer
      : undefined;
  }
  return isShorthandPropertyAssignment(property) && isIdentifier(property.name)
    ? property.name
    : undefined;
}

/** Only text and numeric computed keys have a known ordinary property name. */
function cloneKey(name: PropertyName, resolve: Resolve): string | undefined {
  if (isIdentifier(name)) {
    return name.text;
  }
  return literalKey(isComputedPropertyName(name) ? writtenOf(name.expression, resolve) : name);
}

/** Symbol names do not participate in structured cloning's enumerable own string keys. */
function symbolKey(name: PropertyName, resolve: Resolve): boolean {
  return (
    isComputedPropertyName(name) && isSymbolWritten(writtenOf(name.expression, resolve), resolve)
  );
}

/** Source creation must not run code that can repair another captured field before cloning. */
function quietGraph(node: Expression, resolve: Resolve): boolean {
  const pending: Node[] = [node];
  const seen = new Set<Node>();
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (seen.has(each)) {
      continue;
    }
    seen.add(each);
    const parts = creationParts(each, resolve);
    if (parts === undefined) {
      return false;
    }
    pending.push(...parts);
  }
  return true;
}

/** Only creation-time subexpressions participate; function and accessor bodies are deferred. */
function creationParts(node: Node, resolve: Resolve): readonly Node[] | undefined {
  if (isIdentifier(node)) {
    const held = resolve(node);
    return held === undefined ? [] : [held];
  }
  if (isComputedPropertyName(node)) {
    return symbolKey(node, resolve) || cloneKey(node, resolve) !== undefined
      ? [node.expression]
      : undefined;
  }
  if (isAnswering(node) || isSetAccessorDeclaration(node)) {
    return deferredName(node);
  }
  if (isPropertyAssignment(node)) {
    return isComputedPropertyName(node.name) ? [node.name, node.initializer] : [node.initializer];
  }
  if (isShorthandPropertyAssignment(node)) {
    return [node.name];
  }
  if (isCallExpression(node) || isNewExpression(node)) {
    return quietCreation(node, resolve) ? [] : undefined;
  }
  return literalCreationParts(node);
}

/** Defining a method only evaluates its computed name, never its deferred body. */
function deferredName(node: Answering | SetAccessorDeclaration): readonly Node[] {
  if (
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)
  ) {
    return isComputedPropertyName(node.name) ? [node.name] : [];
  }
  return [];
}

/** Spreads and other effectful expressions cannot prove a stable captured graph. */
function literalCreationParts(node: Node): readonly Node[] | undefined {
  if (isSpreadAssignment(node) || isSpreadElement(node)) {
    return undefined;
  }
  if (
    !isObjectLiteralExpression(node) &&
    !isArrayLiteralExpression(node) &&
    callbackCreationEffect(node)
  ) {
    return undefined;
  }
  const parts: Node[] = [];
  node.forEachChild((child) => {
    parts.push(child);
  });
  return parts;
}

/** Prior application work can replace the native cloning function or a selected constructor. */
function earlierEffect(node: Node, value: Expression, resolve: Resolve): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    if (
      isBlock(each.parent) &&
      each.parent.statements.some((statement) => {
        return (
          statement.end <= each.pos &&
          callbackCreationEffect(statement) &&
          !createsValue(statement, value, resolve)
        );
      })
    ) {
      return true;
    }
    if (isAnswering(each.parent) || isConstructorDeclaration(each.parent)) {
      break;
    }
  }
  return false;
}

/** A declaration that only creates this known identity does not call application code. */
function createsValue(node: Node, value: Expression, resolve: Resolve): boolean {
  return (
    isVariableStatement(node) &&
    node.declarationList.declarations.every((declaration) => {
      const held = declaration.initializer;
      return (
        held === undefined ||
        !callbackCreationEffect(held) ||
        (unwrapped(held) === value && quietCreation(value, resolve))
      );
    })
  );
}

/** Empty weak collections and non-calling constructors create their identity without callbacks. */
function quietCreation(value: Expression, resolve: Resolve): boolean {
  if (isCallExpression(value)) {
    const path = globalCalleePath(value.expression, resolve)?.join('.');
    return (
      (path === 'Symbol' || path === 'Symbol.for') &&
      value.arguments.every(
        (argument) =>
          !callbackCreationEffect(argument) && primitiveOf(argument, resolve) !== undefined,
      )
    );
  }
  if (!isNewExpression(value)) {
    return false;
  }
  const kind = globalCalleePath(value.expression, resolve)?.join('.') ?? '';
  const given = value.arguments ?? [];
  if (
    kind === 'Promise' ||
    !UNCLONEABLE.has(kind) ||
    given.some((argument) => callbackCreationEffect(argument))
  ) {
    return false;
  }
  if (kind === 'WeakMap' || kind === 'WeakSet') {
    const [first] = given;
    return first === undefined || (isArrayLiteralExpression(first) && first.elements.length === 0);
  }
  return true;
}
