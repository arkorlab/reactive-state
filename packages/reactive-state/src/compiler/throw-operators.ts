import {
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isClassExpression,
  isNewExpression,
  isComputedPropertyName,
  isDeleteExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isSpreadAssignment,
  isSourceFile,
  type Block,
  type Expression,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { callbackCreationEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { runsLater } from './deferred-syntax.ts';
import { literalKey } from './exported-values.ts';
import { metadataCallee } from './input-callees.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { emptyNullFactory } from './throw-callability.ts';
import { globalCalleePath } from './throw-callees.ts';
import { lacksFunctionPrototype, nativeEvaluationChanged } from './throw-native-next.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';
import { includesApplication, interveningEvaluation } from './written-evaluation.ts';

/** The native target and symbol whose earlier writes can supply an ordinary instance hook. */
const ORDINARY_PROTOTYPE = 'Object.prototype';
const INSTANCE_KEY = 'Symbol.hasInstance';
const DEFINING: ReadonlySet<string> = new Set(['Object.defineProperty', 'Reflect.defineProperty']);

/** Membership needs an object; instanceof additionally needs a callable target or instance hook. */
export function membershipThrows(node: Node, resolve: Resolve | undefined): boolean {
  if (
    !isBinaryExpression(node) ||
    (node.operatorToken.kind !== SyntaxKind.InKeyword &&
      node.operatorToken.kind !== SyntaxKind.InstanceOfKeyword)
  ) {
    return false;
  }
  const right = writtenOf(node.right, resolve);
  return (
    primitiveOf(right, resolve) !== undefined ||
    isSymbolWritten(right, resolve) ||
    (node.operatorToken.kind === SyntaxKind.InstanceOfKeyword &&
      ((isObjectLiteralExpression(right) && lacksInstanceHook(right, node, resolve)) ||
        nullFactoryTarget(right, node.right, resolve) ||
        invalidFunctionTarget(node.left, right, node, resolve)))
  );
}

/** OrdinaryHasInstance reads a callable's prototype only for an object left operand. */
function invalidFunctionTarget(
  left: Expression,
  right: Expression,
  at: Node,
  resolve: Resolve | undefined,
): boolean {
  const lhs = writtenOf(left, resolve);
  const target = metadataCallee(right);
  const quietClass = emptyClass(lhs);
  if (
    target === undefined ||
    (!quietClass && callbackCreationEffect(lhs)) ||
    nativeEvaluationChanged(at)
  ) {
    return false;
  }
  const object =
    isObjectLiteralExpression(lhs) ||
    isArrayLiteralExpression(lhs) ||
    isRegularExpressionLiteral(lhs) ||
    isNewExpression(lhs) ||
    functionObject(lhs) ||
    quietClass;
  return (
    object &&
    ((isExpression(target) && lacksFunctionPrototype(target, right)) || isMethodDeclaration(target))
  );
}

/** Functions remain object values even when their own bodies and parameter defaults are deferred. */
function functionObject(node: Expression): boolean {
  const value = metadataCallee(node) ?? node;
  return isArrowFunction(value) || isFunctionExpression(value) || isFunctionDeclaration(value);
}

/** An empty undecorated base class has no eager fields, keys, blocks or heritage evaluation. */
function emptyClass(node: Expression): boolean {
  return (
    isClassExpression(node) &&
    node.members.length === 0 &&
    (node.heritageClauses?.length ?? 0) === 0 &&
    (node.modifiers?.length ?? 0) === 0
  );
}

/** A source-proven empty null-prototype result, excluding later writes or application handoffs. */
function nullFactoryTarget(
  value: Expression,
  at: Expression,
  resolve: Resolve | undefined,
): boolean {
  const target = metadataCallee(value);
  return (
    target !== undefined &&
    isExpression(target) &&
    emptyNullFactory(target, resolve) &&
    !calleeUncertain(target, at)
  );
}

/** The final own callable instance hook, where no intervening evaluation can replace it. */
export function instanceHookFunction(node: Node, resolve: Resolve | undefined): Node | undefined {
  if (!isBinaryExpression(node) || node.operatorToken.kind !== SyntaxKind.InstanceOfKeyword) {
    return undefined;
  }
  const value = writtenOf(node.right, resolve);
  if (!isObjectLiteralExpression(value) || interveningEvaluation(value, node.right)) {
    return undefined;
  }
  for (const property of value.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return undefined;
    }
    const key = instanceKey(property.name, resolve);
    if (key === 'unknown') {
      return undefined;
    }
    if (key === 'hook') {
      return hookFunction(property, resolve);
    }
  }
  return undefined;
}

/** A data property or method's source function, excluding an accessor's unknown result. */
function hookFunction(
  property: ObjectLiteralElementLike,
  resolve: Resolve | undefined,
): Node | undefined {
  if (isMethodDeclaration(property)) {
    return property;
  }
  if (isPropertyAssignment(property)) {
    const fn = writtenOf(property.initializer, resolve);
    return metadataCallee(fn) ?? fn;
  }
  return undefined;
}

/** A plain noncallable object's final own hook, or its ordinary prototype's lack of one. */
function lacksInstanceHook(
  value: ObjectLiteralExpression,
  operation: Node,
  resolve: Resolve | undefined,
): boolean {
  for (const property of value.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return false;
    }
    const kind = instanceKey(property.name, resolve);
    if (kind === 'unknown' || hasInstancePrototype(property, resolve)) {
      return false;
    }
    if (kind === 'hook') {
      return invalidInstanceHook(property, resolve);
    }
  }
  return (
    !includesApplication(value) &&
    (hasNullPrototype(value, resolve) || !earlierInstanceHook(operation, resolve))
  );
}

