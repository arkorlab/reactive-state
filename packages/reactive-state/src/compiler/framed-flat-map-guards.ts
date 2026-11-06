import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrayTypeNode,
  isArrowFunction,
  isComputedPropertyName,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isTupleTypeNode,
  isTypeOperatorNode,
  isTypeReferenceNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type TypeNode,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import {
  frameBindingOf,
  frameMemberName,
  frameTypeOf,
  type FrameBinding,
} from './framed-bindings.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { localTypeBinding } from './local-type-aliases.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Added flatMap array returns keep their original quiet evaluation and selected-source ownership. */

const ARRAYS = new Set(['Array', 'ReadonlyArray']);
const NATIVE_FIELDS = new Set([
  'Array.prototype.flatMap',
  'Array.prototype.flatMap.apply',
  'Array.prototype.flatMap.call',
  'Reflect.apply',
]);
const OBSERVED = new Set(['columnNumber', 'fileName', 'lineNumber', 'message', 'name', 'stack']);
const INDEX = /^(?:0|[1-9]\d*)$/u;

/** Only immediately observed new projections cross a quiet native call and quiet mapper return. */
export function quietFlatMapReturn(
  returned: Expression,
  call: CallExpression,
  receiver: Expression,
): boolean {
  return (
    immediateObservation(call) &&
    framedOriginPrefix(call) &&
    framedOriginPrefix(returned) &&
    quietInputs([receiver, ...call.arguments, returned]) &&
    quietTarget(call.expression)
  );
}

/** A mapper-local whole const forwards its original input after the callback prefix was proved quiet. */
export function flatMapOwnedSource(
  source: Expression,
  returned: Expression,
  call: CallExpression,
): Expression | undefined {
  const value = callbackSource(source, returned);
  return value !== undefined && framedOriginCoowned(value, call) ? value : undefined;
}

/**
 * A nonliteral return adds only the native array category explicitly written on its original binding:
 * `Array` or `ReadonlyArray` by a name no type declared or imported where it is written takes.
 */
export function flatMapWrittenArray(source: Expression): boolean {
  const selected = frameTypeOf(source);
  if (selected === undefined || selected.keys.length > 0) return false;
  let type: TypeNode = selected.type;
  while (isTypeOperatorNode(type) && type.operator === SyntaxKind.ReadonlyKeyword) type = type.type;
  return (
    isArrayTypeNode(type) ||
    isTupleTypeNode(type) ||
    (isTypeReferenceNode(type) &&
      isIdentifier(type.typeName) &&
      ARRAYS.has(type.typeName.text) &&
      localTypeBinding(type.typeName) === undefined)
  );
}

/**
 * A direct selected element, or an element of it nested by written indexes, is consumed before any
 * later saved-result or computed-member mutation.
 */
function immediateObservation(call: CallExpression): boolean {
  const { at, parent } = useOf(call);
  if (
    !isElementAccessExpression(parent) ||
    parent.expression !== at ||
    parent.questionDotToken !== undefined ||
    framedMapKey(parent.argumentExpression) === undefined
  )
    return false;
  let selected = useOf(parent);
  while (nestedIndex(selected)) selected = useOf(selected.parent);
  if (
    (!isPropertyAccessExpression(selected.parent) && !isElementAccessExpression(selected.parent)) ||
    selected.parent.expression !== selected.at
  )
    return false;
  const name = frameMemberName(selected.parent);
  return (
    name !== undefined &&
    OBSERVED.has(name) &&
    (!isElementAccessExpression(selected.parent) ||
      framedMapKey(selected.parent.argumentExpression) !== undefined)
  );
}

/** A written index read of the selected element, `[0]` of `call[0][0]`, keeps its consumption direct. */
function nestedIndex(use: ReturnType<typeof useOf>): boolean {
  const { at, parent } = use;
  return (
    isElementAccessExpression(parent) &&
    parent.expression === at &&
    parent.questionDotToken === undefined &&
    INDEX.test(frameMemberName(parent) ?? '')
  );
}

/** Known source method keys cannot execute application work while the native callee is selected. */
function quietTarget(expression: Expression): boolean {
  let value = unwrapped(expression);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    if (isElementAccessExpression(value) && framedMapKey(value.argumentExpression) === undefined)
      return false;
    value = unwrapped(value.expression);
  }
  return true;
}

/** Closed literal operands and deferred callable creation preserve every evaluated ignored tail. */
function quietInputs(inputs: readonly Expression[]): boolean {
  const pending = [...inputs];
  const seen = new Set<Expression>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapped(next);
    if (seen.has(value)) continue;
    seen.add(value);
    if (quietAtom(value)) continue;
    const children = quietChildren(value);
    if (children === undefined) return false;
    pending.push(...children);
  }
  return true;
}

/** Primitive reads and deferred callable creation add no completed application work. */
function quietAtom(value: Expression): boolean {
  return (
    isIdentifier(value) ||
    isOmittedExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    framedMapKey(value) !== undefined ||
    framedNativeConstructor(value, NATIVE_FIELDS)
  );
}

/** Every supported literal container contributes each original evaluated operand. */
function quietChildren(value: Expression): readonly Expression[] | undefined {
  if (isArrayLiteralExpression(value)) return value.elements;
  if (isSpreadElement(value)) {
    const array = callbackSource(value.expression);
    return array !== undefined && isArrayLiteralExpression(array) ? [array] : undefined;
  }
  if (isObjectLiteralExpression(value)) {
    const pending: Expression[] = [];
    return quietObject(value, pending) ? pending : undefined;
  }
  return quietError(value) ? [] : undefined;
}

/** Own data creation cannot acquire a getter, computed-name effect or unresolved literal spread. */
function quietObject(
  value: Expression & { readonly properties: readonly Node[] },
  pending: Expression[],
): boolean {
  for (const field of value.properties) {
    if (!isPropertyAssignment(field) && !isShorthandPropertyAssignment(field)) return false;
    if (isComputedPropertyName(field.name) && framedMapKey(field.name.expression) === undefined)
      return false;
    if (isPropertyAssignment(field)) pending.push(field.initializer);
    else if (isIdentifier(field.name)) pending.push(field.name);
    else return false;
  }
  return true;
}

/** A fresh native Error with no options and literal primitive words cannot rewrite a carried source. */
function quietError(value: Expression): boolean {
  if (!isNewExpression(value) || !framedNativeConstructor(value.expression, STANDARD_ERRORS))
    return false;
  const args = value.arguments ?? [];
  return (
    args.length === 0 ||
    (args.length === 1 && args[0] !== undefined && framedMapKey(args[0]) !== undefined)
  );
}

/** Whole immutable alias paths stop before a different owner or any unsupported projected binding. */
function callbackSource(source: Expression, returned?: Expression): Expression | undefined {
  let value = unwrapped(source);
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    const binding = selected?.binding;
    if (
      binding === undefined ||
      (returned !== undefined && !framedPrefixSameOwner(binding, returned))
    )
      return value;
    if (
      selected?.keys.length !== 0 ||
      seen.has(binding) ||
      !isVariableDeclaration(binding) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return value;
    seen.add(binding);
    value = unwrapped(binding.initializer);
  }
  return value;
}
