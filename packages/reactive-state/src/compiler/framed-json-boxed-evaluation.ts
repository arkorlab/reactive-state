import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
  type Node,
  type PropertyName,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { frameBindingOf } from './framed-bindings.ts';
import { jsonConstantDeclaration } from './framed-json-keys.ts';
import { framedQuietPrimitive, framedQuietSource } from './framed-native-evaluation.ts';
import { framedPrefixSameOwner, framedQuietOwnerPrefix } from './framed-native-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Primitive-wrapper normalization retains only closed creation and native conversion boundaries. */

const CONSTRUCTIONS = new Set([
  ...STANDARD_ERRORS,
  'AggregateError',
  'Boolean',
  'DOMException',
  'Number',
  'String',
]);
const NATIVES = new Set([
  ...CONSTRUCTIONS,
  'JSON.stringify',
  'Object.assign',
  'Object.defineProperties',
  'Object.defineProperty',
  'Reflect.apply',
]);
const CONVERSIONS = new Set(['__proto__', 'toString', 'valueOf']);
const SLOTS = { gap: 2, replacer: 1 } as const;

/** Original wrapper arguments are evaluated before primitive JSON normalization begins. */
export function jsonBoxedArguments(
  call: CallExpression,
  args: readonly Expression[],
  operations: ReadonlySet<CallExpression>,
): boolean {
  const replacer = args[SLOTS.replacer];
  const gap = args[SLOTS.gap];
  if (
    replacer === undefined ||
    (gap !== undefined && !framedQuietPrimitive(gap)) ||
    !primitivePropertyList(replacer)
  )
    return false;
  return jsonBoxedCreation(call.arguments, operations, call, false);
}

/** A primitive-only property list executes no boxed-key or application conversion first. */
function primitivePropertyList(expression: Expression): boolean {
  const value = framedQuietSource(expression);
  return (
    value !== undefined &&
    isArrayLiteralExpression(value) &&
    value.elements.every(
      (entry) => isOmittedExpression(unwrapped(entry)) || framedQuietPrimitive(entry),
    )
  );
}

/** Completed unknown work, including work before the fresh wrapper's birth, stays opaque. */
export function jsonBoxedPrefix(
  call: CallExpression,
  operations: ReadonlySet<CallExpression>,
): boolean {
  return framedQuietOwnerPrefix(call, {
    reached: true,
    primitive: framedQuietPrimitive,
    value: (value) => framedNativeConstructor(value, NATIVES),
    call: (node) => operations.has(node),
    construct: (node) => {
      return (
        framedNativeConstructor(node.expression, CONSTRUCTIONS) &&
        (node.arguments ?? []).every((argument) => framedQuietPrimitive(argument))
      );
    },
  });
}

/** A copied field's value is evaluated but is never serialized after primitive unboxing. */
export function jsonBoxedFields(expression: Expression, consumer: CallExpression): boolean {
  const value = framedQuietSource(expression);
  return (
    value !== undefined &&
    (framedQuietPrimitive(value) ||
      (isObjectLiteralExpression(value) && jsonBoxedCreation([value], new Set(), consumer, true)))
  );
}

/** A finite syntax work list separates ignored data identities from values JSON may serialize. */
export function jsonBoxedCreation(
  expressions: readonly Expression[],
  operations: ReadonlySet<CallExpression>,
  consumer: CallExpression,
  data: boolean,
): boolean {
  const pending = [...expressions];
  const seen = new Set<Node>();
  for (let expression = pending.pop(); expression !== undefined; expression = pending.pop()) {
    const value = unwrapped(expression);
    if (seen.has(value)) continue;
    seen.add(value);
    if (!quietCreation(value, { pending, operations, consumer, data })) return false;
  }
  return true;
}

interface CreationContext {
  readonly pending: Expression[];
  readonly operations: ReadonlySet<CallExpression>;
  readonly consumer: CallExpression;
  readonly data: boolean;
}

/** Only verified native operations bypass traversal of their separately qualified creation inputs. */
function quietCreation(value: Expression, context: CreationContext): boolean {
  if (framedQuietPrimitive(value) || isOmittedExpression(value)) return true;
  if (isCallExpression(value) && context.operations.has(value)) return true;
  if (framedNativeConstructor(value, NATIVES)) return true;
  if (isIdentifier(value)) return quietBinding(value, context);
  if (isNewExpression(value))
    return (
      framedNativeConstructor(value.expression, CONSTRUCTIONS) &&
      (value.arguments ?? []).every((argument) => framedQuietPrimitive(argument))
    );
  if (isArrayLiteralExpression(value)) {
    context.pending.push(...value.elements);
    return true;
  }
  if (isObjectLiteralExpression(value)) return quietFields(value.properties, context);
  return context.data && quietCallable(value);
}

/** Same-owner bindings are pure reads; serialized containers retain only whole completed constants. */
function quietBinding(value: Expression, context: CreationContext): boolean {
  if (!isIdentifier(value)) return false;
  const selected = frameBindingOf(value);
  if (
    selected === undefined ||
    selected.keys.length > 0 ||
    !framedPrefixSameOwner(selected.binding, context.consumer)
  )
    return false;
  if (context.data) return true;
  const declared = jsonConstantDeclaration(value);
  if (declared?.initializer === undefined || declared.end > value.pos) return false;
  context.pending.push(declared.initializer);
  return true;
}

/** Data fields have literal own names; getters, spreads and conversion replacements stay opaque. */
function quietFields(fields: readonly Node[], context: CreationContext): boolean {
  for (const field of fields) {
    if (isPropertyAssignment(field) && quietName(field.name))
      context.pending.push(field.initializer);
    else if (
      isShorthandPropertyAssignment(field) &&
      isIdentifier(field.name) &&
      quietName(field.name)
    )
      context.pending.push(field.name);
    else if (
      !context.data ||
      !isMethodDeclaration(field) ||
      !quietName(field.name) ||
      !quietCallable(field)
    )
      return false;
  }
  return true;
}

/** A source field cannot replace a primitive wrapper's own conversion or prototype. */
function quietName(name: PropertyName | undefined): boolean {
  return (
    name !== undefined &&
    (isIdentifier(name) ||
      isStringLiteral(name) ||
      isNoSubstitutionTemplateLiteral(name) ||
      isNumericLiteral(name)) &&
    !CONVERSIONS.has(name.text)
  );
}

/** Deferred function creation is quiet; any invoked toJSON must still pass its existing source proof. */
function quietCallable(value: Node): boolean {
  return (
    (isArrowFunction(value) || isFunctionExpression(value) || isMethodDeclaration(value)) &&
    !answersLater(value) &&
    value.parameters.every((parameter) => {
      return (
        isIdentifier(parameter.name) &&
        parameter.initializer === undefined &&
        parameter.dotDotDotToken === undefined
      );
    })
  );
}
