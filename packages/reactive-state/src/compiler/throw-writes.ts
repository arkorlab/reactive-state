import {
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSetAccessorDeclaration,
  isStringLiteral,
  isVoidExpression,
  type Node,
  type ObjectLiteralExpression,
  type SetAccessorDeclaration,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { arrayLengthThrows } from './throw-array-lengths.ts';
import { globalCalleePath } from './throw-callees.ts';
import { type Property, writtenDescriptors } from './throw-definitions.ts';
import { primitiveWriteThrows } from './throw-primitive-writes.ts';
import { writtenOf } from './throw-shapes.ts';
import { includesApplication } from './written-evaluation.ts';
import { writtenBy } from './written.ts';

/** Strict property writes and the selected own setter they invoke, before a discarded result. */

type Accessor = Answering | SetAccessorDeclaration;

interface Write {
  readonly receiver: Expression;
  readonly key: string;
  readonly property: Property | undefined;
  readonly extensible: boolean;
}

const TARGET_CALLS: ReadonlySet<string> = new Set([
  'Object.defineProperties',
  'Object.defineProperty',
  'Object.freeze',
  'Object.preventExtensions',
  'Object.seal',
]);

/** Whether a strict assignment necessarily cannot update its selected property. */
export function lockedWriteThrows(node: Node, resolve: Resolve | undefined): boolean {
  if (arrayLengthThrows(node, resolve) || primitiveWriteThrows(node, resolve)) {
    return true;
  }
  const write = selectedWrite(node, resolve);
  if (write === undefined) {
    return false;
  }
  const { property, receiver, key, extensible } = write;
  if (property === undefined) {
    if (
      plainAssignment(node) &&
      !rightCanChange(node) &&
      inheritedGetterBlocks(receiver, key, resolve)
    ) {
      return true;
    }
    return (
      !extensible &&
      key !== '__proto__' &&
      plainPrototype(receiver, resolve) &&
      plainAssignment(node) &&
      !rightCanChange(node)
    );
  }
  const setter = property.values.get('set');
  const blocked =
    property.kind === 'data'
      ? !property.writable
      : setter !== undefined && setter.value === undefined;
  return (
    blocked &&
    selectsWrite(node, property, resolve) &&
    (!property.configurable || (!rightCanChange(node) && safeRead(node, property, resolve)))
  );
}

/** The final own setter invoked by this write, without assuming getters or later evaluation stay pure. */
export function assignmentSetter(node: Node, resolve: Resolve | undefined): Accessor | undefined {
  const write = selectedWrite(node, resolve);
  const property = write?.property;
  if (
    property?.kind !== 'accessor' ||
    rightCanChange(node) ||
    !safeRead(node, property, resolve) ||
    !selectsWrite(node, property, resolve)
  ) {
    return undefined;
  }
  return accessor(property, 'set');
}

/** The source-proven descriptor of a directly selected assignment or increment target. */
function selectedWrite(node: Node, resolve: Resolve | undefined): Write | undefined {
  if (
    !isBinaryExpression(node) &&
    !isPrefixUnaryExpression(node) &&
    !isPostfixUnaryExpression(node)
  ) {
    return undefined;
  }
  const target = writtenBy(node);
  const member = target === undefined ? undefined : unwrapped(target as Expression);
  if (
    member === undefined ||
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member))
  ) {
    return undefined;
  }
  const named = isElementAccessExpression(member)
    ? constantValue(member.argumentExpression, resolve)
    : member.name.text;
  const snapshot = writtenDescriptors(member.expression, resolve);
  if (named === undefined || snapshot === undefined) {
    return undefined;
  }
  const key = String(named);
  return {
    extensible: snapshot.extensible,
    key,
    property: snapshot.properties.get(key),
    receiver: member.expression,
  };
}

/** A simple assignment reads no previous value before calling [[Set]]. */
function plainAssignment(node: Node): boolean {
  return isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken;
}

/** The right side may replace a configurable descriptor before the assignment writes it. */
function rightCanChange(node: Node): boolean {
  return isBinaryExpression(node) && includesApplication(node.right);
}

/** Compound writes only keep the descriptor proof when reading and coercing its old value is harmless. */
function safeRead(node: Node, property: Property, resolve: Resolve | undefined): boolean {
  if (plainAssignment(node)) {
    return true;
  }
  if (property.kind === 'data') {
    const known = property.values.get('value');
    return known !== undefined && (known.value === null || typeof known.value !== 'object');
  }
  return getterValue(property, resolve) !== undefined;
}

/** Logical assignments invoke [[Set]] only when their written previous value selects the right side. */
function selectsWrite(node: Node, property: Property, resolve: Resolve | undefined): boolean {
  if (!isBinaryExpression(node)) {
    return true;
  }
  const operator = node.operatorToken.kind;
  const logical = [
    SyntaxKind.AmpersandAmpersandEqualsToken,
    SyntaxKind.BarBarEqualsToken,
    SyntaxKind.QuestionQuestionEqualsToken,
  ];
  if (!logical.includes(operator)) {
    return true;
  }
  const known = previousValue(property, resolve);
  if (known === undefined) {
    return false;
  }
  if (operator === SyntaxKind.QuestionQuestionEqualsToken) {
    return known.value === null || known.value === undefined;
  }
  const truthy = Boolean(known.value);
  return operator === SyntaxKind.BarBarEqualsToken ? !truthy : truthy;
}

/** A literal previous value used only to decide whether a logical assignment performs a write. */
function previousValue(
  property: Property,
  resolve: Resolve | undefined,
): { readonly value: unknown } | undefined {
  if (property.kind === 'accessor') {
    return getterValue(property, resolve);
  }
  const known = property.values.get('value');
  return known?.source === undefined || literalScalar(known.source, resolve) ? known : undefined;
}

