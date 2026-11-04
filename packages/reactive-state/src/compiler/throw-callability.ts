import {
  type ClassDeclaration,
  type ElementAccessExpression,
  type Expression,
  type FunctionDeclaration,
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isTaggedTemplateExpression,
  isVoidExpression,
  type MethodDeclaration,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf } from './bounded.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { literalKey } from './exported-values.ts';
import { metadataCallee } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { globalCalleePath } from './throw-callees.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';
import { interveningEvaluation } from './written-evaluation.ts';

/** A missing ordinary own member, distinct from an unknown accessor or receiver. */
const ABSENT = { kind: 'absent' } as const;
type Callee = Expression | FunctionDeclaration | ClassDeclaration | MethodDeclaration;
type Target = Callee | typeof ABSENT | undefined;
interface Reading {
  readonly resolve: Resolve | undefined;
  readonly seen: Set<Expression>;
}

/** Object.prototype members may provide a callable value even when a literal has no own entry. */
const INHERITED: ReadonlySet<string> = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);

/** Calls, tags and constructions whose source-proven target cannot perform the requested operation. */
export function invocationThrows(node: Node, resolve: Resolve | undefined): boolean {
  if (!isCallExpression(node) && !isNewExpression(node) && !isTaggedTemplateExpression(node)) {
    return false;
  }
  const expression = isTaggedTemplateExpression(node) ? node.tag : node.expression;
  const target = calleeOf(expression, { resolve, seen: new Set() });
  if (target === undefined) {
    return false;
  }
  if (
    isCallExpression(node) &&
    node.questionDotToken !== undefined &&
    nullishTarget(target, resolve)
  ) {
    return false;
  }
  return targetThrows(target, isNewExpression(node), resolve);
}

/** Whether a source-proven target cannot serve as a constructor, without invoking its body. */
export function constructorTargetThrows(node: Expression, resolve: Resolve | undefined): boolean {
  const target = calleeOf(node, { resolve, seen: new Set() });
  return target !== undefined && targetThrows(target, true, resolve);
}

/** A known target's invocation mode, independent of its call syntax. */
function targetThrows(
  target: Exclude<Target, undefined>,
  constructs: boolean,
  resolve: Resolve | undefined,
): boolean {
  if (target.kind === ABSENT.kind) {
    return true;
  }
  if (isClassDeclaration(target) || isClassExpression(target)) {
    return !constructs;
  }
  if (isArrowFunction(target) || isMethodDeclaration(target)) {
    return constructs;
  }
  if (isFunctionDeclaration(target) || isFunctionExpression(target)) {
    const later =
      target.asteriskToken !== undefined ||
      target.modifiers?.some((each) => each.kind === SyntaxKind.AsyncKeyword) === true;
    return constructs && later;
  }
  return nonCallableValue(target, resolve);
}

/** Primitive values and literal ordinary objects have no [[Call]] or [[Construct]] internal method. */
function nonCallableValue(target: Expression, resolve: Resolve | undefined): boolean {
  return (
    primitiveOf(target, resolve) !== undefined ||
    isSymbolWritten(target, resolve) ||
    isBigIntWritten(target, resolve) ||
    isObjectLiteralExpression(target) ||
    isArrayLiteralExpression(target) ||
    isRegularExpressionLiteral(target)
  );
}

/** A proven missing or nullish callee also short-circuits optional-call arguments. */
export function nullishCallee(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) {
    return false;
  }
  const target = calleeOf(value, { resolve, seen: new Set() });
  return target !== undefined && nullishTarget(target, resolve);
}

/** Whether a target is nullish, without treating an unknown member as absent. */
function nullishTarget(target: Exclude<Target, undefined>, resolve: Resolve | undefined): boolean {
  if (target.kind === ABSENT.kind) {
    return true;
  }
  return (
    !isFunctionDeclaration(target) &&
    !isClassDeclaration(target) &&
    !isMethodDeclaration(target) &&
    primitiveOf(target, resolve) === 'nothing'
  );
}

/** A literal/constant callee or an ordinary object's statically selected own member. */
function calleeOf(node: Expression, reading: Reading): Target {
  const value = writtenOf(node, reading.resolve);
  if (reading.seen.has(value)) {
    return undefined;
  }
  reading.seen.add(value);
  if (isIdentifier(value)) {
    const declared = metadataCallee(value);
    return declared !== undefined &&
      (isExpression(declared) ||
        isFunctionDeclaration(declared) ||
        isClassDeclaration(declared) ||
        isMethodDeclaration(declared))
      ? declared
      : value;
  }
  if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) {
    return value;
  }
  return memberTarget(value, reading);
}

