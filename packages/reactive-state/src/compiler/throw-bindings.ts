import {
  type BindingElement,
  type Expression,
  type GetAccessorDeclaration,
  type Identifier,
  isArrayBindingPattern,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isSourceFile,
  isSpreadAssignment,
  isStringLiteral,
  isTaggedTemplateExpression,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type ObjectBindingPattern,
  type PropertyName,
  type VariableDeclaration,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { declarationOf } from './framed.ts';
import type { Resolve } from './numbers.ts';
import { conversionRunsCode } from './throw-coercions.ts';
import { nonIterableWritten } from './throw-collections.ts';
import { type Property, writtenDescriptors } from './throw-definitions.ts';
import { enumerationKey } from './throw-keys.ts';
import { primitiveOf, writtenOf } from './throw-shapes.ts';
import { writtenBy } from './written.ts';

/** What initializing a written destructuring pattern throws before its bindings hold values. */

/** A declaration or declaration statement whose pattern cannot initialize its written source. */
export function destructuringThrows(node: Node, resolve: Resolve | undefined): boolean {
  if (isVariableStatement(node)) {
    return node.declarationList.declarations.some((each) => declarationThrows(each, resolve));
  }
  return isVariableDeclaration(node) && declarationThrows(node, resolve);
}

/** The first proven own getter an object binding reads, including enumerable rest entries. */
export function bindingGetter(
  node: Node,
  outer: Resolve | undefined,
): GetAccessorDeclaration | undefined {
  if (
    !isVariableDeclaration(node) ||
    !isObjectBindingPattern(node.name) ||
    node.initializer === undefined
  ) {
    return undefined;
  }
  const resolve: Resolve = (reference) => outer?.(reference) ?? constantInitializer(reference);
  if (earlierEffect(node, resolve)) {
    return undefined;
  }
  const source = writtenOf(node.initializer, resolve);
  if (
    !isObjectLiteralExpression(source) ||
    creationEffect(source, resolve) ||
    calleeUncertain(source, node.initializer)
  ) {
    return undefined;
  }
  const snapshot = writtenDescriptors(source, resolve);
  return snapshot === undefined
    ? undefined
    : selectedGetter(node.name, snapshot.properties, resolve);
}

/** Earlier binding defaults, nested patterns and reads can change descriptors selected later. */
function selectedGetter(
  pattern: ObjectBindingPattern,
  properties: ReadonlyMap<string, Property>,
  resolve: Resolve,
): GetAccessorDeclaration | undefined {
  const excluded = new Set<string>();
  for (const element of pattern.elements) {
    if (element.dotDotDotToken !== undefined) {
      return restGetter(properties, excluded);
    }
    const key = bindingKey(element, resolve);
    if (key === undefined) {
      return undefined;
    }
    excluded.add(key);
    const property = properties.get(key);
    if (property === undefined) {
      return undefined;
    }
    if (property.kind === 'accessor') {
      const getter = property.values.get('get');
      if (getter === undefined || getter.value !== undefined) {
        return sourceGetter(property);
      }
    }
    if (laterBindingEffect(element, resolve)) {
      return undefined;
    }
  }
  return undefined;
}

/** A computed name runs before Get; neither an unknown key nor an application read selects it. */
function bindingKey(element: BindingElement, resolve: Resolve): string | undefined {
  const name = element.propertyName ?? element.name;
  if (
    name === undefined ||
    isObjectBindingPattern(name) ||
    isArrayBindingPattern(name) ||
    (isComputedPropertyName(name) && creationEffect(name.expression, resolve))
  ) {
    return undefined;
  }
  const key = enumerationKey(name, resolve);
  return typeof key === 'string' ? key : undefined;
}

/** A nested pattern or effectful default may change descriptors before another property is read. */
function laterBindingEffect(element: BindingElement, resolve: Resolve): boolean {
  return (
    element.name === undefined ||
    !isIdentifier(element.name) ||
    (element.initializer !== undefined && creationEffect(element.initializer, resolve))
  );
}

/** Rest copies only remaining enumerable own keys, in native numeric-then-insertion order. */
function restGetter(
  properties: ReadonlyMap<string, Property>,
  excluded: ReadonlySet<string>,
): GetAccessorDeclaration | undefined {
  const keys = Object.keys(Object.fromEntries(properties));
  for (const key of keys) {
    const property = properties.get(key);
    if (excluded.has(key) || property?.enumerable !== true || property.kind !== 'accessor') {
      continue;
    }
    const getter = property.values.get('get');
    if (getter === undefined || getter.value !== undefined) {
      return sourceGetter(property);
    }
  }
  return undefined;
}

/** Descriptor source nodes are inspected separately, without invoking their application getter. */
function sourceGetter(property: Property): GetAccessorDeclaration | undefined {
  const getter = property.values.get('get')?.value;
  return typeof getter === 'object' && getter !== null && isGetAccessorDeclaration(getter)
    ? getter
    : undefined;
}

/** Earlier actual evaluations, including another pattern in this declaration list, remain opaque. */
function earlierEffect(node: Node, resolve: Resolve): boolean {
  for (let each = node; !isSourceFile(each); each = each.parent) {
    const status = { effect: false };
    each.parent.forEachChild((part) => {
      if (part.end <= each.pos && creationEffect(part, resolve)) {
        status.effect = true;
      }
    });
    if (status.effect) {
      return true;
    }
  }
  return false;
}

/** Literal methods defer their bodies; binding reads and computed or application work do not. */
function creationEffect(node: Node, resolve: Resolve): boolean {
  const pending = [node];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (isAnswering(each) || isSetAccessorDeclaration(each)) {
      const key = computedName(each);
      if (key !== undefined) {
        pending.push(key);
      }
      continue;
    }
    if (
      evaluationSyntax(each) ||
      isSpreadAssignment(each) ||
      prototypeEntry(each) ||
      writtenBy(each) !== undefined ||
      conversionRunsCode(each) ||
      (isVariableDeclaration(each) && each.initializer !== undefined && !isIdentifier(each.name)) ||
      (isComputedPropertyName(each) && enumerationKey(each, resolve) === undefined)
    ) {
      return true;
    }
    each.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Synchronous source operations that may mutate a later-read descriptor while they run. */
function evaluationSyntax(node: Node): boolean {
  return (
    isCallExpression(node) ||
    isNewExpression(node) ||
    isPropertyAccessExpression(node) ||
    isElementAccessExpression(node) ||
    isTaggedTemplateExpression(node) ||
    isClassDeclaration(node) ||
    isClassExpression(node)
  );
}

/** Source prototypes can supply inherited getters before a later own read. */
function prototypeEntry(node: Node): boolean {
  return (
    isPropertyAssignment(node) &&
    (isIdentifier(node.name) || isStringLiteral(node.name)) &&
    node.name.text === '__proto__'
  );
}

/** Computed method and accessor names execute while their bodies stay deferred. */
function computedName(node: Node): PropertyName | undefined {
  return (isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)) &&
    isComputedPropertyName(node.name)
    ? node.name
    : undefined;
}

/** Object bindings require a non-nullish source; array bindings request an iterator, even empty. */
function declarationThrows(node: VariableDeclaration, resolve: Resolve | undefined): boolean {
  const { initializer, name } = node;
  if (initializer === undefined) {
    return false;
  }
  const follow: Resolve = (reference) => resolve?.(reference) ?? primitiveConstant(reference);
  if (isArrayBindingPattern(name)) {
    return nonIterableWritten(initializer, follow);
  }
  return (
    isObjectBindingPattern(name) &&
    primitiveOf(writtenOf(initializer, follow), follow) === 'nothing'
  );
}

/** An immutable primitive local keeps its value without a mutable-object alias proof. */
function primitiveConstant(name: Identifier): Expression | undefined {
  const initializer = constantInitializer(name);
  const value = initializer === undefined ? undefined : unwrapped(initializer);
  return value === undefined || primitiveOf(value, undefined) === undefined ? undefined : value;
}

/** A constant's lexical initializer; object aliases still require a separate freshness proof. */
function constantInitializer(name: Identifier): Expression | undefined {
  const declared = declarationOf(name);
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    !isIdentifier(declared.name) ||
    declared.initializer === undefined ||
    !/^const\s/u.test(declared.parent.getText())
  ) {
    return undefined;
  }
  return declared.initializer;
}
