import {
  type Expression,
  isBlock,
  isCallExpression,
  isComputedPropertyName,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadAssignment,
  isSpreadElement,
  isVariableStatement,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import type { Resolve } from './numbers.ts';
import { globalCalleePath } from './throw-callees.ts';
import { type Property, writtenDescriptors } from './throw-definitions.ts';
import { enumerationKey } from './throw-keys.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';

/** The first target setter invoked in Object.assign's known source-property copy order. */
export function assignTargetSetter(node: Node, resolve: Resolve | undefined): Node | undefined {
  if (
    !isCallExpression(node) ||
    node.arguments.some((each) => isSpreadElement(each)) ||
    earlierExpressionEffect(node)
  ) {
    return undefined;
  }
  const follow: Resolve = (name) => resolve?.(name) ?? metadataInitializer(name);
  if (
    priorEffect(node, follow) ||
    globalCalleePath(node.expression, follow)?.join('.') !== 'Object.assign'
  ) {
    return undefined;
  }
  const values = node.arguments.map((argument) => writtenOf(argument, follow));
  if (values.some((value) => !quietArgument(value, follow) || calleeUncertain(value, node))) {
    return undefined;
  }
  const [target, ...sources] = values;
  const snapshot = target === undefined ? undefined : writtenDescriptors(target, follow);
  if (snapshot === undefined) {
    return undefined;
  }
  for (const source of sources) {
    const selected = copiedSetter(source, snapshot, follow);
    if (!selected.complete) {
      return selected.setter;
    }
  }
  return undefined;
}

/** A data copy is quiet; the first getter or setter prevents assumptions about later copies. */
function copiedSetter(
  source: Expression,
  target: NonNullable<ReturnType<typeof writtenDescriptors>>,
  resolve: Resolve,
): { readonly complete: boolean; readonly setter?: Node | undefined } {
  const kind = primitiveOf(source, resolve);
  if (kind !== undefined && kind !== 'text') {
    return { complete: true };
  }
  const snapshot = writtenDescriptors(source, resolve);
  if (snapshot === undefined) {
    return { complete: false };
  }
  // Only source-bounded string keys reach this native key-order operation; no source values run.
  const keys = Object.keys(Object.fromEntries(snapshot.properties));
  for (const key of keys) {
    const property = snapshot.properties.get(key);
    if (property?.enumerable !== true) {
      continue;
    }
    if (readsGetter(property)) {
      return { complete: false };
    }
    const destination = target.properties.get(key);
    if (destination?.kind === 'accessor') {
      return { complete: false, setter: sourceSetter(destination) };
    }
    if (destination?.writable !== true) {
      return { complete: false };
    }
  }
  return { complete: true };
}

/** A missing source getter is known not to run application code before the target write. */
function readsGetter(property: Property): boolean {
  const getter = property.values.get('get');
  return property.kind === 'accessor' && (getter === undefined || getter.value !== undefined);
}

/** A statically selected own setter whose source body can be checked separately. */
function sourceSetter(property: Property): Node | undefined {
  const setter = property.values.get('set')?.value;
  return typeof setter === 'object' &&
    setter !== null &&
    (isAnswering(setter) || isSetAccessorDeclaration(setter))
    ? setter
    : undefined;
}

/** Every argument is evaluated before copying, without calls, reads or unproven key coercions. */
function quietArgument(value: Expression, resolve: Resolve): boolean {
  if (!isObjectLiteralExpression(value)) {
    return !callbackCreationEffect(value);
  }
  return value.properties.every((property) => quietProperty(property, resolve));
}

/** Literal methods defer their bodies; data initializers and computed names execute now. */
function quietProperty(
  property: ObjectLiteralExpression['properties'][number],
  resolve: Resolve,
): boolean {
  if (isSpreadAssignment(property)) {
    return false;
  }
  const key = enumerationKey(property.name, resolve);
  return (
    typeof key === 'string' &&
    key !== '__proto__' &&
    (!isComputedPropertyName(property.name) || !callbackCreationEffect(property.name.expression)) &&
    (!isPropertyAssignment(property) || !callbackCreationEffect(property.initializer))
  );
}

/** Prior enclosing work can replace the native callable or descriptors before this invocation. */
function priorEffect(node: Node, resolve: Resolve): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && statementEffect(statement, resolve),
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Simple literal bindings create setters without executing their deferred bodies. */
function statementEffect(node: Node, resolve: Resolve): boolean {
  if (!isVariableStatement(node)) {
    return callbackCreationEffect(node);
  }
  return node.declarationList.declarations.some((declaration) => {
    if (!isIdentifier(declaration.name)) {
      return true;
    }
    return (
      declaration.initializer !== undefined &&
      !quietArgument(writtenOf(declaration.initializer, resolve), resolve)
    );
  });
}
