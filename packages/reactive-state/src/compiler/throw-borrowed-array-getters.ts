import {
  type CallExpression,
  type Expression,
  type GetAccessorDeclaration,
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadAssignment,
  isTaggedTemplateExpression,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { borrowedCall } from './borrowed-calls.ts';
import { calledMember } from './bounded.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import { constantNumber, type Resolve } from './numbers.ts';
import { skipsEvaluation } from './skipped-evaluation.ts';
import { globalCalleePath } from './throw-callees.ts';
import { conversionRunsCode } from './throw-coercions.ts';
import { type Property, writtenDescriptors } from './throw-definitions.ts';
import { enumerationKey } from './throw-keys.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { writtenBy } from './written.ts';

const METHODS: ReadonlySet<string> = new Set(['join', 'map']);

/** The first own getter a borrowed native join or map necessarily reads, before other source code. */
export function borrowedArrayGetter(
  node: Node,
  outer: Resolve | undefined,
): GetAccessorDeclaration | undefined {
  if (!isCallExpression(node)) {
    return undefined;
  }
  const resolve: Resolve = (name) => outer?.(name) ?? metadataInitializer(name);
  const borrowed = borrowedCall(node, resolve);
  const member = borrowed === undefined ? undefined : calledMember(borrowed.call.expression);
  if (
    member === undefined ||
    borrowed?.brand !== 'Array' ||
    !METHODS.has(member.name) ||
    !quietArguments(node, resolve) ||
    earlierExpressionEffect(node) ||
    earlierStatementEffect(node)
  ) {
    return undefined;
  }
  const value = literalOf(member.of, node, resolve);
  if (value === undefined) {
    return undefined;
  }
  const properties = writtenDescriptors(value, resolve)?.properties;
  const length = properties?.get('length');
  const getter = getterOf(length);
  if (getter !== undefined) {
    return getter;
  }
  if (!positiveLength(length, resolve)) {
    return undefined;
  }
  // join converts its separator before reading an index; application conversion may repair it.
  const separator = borrowed.call.arguments[0];
  if (
    separator !== undefined &&
    member.name === 'join' &&
    primitiveOf(writtenOf(separator, resolve), resolve) === undefined
  ) {
    return undefined;
  }
  return getterOf(properties?.get('0'));
}

/** Only an unchanged plain literal proves which first getters native array code will encounter. */
function literalOf(
  node: Expression,
  call: CallExpression,
  resolve: Resolve,
): ObjectLiteralExpression | undefined {
  const value = writtenOf(node, resolve);
  if (
    !isObjectLiteralExpression(value) ||
    creationEffect(value, resolve) ||
    calleeUncertain(value, call)
  ) {
    return undefined;
  }
  return value.properties.some((property) => {
    return (
      isSpreadAssignment(property) ||
      ['__proto__', null, undefined].includes(enumerationKey(property.name, resolve))
    );
  })
    ? undefined
    : value;
}

/** An accessor pair keeps its surviving getter; a setter or an overwritten getter is not read. */
function getterOf(property: Property | undefined): GetAccessorDeclaration | undefined {
  const getter = property?.values.get('get')?.value;
  return getter !== null &&
    typeof getter === 'object' &&
    property?.kind === 'accessor' &&
    isGetAccessorDeclaration(getter)
    ? getter
    : undefined;
}

/** A known positive primitive length guarantees a first index, without invoking ToLength hooks. */
function positiveLength(property: Property | undefined, resolve: Resolve): boolean {
  const known = property?.values.get('value');
  if (known === undefined || property?.kind !== 'data') {
    return false;
  }
  const length =
    known.source === undefined
      ? typeof known.value === 'number' && known.value
      : constantNumber(known.source, resolve);
  return typeof length === 'number' && length >= 1;
}

/** All actual arguments finish before a native method starts, including ignored extra arguments. */
function quietArguments(node: CallExpression, resolve: Resolve): boolean {
  return node.arguments.every((each) => {
    const path = globalCalleePath(each, resolve)?.join('.');
    return (
      path === 'Array.prototype.join' ||
      path === 'Array.prototype.map' ||
      !creationEffect(each, resolve)
    );
  });
}

/** Computed constant names run quietly; accessor bodies and method bodies remain deferred. */
function creationEffect(node: Node, resolve: Resolve): boolean {
  const pending = [node];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (skipsEvaluation(each, undefined)) {
      continue;
    }
    if (isAnswering(each) || isSetAccessorDeclaration(each)) {
      if (unknownName(each, resolve)) {
        return true;
      }
      continue;
    }
    if (
      isComputedPropertyName(each) &&
      enumerationKey(each, resolve) !== undefined &&
      !callbackCreationEffect(each.expression)
    ) {
      continue;
    }
    if (
      isCallExpression(each) ||
      isNewExpression(each) ||
      isPropertyAccessExpression(each) ||
      isElementAccessExpression(each) ||
      isTaggedTemplateExpression(each) ||
      isClassDeclaration(each) ||
      isClassExpression(each) ||
      conversionRunsCode(each) ||
      writtenBy(each) !== undefined ||
      isComputedPropertyName(each)
    ) {
      return true;
    }
    each.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** An accessor or method evaluates a computed name while its body remains deferred. */
function unknownName(node: Node, resolve: Resolve): boolean {
  return (
    (isMethodDeclaration(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node)) &&
    isComputedPropertyName(node.name) &&
    (enumerationKey(node.name, resolve) === undefined ||
      callbackCreationEffect(node.name.expression))
  );
}

/** Prior work in enclosing executions can replace the native method or change a retained literal. */
function earlierStatementEffect(call: CallExpression): boolean {
  for (let each: Node = call; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && callbackCreationEffect(statement),
      )
    ) {
      return true;
    }
  }
  return false;
}
