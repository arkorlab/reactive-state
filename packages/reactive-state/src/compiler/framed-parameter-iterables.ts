import {
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isPropertyAccessExpression,
  type NewExpression,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedNativeEntryGenerator } from './framed-native-entry-generators.ts';
import { framedPrefixSameOwner, framedQuietOwnerPrefix } from './framed-native-prefix.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Closed primitive entry generators suppress conversion of unused literal record fields. */

const ITERATORS = new Set(['Symbol.iterator']);
const NATIVES = new Set(['Headers', 'Symbol.iterator', 'URLSearchParams']);
const OBSERVATIONS = new Set(['text:get', 'text:getAll', 'text:has', 'text:toString']);

/** Only unchanged same-owner literal inputs and immediate quiet native observations add this proof. */
export function framedPrimitiveParameterIterable(
  expression: Expression,
  record: ObjectLiteralExpression,
  call: NewExpression,
): boolean {
  const args = call.arguments ?? [];
  const input = args[0];
  return (
    args.length === 1 &&
    input !== undefined &&
    unwrapped(input) === unwrapped(expression) &&
    framedPrefixSameOwner(record, call) &&
    framedOriginCoowned(expression, call) &&
    quietIteratorPrefix(call) &&
    quietObservation(call) &&
    primitiveIterator(record)
  );
}

/** Native iterator keys are quiet computed names; completed earlier calls retain opacity. */
function quietIteratorPrefix(call: NewExpression): boolean {
  return framedQuietOwnerPrefix(call, {
    primitive: (value) =>
      framedMapKey(value) !== undefined || framedNativeConstructor(value, ITERATORS),
    value: (value) => framedNativeConstructor(value, NATIVES),
  });
}

/** The fresh native result is read before any unknown method argument or saved-result exposure. */
function quietObservation(call: NewExpression): boolean {
  const member = useOf(call);
  const access = member.parent;
  let name: string | undefined;
  if (isPropertyAccessExpression(access) && access.expression === member.at)
    name = `text:${access.name.text}`;
  else if (isElementAccessExpression(access) && access.expression === member.at)
    name = framedMapKey(access.argumentExpression);
  if (name === undefined || !OBSERVATIONS.has(name)) return false;
  const observation = useOf(access);
  return (
    isCallExpression(observation.parent) &&
    observation.parent.expression === observation.at &&
    observation.parent.arguments.every((argument) => framedMapKey(argument) !== undefined)
  );
}

/** One closed entry generator keeps the original all-written-cell primitive boundary. */
function primitiveIterator(record: ObjectLiteralExpression): boolean {
  const entries = framedNativeEntryGenerator(record);
  return entries?.every((entry) => framedMapKey(entry.value) !== undefined) === true;
}
