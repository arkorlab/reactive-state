import {
  type Expression,
  isCallExpression,
  isNewExpression,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import { arrayError, framedArrayString } from './framed-arrays.ts';
import { framedBoundErrorMessage } from './framed-bound-error-messages.ts';
import { framedSelectedMembers, framedSelectedValues } from './framed-forwarded-selections.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import { framedQuietArrayWords, framedQuietInputs } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedSubclassMessages } from './framed-subclass-messages.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';

/** Native Error constructors convert their supplied message, with AggregateError's iterable kept separate. */

const AGGREGATE = new Set(['AggregateError']);
const DOM = new Set(['DOMException']);

/**
 * Native constructor message/name arguments can copy engine-chosen words into a fresh error, also
 * through a local subclass whose constructors pass them on (`framedSubclassMessages`).
 */
export function framedErrorMessage(
  node: Node,
  names: ReadonlySet<string>,
  error: (value: Expression, keys?: readonly string[]) => boolean,
  typed: (value: Expression) => boolean,
): boolean {
  if (!isCallExpression(node) && !isNewExpression(node)) return false;
  const bound = framedBoundErrorMessage(node, names, error);
  if (bound !== undefined) return bound;
  const words = { error, typed };
  // A message converts as `String` does: an array's text holds the words of the errors it holds.
  const converted = (value: Expression) => error(value) || framedArrayString(value, words, node);
  const forwarded = framedSubclassMessages(node, names);
  if (forwarded !== undefined) {
    // A selected field converts as a whole argument does, once its written value is resolved.
    return forwarded.some(({ value, keys, any, continued }) => {
      if (continued !== true && keys.length > 0 && error(value, keys)) return true;
      const selected =
        any === true
          ? framedSelectedMembers(value, keys, node)
          : framedSelectedValues(value, keys, node);
      return selected.some((each) => {
        if (each.keys.length > 0) return continued !== true && error(each.value, each.keys);
        const field = each.value;
        if (continued === true && !continuedInput(field, node, names, error)) return false;
        return isSpreadElement(field)
          ? arrayError(field.expression, words, node)
          : converted(field);
      });
    });
  }
  const selected = framedNativeArguments(node, names);
  if (selected === undefined) return false;
  const slots = [framedNativeConstructor(selected.target, AGGREGATE) ? 1 : 0];
  if (framedNativeConstructor(selected.target, DOM)) {
    if (!selected.constructed) return false;
    slots.push(1);
  }
  const args = selected.args;
  if (args === undefined)
    return selected.applied !== undefined && arrayError(selected.applied, words, node);
  const prefix = framedArgumentPrefix(node, args);
  return slots.some((index) => {
    if (!prefix.unknown) {
      const value = prefix.values[index];
      return value !== undefined && converted(value);
    }
    return framedConsumedArguments(node, args, index + 1).some((value) => {
      if (index > 0 && value === prefix.values[0]) return false;
      return isSpreadElement(value) ? arrayError(value.expression, words, node) : converted(value);
    });
  });
}

/** New default-path origins preserve own conversion hooks at the actual native consumer. */
function continuedInput(
  value: Expression,
  consumer: Expression,
  names: ReadonlySet<string>,
  error: (value: Expression) => boolean,
): boolean {
  return (
    quietConstructionInput(consumer, names) &&
    (framedNativeErrorInput(value, consumer) || framedQuietArrayWords(value, error, consumer))
  );
}

/** All evaluated creation operands and earlier application work precede the copied native words. */
function quietConstructionInput(consumer: Expression, names: ReadonlySet<string>): boolean {
  if (!isCallExpression(consumer) && !isNewExpression(consumer)) return false;
  if (isNewExpression(consumer) && !framedQuietInputs([consumer.expression], names)) return false;
  if (
    isCallExpression(consumer) &&
    (consumer.arguments.length > 2 || !framedQuietInputs(consumer.arguments, names))
  )
    return false;
  return (
    framedQuietTextPrefix(consumer, names) && framedQuietInputs(consumer.arguments ?? [], names)
  );
}
