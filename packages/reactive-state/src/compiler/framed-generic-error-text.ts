import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  type Node,
} from 'typescript/ast';

import { globalPathOf } from './code-globals.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import {
  framedNativeErrorInput,
  type FramedNativeErrorReads,
} from './framed-native-error-inputs.ts';
import {
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedQuietOwnerPrefix } from './framed-native-prefix.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';
import { readsBinding } from './scope.ts';

/** Generic native Error text converts its name before its message, without requiring an Error receiver. */
const NATIVES = new Set([...STANDARD_ERRORS, 'Error.prototype.toString', 'Reflect.apply']);
const MEMBERS = new Set([
  'Error',
  'Error.prototype',
  'Error.prototype.toString',
  'Reflect',
  'Reflect.apply',
]);

interface Conversion {
  readonly quiet: boolean;
  readonly words: boolean;
}

/** Quiet own fields retain their original conversion nodes and native evaluation order. */
export function framedGenericErrorText(
  receiver: Expression,
  call: CallExpression,
  error: (value: Expression) => boolean,
): boolean {
  const source = framedQuietSource(receiver);
  if (
    source === undefined ||
    !isObjectLiteralExpression(source) ||
    !framedOriginCoowned(receiver, call) ||
    !framedQuietInputs(call.arguments, NATIVES) ||
    !framedQuietOwnerPrefix(call, {
      primitive: framedQuietPrimitive,
      value: (value) => MEMBERS.has(globalPathOf(value)?.join('.') ?? ''),
      construct: (value) => {
        return (
          framedNativeConstructor(value.expression, STANDARD_ERRORS) &&
          framedQuietInputs(value.arguments ?? [], new Set())
        );
      },
    })
  )
    return false;
  const fields = new Map<string, Expression>();
  for (const field of source.properties) {
    if (isShorthandPropertyAssignment(field) && isIdentifier(field.name)) {
      fields.set(field.name.text, field.name);
      continue;
    }
    if (!isPropertyAssignment(field)) return false;
    const key = writtenArrayKey(field.name);
    if (key === undefined || key === '__proto__') return false;
    fields.set(key, field.initializer);
  }
  const reads: FramedNativeErrorReads = {
    consumer: call,
    unconverted: storedReads(source),
    consumed: new Set(),
  };
  const name = conversion(fields.get('name'), call, error, reads);
  if (!name.quiet) return false;
  const message = conversion(fields.get('message'), call, error, reads);
  return message.quiet && (name.words || message.words);
}

/** Only primitive, native Error and closed array conversions add no opaque earlier hook. */
function conversion(
  field: Expression | undefined,
  call: CallExpression,
  error: (value: Expression) => boolean,
  reads: FramedNativeErrorReads,
): Conversion {
  if (field === undefined) return { quiet: true, words: false };
  const pending = [field];
  const seen = new Set<Expression>();
  let words = false;
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (framedQuietPrimitive(at) || isOmittedExpression(at)) continue;
    const value = framedQuietSource(at);
    if (value === undefined) return { quiet: false, words: false };
    if (seen.has(value)) continue;
    seen.add(value);
    if (isArrayLiteralExpression(value)) {
      pending.push(...value.elements);
      continue;
    }
    if (quietWrittenError(value)) continue;
    if (!unchangedErrorWords(at, call, error, reads)) return { quiet: false, words: false };
    words = true;
  }
  return { quiet: true, words };
}

/** Proven literal creation stores these reads without converting or handing them to application work. */
function storedReads(source: Expression): ReadonlySet<Identifier> {
  const pending: Node[] = [source];
  const seen = new Set<Node>();
  const found = new Set<Identifier>();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (seen.has(node)) continue;
    seen.add(node);
    if (isIdentifier(node) && readsBinding(node)) {
      found.add(node);
      const value = framedQuietSource(node);
      if (
        value !== undefined &&
        (isObjectLiteralExpression(value) || isArrayLiteralExpression(value))
      )
        pending.push(value);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return found;
}

/** A fresh native Error with primitive construction inputs has only locally written words. */
function quietWrittenError(value: Expression): boolean {
  return (
    isNewExpression(value) &&
    framedNativeConstructor(value.expression, STANDARD_ERRORS) &&
    framedQuietInputs(value.arguments ?? [], new Set())
  );
}

/** An external Error retains native conversion only at this qualified original consumer. */
function unchangedErrorWords(
  value: Expression,
  call: CallExpression,
  error: (value: Expression) => boolean,
  reads: FramedNativeErrorReads,
): boolean {
  return error(value) && framedNativeErrorInput(value, call, reads);
}