/** An absent getter reads undefined; a sole literal return cannot replace the property being written. */
function getterValue(
  property: Property,
  resolve: Resolve | undefined,
): { readonly value: unknown } | undefined {
  const getter = property.values.get('get');
  if (getter !== undefined && getter.value === undefined) {
    return { value: undefined };
  }
  const expression = getterExpression(accessor(property, 'get'));
  if (expression === undefined || !literalScalar(expression, resolve)) {
    return undefined;
  }
  const value = writtenOf(expression, resolve);
  const constant = constantValue(value, resolve);
  if (constant !== undefined) {
    return { value: constant };
  }
  if (value.kind === SyntaxKind.NullKeyword) {
    return { value: null };
  }
  if ([SyntaxKind.FalseKeyword, SyntaxKind.TrueKeyword].includes(value.kind)) {
    return { value: value.kind === SyntaxKind.TrueKeyword };
  }
  return { value: undefined };
}

/** A sole return or expression body, without other getter statements. */
function getterExpression(fn: Accessor | undefined): Expression | undefined {
  const body = fn?.body;
  if (body === undefined || !isBlock(body)) {
    return body;
  }
  const [statement] = body.statements;
  return statement !== undefined && body.statements.length === 1 && isReturnStatement(statement)
    ? statement.expression
    : undefined;
}

/** A written primitive literal has no getter or custom coercion that can change a descriptor. */
function literalScalar(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  return (
    isNumericLiteral(value) ||
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    (isVoidExpression(value) && !includesApplication(value.expression)) ||
    globalCalleePath(value, resolve)?.join('.') === 'undefined' ||
    [SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword, SyntaxKind.TrueKeyword].includes(value.kind)
  );
}

/** A setter or getter retained in a source descriptor, rather than an unknown callable value. */
function accessor(property: Property, field: 'get' | 'set'): Accessor | undefined {
  const value = property.values.get(field)?.value;
  return typeof value === 'object' &&
    value !== null &&
    (isAnswering(value) || isSetAccessorDeclaration(value))
    ? value
    : undefined;
}

/** A source-written prototype getter with no setter, before any own property shadows it. */
function inheritedGetterBlocks(
  receiver: Expression,
  key: string,
  resolve: Resolve | undefined,
): boolean {
  const seen = new Set<Expression>();
  let prototype = prototypeOf(receiver, resolve);
  while (prototype !== undefined && !seen.has(prototype)) {
    seen.add(prototype);
    const snapshot = writtenDescriptors(prototype, resolve);
    if (snapshot === undefined) {
      return false;
    }
    const property = snapshot.properties.get(key);
    if (property !== undefined) {
      const setter = property.values.get('set');
      return property.kind === 'accessor' && setter !== undefined && setter.value === undefined;
    }
    prototype = prototypeOf(prototype, resolve);
  }
  return false;
}

/** A literal or Object.create prototype, followed through single-argument locking operations. */
function prototypeOf(node: Expression, resolve: Resolve | undefined): Expression | undefined {
  const seen = new Set<Expression>();
  let value = writtenOf(node, resolve);
  while (isCallExpression(value) && !seen.has(value)) {
    seen.add(value);
    const [first, ...rest] = value.arguments;
    if (first === undefined) {
      return undefined;
    }
    const path = globalCalleePath(value.expression, resolve)?.join('.') ?? '';
    if (path === 'Object.create') {
      return rest.some((argument) => includesApplication(argument)) ? undefined : first;
    }
    if (!TARGET_CALLS.has(path) || rest.length > 0) {
      return undefined;
    }
    value = writtenOf(first, resolve);
  }
  return isObjectLiteralExpression(value) && !includesApplication(value)
    ? literalPrototype(value)
    : undefined;
}

/** The special non-computed __proto__ entry; a computed property of that name is ordinary data. */
function literalPrototype(value: ObjectLiteralExpression): Expression | undefined {
  for (const property of value.properties) {
    if (!isPropertyAssignment(property) || isComputedPropertyName(property.name)) {
      continue;
    }
    const key = isIdentifier(property.name) ? property.name.text : constantValue(property.name);
    if (key === '__proto__') {
      return property.initializer;
    }
  }
  return undefined;
}

/** No source-written prototype can provide an inherited setter for an otherwise missing property. */
function plainPrototype(node: Expression, resolve: Resolve | undefined): boolean {
  const seen = new Set<Expression>();
  let value = writtenOf(node, resolve);
  while (!seen.has(value)) {
    seen.add(value);
    if (isArrayLiteralExpression(value)) {
      return true;
    }
    if (isObjectLiteralExpression(value)) {
      return value.properties.every((property) => {
        if (!isPropertyAssignment(property) || isComputedPropertyName(property.name)) {
          return true;
        }
        const key = isIdentifier(property.name) ? property.name.text : constantValue(property.name);
        return key !== '__proto__' || ordinaryPrototype(property.initializer, resolve);
      });
    }
    if (!isCallExpression(value) || value.arguments[0] === undefined) {
      return false;
    }
    const path = globalCalleePath(value.expression, resolve)?.join('.') ?? '';
    if (path === 'Object.create') {
      return ordinaryPrototype(value.arguments[0], resolve);
    }
    if (!TARGET_CALLS.has(path)) {
      return false;
    }
    value = writtenOf(value.arguments[0], resolve);
  }
  return false;
}

/** Null and Object.prototype have no application-defined inherited assignment hooks. */
function ordinaryPrototype(node: Expression, resolve: Resolve | undefined): boolean {
  const value = writtenOf(node, resolve);
  return (
    value.kind === SyntaxKind.NullKeyword ||
    globalCalleePath(value, resolve)?.join('.') === 'Object.prototype'
  );
}
