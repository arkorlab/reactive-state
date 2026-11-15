import { type CallExpression, type Expression } from 'typescript/ast';

import { fixedDateText } from './dated.ts';
import { framedBoundErrorArguments } from './framed-bound-errors.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedQuietInputs, framedQuietSource } from './framed-native-evaluation.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import { LOCAL_TIME } from './local-date-inputs.ts';
import { constantValue } from './numbers.ts';

/** Borrowed and bound native parsing retains original argument evaluation and local text. */

const PARSERS: ReadonlySet<string> = new Set(['Date.parse']);
const FIELDS: ReadonlySet<string> = new Set(['Date.parse', 'Reflect.apply']);

/** Native wrappers retain only their unchanged same-owner target and fully quiet original inputs. */
export function renderBorrowedDateParser(call: CallExpression): string | undefined {
  const bound = framedBoundErrorArguments(call, PARSERS);
  const selected = bound ?? framedNativeArguments(call, PARSERS);
  if (
    selected === undefined ||
    selected.constructed ||
    selected.args === undefined ||
    (bound === undefined && framedNativeConstructor(call.expression, PARSERS)) ||
    !framedOriginCoowned(call.expression, call) ||
    !framedOriginCoowned(selected.target, call)
  )
    return undefined;
  const inputs = [...call.arguments, ...(bound?.bound.arguments ?? [])];
  if (
    inputs.some((input) => !framedOriginCoowned(input, call)) ||
    !framedQuietInputs(inputs, FIELDS) ||
    !framedQuietTextPrefix(call, FIELDS, (prior) => prior === bound?.bound)
  )
    return undefined;
  const prefix = framedArgumentPrefix(call, selected.args, Infinity);
  if (prefix.unknown || prefix.alternatives !== undefined) return undefined;
  return localText(prefix.values[0]) ? LOCAL_TIME : undefined;
}

/** A written string without a fixed ISO instant keeps the runtime's native parsing time zone. */
function localText(expression: Expression | undefined): boolean {
  const value = expression === undefined ? undefined : framedQuietSource(expression);
  return value !== undefined && typeof constantValue(value) === 'string' && !fixedDateText(value);
}
