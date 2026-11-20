import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isIdentifier,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { fixedDateText } from './dated.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import {
  framedQuietData,
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import { LOCAL_TIME } from './local-date-inputs.ts';
import { constantValue } from './numbers.ts';
import { renderBorrowedDateParser } from './render-date-parser-invocations.ts';

/** Captured native Date parsing retains a written local text input at its rendered call. */

const PARSERS: ReadonlySet<string> = new Set(['Date.parse']);

/** Whole immutable parser aliases keep their native identity without crossing earlier application work. */
export function renderDateParser(node: Node): string | undefined {
  const borrowed = isCallExpression(node) ? renderBorrowedDateParser(node) : undefined;
  if (borrowed !== undefined) return borrowed;
  if (
    !isCallExpression(node) ||
    !isIdentifier(unwrapped(node.expression)) ||
    !framedNativeConstructor(node.expression, PARSERS) ||
    !framedOriginCoowned(node.expression, node)
  )
    return undefined;
  const given = parserArguments(node);
  if (
    given === undefined ||
    given.some((argument) => !framedQuietPrimitive(argument)) ||
    (node.arguments.some((argument) => isSpreadElement(argument)) &&
      (node.arguments.some((argument) => !parserArgumentOwned(argument, node)) ||
        !framedQuietInputs(node.arguments, PARSERS)))
  )
    return undefined;
  const first = given[0];
  const source = first === undefined ? undefined : framedQuietSource(first);
  return source !== undefined &&
    typeof constantValue(source) === 'string' &&
    !fixedDateText(source) &&
    framedQuietTextPrefix(node, PARSERS)
    ? LOCAL_TIME
    : undefined;
}

/** Unchanged finite literal data retains its original argument across a captured tuple read. */
function parserArgumentOwned(argument: Expression, call: CallExpression): boolean {
  return (
    framedOriginCoowned(argument, call) || (isSpreadElement(argument) && framedQuietData(argument))
  );
}

/** Finite unchanged literal tuple entries keep their original nodes at the parser call. */
function parserArguments(call: CallExpression): readonly Expression[] | undefined {
  const values: Expression[] = [];
  for (const argument of call.arguments) {
    let selected: readonly Expression[] = [argument];
    if (isSpreadElement(argument)) {
      const source = framedQuietSource(argument.expression);
      if (source !== undefined && isArrayLiteralExpression(source)) selected = source.elements;
    }
    const prefix = framedArgumentPrefix(call, selected, Infinity);
    if (prefix.unknown || prefix.alternatives !== undefined) return undefined;
    values.push(...prefix.values);
  }
  return values;
}
