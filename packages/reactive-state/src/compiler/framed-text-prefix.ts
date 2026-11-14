import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isObjectLiteralExpression,
  type NewExpression,
} from 'typescript/ast';

import {
  framedQuietData,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { type FramedOwnerPrefixProof, framedQuietOwnerPrefix } from './framed-native-prefix.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** New text origins retain only quiet earlier native construction and primitive JSON parsing. */

const JSON_PARSE = new Set(['JSON.parse']);
const FIELDS = new Set(['JSON.parse', 'Object.keys', 'Reflect.ownKeys']);

/** Source-local application calls and opaque member evaluations remain barriers before native text conversion. */
export function framedQuietTextPrefix(
  consumer: Expression,
  natives: ReadonlySet<string>,
  priorCall?: FramedOwnerPrefixProof['call'],
  priorFields?: ReadonlySet<Expression>,
): boolean {
  return framedQuietOwnerPrefix(consumer, {
    primitive: framedQuietPrimitive,
    value: (value) => {
      return (
        framedNativeConstructor(value, natives) ||
        framedNativeConstructor(value, FIELDS) ||
        priorFields?.has(value) === true
      );
    },
    call: (call) => quietJsonParse(call) || priorCall?.(call) === true,
    construct: (node) => quietConstruction(node, natives),
    spread: quietLiteralSpread,
  });
}

/** Literal primitive JSON input and no reviver cannot invoke a supplied conversion or callback. */
function quietJsonParse(node: CallExpression): boolean {
  return (
    framedNativeConstructor(node.expression, JSON_PARSE) &&
    node.arguments.length <= 1 &&
    node.arguments.every((argument) => framedQuietPrimitive(argument))
  );
}

/** A closed native construction adds no application-owned argument conversion. */
function quietConstruction(node: NewExpression, natives: ReadonlySet<string>): boolean {
  return (
    framedNativeConstructor(node.expression, natives) &&
    (node.arguments ?? []).every((argument) => framedQuietData(argument))
  );
}

/** Literal spread sources retain only closed data fields and finite native array iteration. */
function quietLiteralSpread(expression: Expression): boolean {
  const value = framedQuietSource(expression);
  return (
    value !== undefined &&
    (isArrayLiteralExpression(value) || isObjectLiteralExpression(value)) &&
    framedQuietData(value)
  );
}
