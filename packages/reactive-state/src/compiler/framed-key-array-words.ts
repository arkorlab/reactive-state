import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isNewExpression,
  isNonNullExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { globalPathOf } from './code-globals.ts';
import { framedArrayString } from './framed-arrays.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import {
  framedQuietArrayWords,
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';

/** Runtime array keys retain Error words only when the complete native conversion stays quiet. */

const KEYS = new Set([
  'JSON.parse',
  'Object.defineProperty',
  'Object.fromEntries',
  'Object.getOwnPropertyDescriptor',
  'Object.hasOwn',
  'Object.keys',
  'Object.prototype',
  'Object.prototype.__defineGetter__',
  'Object.prototype.__defineSetter__',
  'Object.prototype.__lookupGetter__',
  'Object.prototype.__lookupSetter__',
  'Object.prototype.hasOwnProperty',
  'Object.prototype.propertyIsEnumerable',
  'Reflect.apply',
  'Reflect.defineProperty',
  'Reflect.deleteProperty',
  'Reflect.get',
  'Reflect.getOwnPropertyDescriptor',
  'Reflect.has',
  'Reflect.ownKeys',
  'Reflect.set',
]);
const NATIVES = new Set(KEYS);
for (const key of KEYS) {
  NATIVES.add(`${key}.apply`);
  NATIVES.add(`${key}.call`);
}

interface KeyWords {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** Native array toString/join overrides and source-written Error words retain their prior meaning. */
export function framedKeyArrayWords(key: Expression, consumer: Node, words: KeyWords): boolean {
  if (!evaluatedOptionalKey(consumer)) return false;
  const error = (value: Expression, keys?: readonly string[]) => {
    return (
      words.error(value, keys) &&
      framedOriginCoowned(value, key) &&
      framedNativeErrorInput(value, key)
    );
  };
  return (
    framedQuietArrayWords(key, error, key) &&
    framedArrayString(key, { error, typed: words.typed }, consumer) &&
    quietKeyEvaluation(consumer) &&
    framedQuietTextPrefix(key, NATIVES)
  );
}

/** Only a continuous raw optional chain can skip the selected key; parentheses end that chain. */
function evaluatedOptionalKey(node: Node): boolean {
  let each = node;
  while (
    isPropertyAccessExpression(each) ||
    isElementAccessExpression(each) ||
    isCallExpression(each) ||
    isNonNullExpression(each)
  ) {
    if (
      !isNonNullExpression(each) &&
      each.questionDotToken !== undefined &&
      !knownNonNullish(each.expression)
    )
      return false;
    each = each.expression;
  }
  return true;
}

/** Fresh literal values and whole unchanged aliases establish a nonnull optional receiver. */
function knownNonNullish(expression: Expression): boolean {
  const value = framedQuietSource(expression);
  if (value === undefined) return false;
  if (
    isObjectLiteralExpression(value) ||
    isArrayLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isNewExpression(value)
  )
    return true;
  return (
    framedNativeConstructor(value, NATIVES) ||
    (framedQuietPrimitive(value) &&
      value.kind !== SyntaxKind.NullKeyword &&
      globalPathOf(value)?.join('.') !== 'undefined')
  );
}

/** A key-taking call evaluates every argument first; in evaluates its right operand before conversion. */
function quietKeyEvaluation(node: Node): boolean {
  if (isCallExpression(node)) return framedQuietInputs(node.arguments, NATIVES);
  return (
    !isBinaryExpression(node) ||
    node.operatorToken.kind !== SyntaxKind.InKeyword ||
    framedQuietInputs([node.right], NATIVES)
  );
}