/** A null prototype excludes Object.prototype's hook, even where earlier code installs one. */
function hasNullPrototype(value: ObjectLiteralExpression, resolve: Resolve | undefined): boolean {
  return value.properties.some((property) => {
    return (
      isPropertyAssignment(property) &&
      !isComputedPropertyName(property.name) &&
      (isIdentifier(property.name) ? property.name.text : literalKey(property.name)) ===
        '__proto__' &&
      writtenOf(property.initializer, resolve).kind === SyntaxKind.NullKeyword
    );
  });
}

/** The last direct hook write in an enclosing execution block, without following deferred code. */
function earlierInstanceHook(node: Node, resolve: Resolve | undefined): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    const parent = each.parent;
    if (isBlock(parent)) {
      const changed = priorBlockHook(parent, each.pos, resolve);
      if (changed !== undefined) {
        return changed;
      }
    }
    if (runsLater(parent) || isFunctionDeclaration(parent)) {
      break;
    }
  }
  return false;
}

/** A block's last relevant direct statement, with unknown application evaluation kept opaque. */
function priorBlockHook(
  block: Block,
  before: number,
  resolve: Resolve | undefined,
): boolean | undefined {
  for (const statement of block.statements.toReversed()) {
    if (statement.end > before || !isExpressionStatement(statement)) {
      continue;
    }
    const changed = instanceHookWrite(statement.expression, resolve);
    if (changed !== undefined) {
      return changed;
    }
    if (
      includesApplication(statement.expression) &&
      !unrelatedIntrinsic(statement.expression, resolve)
    ) {
      return true;
    }
  }
  return undefined;
}

/** A written scalar Math call, or a plain native definition of a different property/receiver. */
function unrelatedIntrinsic(node: Expression, resolve: Resolve | undefined): boolean {
  if (!isCallExpression(node)) {
    return false;
  }
  const path = globalCalleePath(node.expression, resolve)?.join('.');
  if (path?.startsWith('Math.') === true) {
    return node.arguments.every(
      (each) => primitiveOf(writtenOf(each, resolve), resolve) !== undefined,
    );
  }
  if (!DEFINING.has(path ?? '')) {
    return false;
  }
  const [target, key, descriptor] = node.arguments;
  return (
    target !== undefined &&
    key !== undefined &&
    descriptor !== undefined &&
    (isObjectLiteralExpression(target) ||
      globalCalleePath(target, resolve)?.join('.') === ORDINARY_PROTOTYPE) &&
    (primitiveOf(writtenOf(key, resolve), resolve) !== undefined ||
      isSymbolWritten(key, resolve)) &&
    node.arguments.every((each) => plainArgument(each, resolve)) &&
    plainDescriptor(writtenOf(descriptor, resolve))
  );
}

/** A literal or the two native references whose property reads cannot invoke an application getter. */
function plainArgument(node: Expression, resolve: Resolve | undefined): boolean {
  const path = globalCalleePath(node, resolve)?.join('.');
  return path === ORDINARY_PROTOTYPE || path === INSTANCE_KEY || !includesApplication(node);
}

/** Literal descriptor data and methods are read without invoking an accessor or a computed key. */
function plainDescriptor(node: Expression): boolean {
  return (
    isObjectLiteralExpression(node) &&
    node.properties.every((property) => {
      return (
        !isSpreadAssignment(property) &&
        !isComputedPropertyName(property.name) &&
        (property.kind === SyntaxKind.MethodDeclaration || isPropertyAssignment(property))
      );
    })
  );
}

