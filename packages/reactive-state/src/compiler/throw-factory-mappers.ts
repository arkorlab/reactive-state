import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isMethodDeclaration,
  isNewExpression,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isPropertyAccessExpression,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTaggedTemplateExpression,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { earlierExpressionEffect } from './callback-evaluation.ts';
import { calleeUncertain } from './callee-evaluation.ts';
import { metadataInitializer } from './input-callees.ts';
import { rootOf, targetsOf } from './kept.ts';
import type { Resolve } from './numbers.ts';
import { callbackResultThrows } from './throw-callback-results.ts';
import { globalCalleePath } from './throw-callees.ts';
import { eagerClassOf } from './throw-classes.ts';
import { conversionRunsCode } from './throw-coercions.ts';
import { enumerationKey } from './throw-keys.ts';
import { isTypedKind, primitiveOf, writtenOf } from './throw-shapes.ts';
import { writtenBy } from './written.ts';

/** A native factory's mapper, where its written source guarantees at least one invocation. */
export function factoryMapper(node: Node, resolve: Resolve | undefined): Node | undefined {
  if (
    !isCallExpression(node) ||
    node.arguments.some((each) => isSpreadElement(each)) ||
    earlierExpressionEffect(node)
  ) {
    return undefined;
  }
  const follow: Resolve = (name) => resolve?.(name) ?? metadataInitializer(name);
  const path = globalCalleePath(node.expression, follow) ?? [];
  const [kind = '', method] = path;
  const [source, mapper, ...later] = node.arguments;
  if (
    method !== 'from' ||
    source === undefined ||
    mapper === undefined ||
    path.length !== 2 ||
    (kind !== 'Array' && !isTypedKind(kind)) ||
    !quietArgument(mapper) ||
    later.some((each) => !quietArgument(each))
  ) {
    return undefined;
  }
  const value = writtenOf(source, follow);
  if (
    calleeUncertain(value, node) ||
    writtenBefore(value, node, follow) ||
    sourceCreationEffect(value, follow) ||
    !nonemptySource(value, follow)
  ) {
    return undefined;
  }
  return writtenOf(mapper, follow);
}

/** A necessarily invoked typed factory mapper whose simple result cannot become an element. */
export function factoryResultThrows(node: Node, resolve: Resolve | undefined): boolean {
  const mapper = factoryMapper(node, resolve);
  if (mapper === undefined || !isAnswering(mapper) || !isCallExpression(node)) {
    return false;
  }
  const follow: Resolve = (name) => resolve?.(name) ?? metadataInitializer(name);
  const [kind] = globalCalleePath(node.expression, follow) ?? [];
  if (kind === undefined || !isTypedKind(kind)) {
    return false;
  }
  return callbackResultThrows(
    mapper,
    kind === 'BigInt64Array' || kind === 'BigUint64Array' ? 'bigint' : 'number',
    resolve,
  );
}

/** Direct and destructuring writes before the call invalidate an aliased source's initial length. */
function writtenBefore(value: Expression, at: Expression, resolve: Resolve): boolean {
  let found = false;
  const visit = (node: Node): void => {
    if (found || node.end <= value.end || node.pos >= at.pos) {
      return;
    }
    const written = writtenBy(node);
    found = (written === undefined ? [] : targetsOf(written)).some((target) => {
      const root = rootOf(target);
      return root !== undefined && writtenOf(root, resolve) === value;
    });
    if (!found) {
      node.forEachChild(visit);
    }
  };
  visit(value.getSourceFile());
  return found;
}

/** Function creation and primitive/name reads cannot empty the previously evaluated source. */
function quietArgument(node: Expression): boolean {
  const value = unwrapped(node);
  return (
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isIdentifier(value) ||
    isNumericLiteral(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    value.kind === SyntaxKind.NullKeyword ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword
  );
}

/** Array iteration includes holes; a literal string supplies at least one code point when nonempty. */
function nonemptySource(value: Expression, resolve: Resolve | undefined): boolean {
  if (isArrayLiteralExpression(value)) {
    return value.elements.length > 0 && !value.elements.some((each) => isSpreadElement(each));
  }
  if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) {
    return value.text.length > 0;
  }
  return isObjectLiteralExpression(value) && nonemptyArrayLike(value, resolve);
}

/** A plain array-like's last own length data entry, without an iterator or an uncertain prototype. */
function nonemptyArrayLike(object: ObjectLiteralExpression, resolve: Resolve | undefined): boolean {
  let length: Expression | undefined;
  let firstGetter = false;
  for (const property of object.properties) {
    if (isSpreadAssignment(property)) {
      return false;
    }
    const key = enumerationKey(property.name, resolve);
    if (['__proto__', null, undefined].includes(key)) {
      return false;
    }
    if (key === 'length') {
      length = isPropertyAssignment(property) ? property.initializer : undefined;
    } else if (key === '0' && !isSetAccessorDeclaration(property)) {
      firstGetter = isGetAccessorDeclaration(property);
    }
  }
  const value = length === undefined ? undefined : writtenOf(length, resolve);
  return !firstGetter && value !== undefined && isNumericLiteral(value) && Number(value.text) >= 1;
}

/** Creating a source may change what the already written mapper will do before it is invoked. */
function sourceCreationEffect(node: Expression, resolve: Resolve | undefined): boolean {
  let effect = false;
  const visit = (each: Node): void => {
    if (effect) {
      return;
    }
    const children = creationChildren(each);
    if (children !== undefined) {
      for (const child of children) {
        visit(child);
      }
      return;
    }
    effect = creatingEffect(each, resolve);
    if (!effect) {
      each.forEachChild(visit);
    }
  };
  visit(node);
  return effect;
}

/** Only computed names and class-definition work execute while a function/class value is created. */
function creationChildren(node: Node): readonly Node[] | undefined {
  if (isArrowFunction(node) || isFunctionExpression(node) || isFunctionDeclaration(node)) {
    return [];
  }
  if (
    isMethodDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)
  ) {
    return isComputedPropertyName(node.name) ? [node.name] : [];
  }
  const eager = eagerClassOf(node);
  return eager === undefined ? undefined : [...eager.keys, ...eager.expressions, ...eager.blocks];
}

/** Reads, calls, writes and unproven key coercions may execute application code during creation. */
function creatingEffect(node: Node, resolve: Resolve | undefined): boolean {
  if (isComputedPropertyName(node)) {
    return primitiveOf(writtenOf(node.expression, resolve), resolve) === undefined;
  }
  return (
    isCallExpression(node) ||
    isNewExpression(node) ||
    isPropertyAccessExpression(node) ||
    isElementAccessExpression(node) ||
    isTaggedTemplateExpression(node) ||
    conversionRunsCode(node) ||
    writtenBy(node) !== undefined
  );
}
