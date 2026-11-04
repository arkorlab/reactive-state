import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isSpreadElement,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { borrowedTextCall } from './framed-array-borrowing.ts';
import { arrayError } from './framed-arrays.ts';
import { framedBorrowedInputs } from './framed-borrowed-inputs.ts';
import { framedEntryKeys } from './framed-entry-key-words.ts';
import { framedAppliedArguments, framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedConsumedArguments } from './framed-text-arguments.ts';

/** Native property-key operations coerce their consumed key, including borrowed static and prototype calls. */

interface KeyWords {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression) => boolean;
}

const FROM_ENTRIES = new Set(['Object.fromEntries']);

const STATIC_KEYS: ReadonlySet<string> = new Set([
  'Object.defineProperty',
  'Object.getOwnPropertyDescriptor',
  'Object.hasOwn',
  'Reflect.defineProperty',
  'Reflect.deleteProperty',
  'Reflect.get',
  'Reflect.getOwnPropertyDescriptor',
  'Reflect.has',
  'Reflect.set',
]);
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  'Object.prototype.__defineGetter__',
  'Object.prototype.__defineSetter__',
  'Object.prototype.__lookupGetter__',
  'Object.prototype.__lookupSetter__',
  'Object.prototype.hasOwnProperty',
  'Object.prototype.propertyIsEnumerable',
]);

/** The native key slot, without classifying locally shadowed callables as native methods. */
export function framedKeyOperation(
  node: Node,
  words: (value: Expression, keys?: readonly string[]) => boolean,
  typed: (value: Expression) => boolean,
): boolean {
  if (!isCallExpression(node)) return false;
  const proof = { error: words, typed };
  if (framedNativeConstructor(node.expression, FROM_ENTRIES))
    return framedEntryKeys(node, node.arguments, proof);
  const inputs = framedBorrowedInputs(node, FROM_ENTRIES);
  if (inputs !== undefined)
    return inputs.inputs.some((value) => {
      return inputs.applied
        ? framedEntryKeys(node, undefined, proof, value)
        : framedEntryKeys(node, [value], proof);
    });
  const path = globalPathOf(unwrapped(node.expression))?.join('.');
  if (path !== undefined && STATIC_KEYS.has(path))
    return consumedKey(node, node.arguments, 1, proof);
  const borrowed = borrowedTextCall(node);
  if (borrowed === undefined) return false;
  const native = borrowed.path.join('.');
  if (FROM_ENTRIES.has(native)) {
    if (borrowed.applied === undefined) return framedEntryKeys(node, borrowed.given, proof);
    return framedEntryKeys(node, undefined, proof, borrowed.applied);
  }
  const index = STATIC_KEYS.has(native) ? 1 : 0;
  if (!STATIC_KEYS.has(native) && !PROTOTYPE_KEYS.has(native)) return false;
  const applied = borrowed.applied;
  if (applied === undefined) return consumedKey(node, borrowed.given, index, proof);
  const given = framedAppliedArguments(node, applied);
  return given === undefined
    ? arrayError(applied, proof, node)
    : consumedKey(node, given, index, proof);
}

/** Only the consumed runtime key is converted; target and ignored trailing arguments retain their meaning. */
function consumedKey(
  call: CallExpression,
  given: readonly Expression[],
  index: number,
  proof: KeyWords,
): boolean {
  const prefix = framedArgumentPrefix(call, given);
  if (!prefix.unknown) {
    const key = prefix.values[index];
    return key !== undefined && proof.error(key);
  }
  return framedConsumedArguments(call, given, index + 1).some((value) => {
    if (index > 0 && value === prefix.values[0]) return false;
    return isSpreadElement(value) ? arrayError(value.expression, proof, call) : proof.error(value);
  });
}