/** A direct assignment/deletion or known native definition of Object.prototype's instance hook. */
function instanceHookWrite(node: Expression, resolve: Resolve | undefined): boolean | undefined {
  if (isDeleteExpression(node) && prototypeHook(node.expression, resolve)) {
    return false;
  }
  if (
    isBinaryExpression(node) &&
    node.operatorToken.kind === SyntaxKind.EqualsToken &&
    prototypeHook(node.left, resolve)
  ) {
    return !invalidHookValue(node.right, resolve);
  }
  if (!isCallExpression(node)) {
    return undefined;
  }
  const path = globalCalleePath(node.expression, resolve)?.join('.');
  const [target, key, value] = node.arguments;
  if (
    target === undefined ||
    key === undefined ||
    globalCalleePath(target, resolve)?.join('.') !== ORDINARY_PROTOTYPE ||
    globalCalleePath(key, resolve)?.join('.') !== INSTANCE_KEY
  ) {
    return undefined;
  }
  if (path === 'Reflect.set') {
    return value !== undefined && !invalidHookValue(value, resolve);
  }
  return DEFINING.has(path ?? '') ? descriptorHasHook(value, resolve) : undefined;
}

/** The symbol-keyed reference whose writes can change an ordinary object's inherited hook. */
function prototypeHook(node: Expression, resolve: Resolve | undefined): boolean {
  return (
    isElementAccessExpression(node) &&
    globalCalleePath(node.expression, resolve)?.join('.') === ORDINARY_PROTOTYPE &&
    globalCalleePath(node.argumentExpression, resolve)?.join('.') === INSTANCE_KEY
  );
}

/** A descriptor's written value or getter; unknown descriptor reads may supply a callable hook. */
function descriptorHasHook(node: Expression | undefined, resolve: Resolve | undefined): boolean {
  if (node === undefined) {
    return false;
  }
  const value = writtenOf(node, resolve);
  if (!isObjectLiteralExpression(value)) {
    return true;
  }
  for (const property of value.properties.toReversed()) {
    if (isSpreadAssignment(property)) {
      return true;
    }
    const key = descriptorKey(property.name, resolve);
    if (key === undefined || ['get', 'value'].includes(key)) {
      return key === undefined || !invalidInstanceHook(property, resolve);
    }
  }
  return false;
}

/** An ordinary descriptor field's literal name, following written computed scalar keys. */
function descriptorKey(name: PropertyName, resolve: Resolve | undefined): string | undefined {
  if (isComputedPropertyName(name)) {
    return literalKey(writtenOf(name.expression, resolve));
  }
  return isIdentifier(name) ? name.text : literalKey(name);
}

/** The instance hook's symbol, another known property key, or an unknown possible hook key. */
function instanceKey(
  name: PropertyName,
  resolve: Resolve | undefined,
): 'hook' | 'other' | 'unknown' {
  if (!isComputedPropertyName(name)) {
    return 'other';
  }
  const key = writtenOf(name.expression, resolve);
  const held = isIdentifier(key) ? metadataCallee(key) : key;
  const literal = held !== undefined && isExpression(held) ? held : key;
  if (globalCalleePath(literal, resolve)?.join('.') === INSTANCE_KEY) {
    return 'hook';
  }
  return isSymbolWritten(literal, resolve) || constantValue(literal, resolve) !== undefined
    ? 'other'
    : 'unknown';
}

/** A non-primitive explicit prototype may supply a callable inherited hook. */
function hasInstancePrototype(
  property: ObjectLiteralElementLike,
  resolve: Resolve | undefined,
): boolean {
  if (!isPropertyAssignment(property) || isComputedPropertyName(property.name)) {
    return false;
  }
  const key = isIdentifier(property.name) ? property.name.text : literalKey(property.name);
  if (key !== '__proto__') {
    return false;
  }
  const prototype = writtenOf(property.initializer, resolve);
  return primitiveOf(prototype, resolve) === undefined && !isSymbolWritten(prototype, resolve);
}

/** A data hook known to throw when GetMethod reads it or falls back to the noncallable target. */
function invalidInstanceHook(
  property: ObjectLiteralElementLike,
  resolve: Resolve | undefined,
): boolean {
  if (!isPropertyAssignment(property)) {
    return false;
  }
  return invalidHookValue(property.initializer, resolve);
}

/** A primitive or noncallable literal cannot implement the instance hook. */
function invalidHookValue(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  return (
    primitiveOf(value, resolve) !== undefined ||
    isSymbolWritten(value, resolve) ||
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isRegularExpressionLiteral(value) ||
    isClassExpression(value)
  );
}