/** A statically named member of a literal receiver, including present array elements. */
function memberTarget(
  value: PropertyAccessExpression | ElementAccessExpression,
  reading: Reading,
): Target {
  const key = isPropertyAccessExpression(value)
    ? value.name.text
    : literalKey(writtenOf(value.argumentExpression, reading.resolve));
  if (key === undefined) {
    return undefined;
  }
  const written = writtenOf(value.expression, reading.resolve);
  const held = metadataCallee(written);
  const receiver =
    held !== undefined && isExpression(held) && !interveningEvaluation(held, value.expression)
      ? held
      : written;
  if (isObjectLiteralExpression(receiver)) {
    return objectMember(receiver, key, reading);
  }
  if (emptyNullFactory(receiver, reading.resolve)) {
    return ABSENT;
  }
  if (
    isArrayLiteralExpression(receiver) &&
    !receiver.elements.some((each) => isSpreadElement(each))
  ) {
    const index = Number(key);
    if (Number.isSafeInteger(index) && index >= 0 && String(index) === key) {
      const item = receiver.elements[index];
      return item === undefined || isOmittedExpression(item) ? ABSENT : calleeOf(item, reading);
    }
  }
  return undefined;
}

/** A fresh Object.create(null) result with no descriptors has no inherited or own member. */
export function emptyNullFactory(node: Expression, resolve: Resolve | undefined): boolean {
  if (
    !isCallExpression(node) ||
    node.arguments.length > 2 ||
    node.arguments.some((each) => isSpreadElement(each))
  ) {
    return false;
  }
  const [prototype, descriptors] = node.arguments;
  if (
    prototype === undefined ||
    constantExpression(prototype, resolve).kind !== SyntaxKind.NullKeyword ||
    globalCalleePath(constantExpression(node.expression, resolve), resolve)?.join('.') !==
      'Object.create'
  ) {
    return false;
  }
  if (descriptors === undefined) {
    return true;
  }
  const value = constantExpression(descriptors, resolve);
  return (
    isVoidExpression(value) ||
    (isIdentifier(value) && globalOf(value) === 'undefined') ||
    (isObjectLiteralExpression(value) &&
      value.properties.length === 0 &&
      !calleeUncertain(value, descriptors))
  );
}

/** A factory argument or callable followed only through the existing lexical constant proof. */
function constantExpression(node: Expression, resolve: Resolve | undefined): Expression {
  const value = writtenOf(node, resolve);
  const held = metadataCallee(value);
  return held !== undefined && isExpression(held) ? held : value;
}

/** A literal's surviving data member/method, with getters and uncertain keys left unknown. */
function objectMember(value: ObjectLiteralExpression, key: string, reading: Reading): Target {
  if (reading.seen.has(value)) {
    return undefined;
  }
  reading.seen.add(value);
  let found: ObjectLiteralElementLike | undefined;
  let prototype: Expression | undefined;
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) {
      return undefined;
    }
    const name = propertyKey(property.name, reading.resolve);
    if (name === undefined) {
      return undefined;
    }
    if (
      name === '__proto__' &&
      isPropertyAssignment(property) &&
      !isComputedPropertyName(property.name)
    ) {
      prototype = property.initializer;
    } else if (name === key) {
      found = property;
    }
  }
  return found === undefined
    ? inheritedMember(prototype, key, reading)
    : selectedMember(found, reading);
}

/** An ordinary property name or a computed key with a literal source value. */
function propertyKey(name: PropertyName, resolve: Resolve | undefined): string | undefined {
  if (isIdentifier(name)) {
    return name.text;
  }
  const value = isComputedPropertyName(name) ? writtenOf(name.expression, resolve) : name;
  return literalKey(value);
}

/** A surviving data value or method; reading an accessor remains unknown. */
function selectedMember(found: ObjectLiteralElementLike, reading: Reading): Target {
  if (isPropertyAssignment(found)) {
    return calleeOf(found.initializer, reading);
  }
  if (isShorthandPropertyAssignment(found) && isIdentifier(found.name)) {
    return calleeOf(found.name, reading);
  }
  return isMethodDeclaration(found) ? found : undefined;
}

/** A written prototype's member, or an absent ordinary member beyond Object.prototype. */
function inheritedMember(prototype: Expression | undefined, key: string, reading: Reading): Target {
  if (prototype !== undefined) {
    const parent = writtenOf(prototype, reading.resolve);
    if (parent.kind === SyntaxKind.NullKeyword) {
      return ABSENT;
    }
    if (isObjectLiteralExpression(parent)) {
      return objectMember(parent, key, reading);
    }
    if (primitiveOf(parent, reading.resolve) === undefined) {
      return undefined;
    }
  }
  return INHERITED.has(key) ? undefined : ABSENT;
}
