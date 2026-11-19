import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isArrowFunction,
  isFunctionExpression,
  isExportAssignment,
  isObjectBindingPattern,
  isIdentifier,
  isElementAccessExpression,
  isExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  type Node,
  type ParameterDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { framedAccessorQuietValue } from './framed-accessor-descriptors.ts';
import { defaultArrayComparison } from './framed-array-sorting.ts';
import { frameMemberName } from './framed-bindings.ts';
import { unchangedNativeBind } from './framed-native-bind.ts';
import { framedQuietData, framedQuietPrimitive } from './framed-native-evaluation.ts';
import { framedQuietOwnerPrefix } from './framed-native-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { targetsOf } from './kept.ts';
import { isTypeOnly } from './scope.ts';
import { writtenBy } from './written.ts';

/** Default comparison may execute conversion hooks while a native copy sorts original payloads. */

const CONVERSION_TARGETS = new Set([
  'Array',
  'Array.prototype',
  'Object',
  'Object.prototype',
  'Symbol',
]);
const CONVERSION_KEYS = new Set(['join', 'toPrimitive', 'toString', 'valueOf']);
const DEFINERS = new Set(['Object.defineProperty', 'Reflect.defineProperty']);
const DEFINER_GLOBALS = new Set(['Object', 'Reflect']);
const DEFINER_FIELDS = new Set(['Array', 'Array.prototype', 'Object', 'Reflect', ...DEFINERS]);
const DEFINITION = { slots: 3 } as const;

/** Quiet literal data needs its source-written native conversion methods to remain unchanged. */
export function middlewareDefaultArrayMutation(
  call: CallExpression,
  receiver: Expression,
  given: readonly Expression[] | undefined,
  source: Expression | undefined,
): boolean {
  return (
    defaultArrayComparison(receiver, call, given ?? []) &&
    (source === undefined || !framedQuietData(source) || replacedConversion(call))
  );
}

/** Explicit conversion replacements and unknown prototype writes remove the quiet-data proof. */
function replacedConversion(call: CallExpression): boolean {
  const pending: Node[] = [call.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const write = writtenBy(node);
    if (
      write !== undefined &&
      targetsOf(write).some((target) => conversionTarget(target)) &&
      !definesOtherField(node)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whole native targets and their conversion fields can replace implicit text conversion. */
function conversionTarget(target: Node): boolean {
  if (!isExpression(target)) return false;
  const value = unwrapped(target);
  if (framedNativeConstructor(value, CONVERSION_TARGETS)) return true;
  if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return false;
  const key = frameMemberName(value);
  return (
    (key === undefined || CONVERSION_KEYS.has(key)) &&
    framedNativeConstructor(value.expression, CONVERSION_TARGETS)
  );
}

/** A quiet direct definition of a fixed unrelated data field does not replace conversion. */
function definesOtherField(node: Node): boolean {
  if (!isCallExpression(node) || node.arguments.length !== DEFINITION.slots) return false;
  if (!framedNativeConstructor(node.expression, DEFINERS)) return false;
  const [, key, descriptor] = node.arguments;
  const property = key === undefined ? undefined : unwrapped(key);
  return (
    property !== undefined &&
    isStringLiteral(property) &&
    !CONVERSION_KEYS.has(property.text) &&
    descriptor !== undefined &&
    framedAccessorQuietValue(descriptor) &&
    unchangedNativeBind(node.expression, node, DEFINER_GLOBALS) &&
    quietDefinitionPrefix(node)
  );
}

/** Only the plain params binding of the default middleware owner adds no parameter work. */
function quietMiddlewareParameter(parameter: ParameterDeclaration): boolean {
  const owner = parameter.parent;
  if (!isArrowFunction(owner) && !isFunctionExpression(owner)) return false;
  const exported = useOf(owner).parent;
  if (
    !isExportAssignment(exported) ||
    parameter.initializer !== undefined ||
    parameter.dotDotDotToken !== undefined ||
    !isObjectBindingPattern(parameter.name) ||
    owner.parameters[0] !== parameter
  )
    return false;
  return parameter.name.elements.every((element) => {
    return (
      element.dotDotDotToken === undefined &&
      element.initializer === undefined &&
      element.name !== undefined &&
      isIdentifier(element.name) &&
      (element.propertyName === undefined
        ? element.name.text === 'params'
        : isIdentifier(element.propertyName) && element.propertyName.text === 'params')
    );
  });
}

/** Earlier application calls, mutable native namespace reads and parameter work keep the coarse guard. */
export function quietDefinitionPrefix(call: CallExpression): boolean {
  return framedQuietOwnerPrefix(call, {
    parameter: quietMiddlewareParameter,
    primitive: framedQuietPrimitive,
    value: (value) => framedNativeConstructor(value, DEFINER_FIELDS),
  });
}
