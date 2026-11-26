import {
  type ArrayLiteralExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { framedJsonBoxedValue } from './framed-json-boxed-values.ts';
import { framedJsonKeys } from './framed-json-keys.ts';
import { framedJsonReplacerHook } from './framed-json-replacer-hook.ts';
import { framedJsonSpreadElements } from './framed-json-spread-elements.ts';
import {
  jsonOwnMember,
  jsonToJSON,
  jsonValueSource,
  type JsonValueSource,
} from './framed-json-values.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeArguments } from './framed-native-arguments.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import {
  framedQuietGetter,
  framedQuietInputs,
  framedQuietPrimitive,
} from './framed-native-evaluation.ts';
import { framedObjectSources } from './framed-object-members.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';

/** Source-known JSON property lists read selected Error fields even when they are non-enumerable. */

const STRINGIFY = new Set(['JSON.stringify']);
const NATIVE_INPUTS = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException', ...STRINGIFY]);

interface JsonFrameProof {
  readonly frame: (value: Expression, keys: readonly string[]) => boolean;
  readonly words: (value: Expression, keys: readonly string[]) => boolean;
  readonly data: (value: Expression, names: readonly string[]) => boolean;
}

interface JsonReading {
  readonly value: Expression;
  readonly keys: readonly string[];
  readonly toJSON: boolean;
  readonly memberRead?: boolean;
}

/** Native JSON calls keep their replacer-array filter separate from replacer callbacks and data. */
export function framedJsonMembers(
  node: Node,
  frames: ReadonlySet<string>,
  proof: JsonFrameProof,
): boolean {
  if (!isCallExpression(node)) return false;
  const selected = framedNativeArguments(node, STRINGIFY);
  if (selected === undefined || selected.constructed || selected.args === undefined) return false;
  const prefix = framedArgumentPrefix(node, selected.args, 2);
  const [value, replacer] = prefix.values;
  if (
    value === undefined ||
    replacer === undefined ||
    prefix.unknown ||
    prefix.alternatives !== undefined
  )
    return false;
  const names = framedJsonKeys(replacer, { call: node, args: selected.args });
  if (names === undefined) {
    const transformed = framedJsonReplacerHook(node, value, replacer, selected.args);
    return (
      transformed !== undefined &&
      transformed.names.some((name) => frames.has(name) || name === 'message') &&
      jsonReadsFrames(
        transformed.value,
        { call: node, names: transformed.names, frames, proof },
        false,
      )
    );
  }
  if (names.every((name) => !frames.has(name) && name !== 'message')) return false;
  return jsonReadsFrames(value, { call: node, names, frames, proof });
}

/** Selected literal containers preserve their original values and remaining lexical member paths. */
function jsonReadsFrames(
  value: Expression,
  context: Omit<JsonReadingContext, 'pending'>,
  toJSON = true,
): boolean {
  const pending: JsonReading[] = [{ value, keys: [], toJSON }];
  const seen = new Map<Node, Set<string>>();
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const key = JSON.stringify([at.toJSON, at.memberRead === true, at.keys]);
    const keys = seen.get(at.value) ?? new Set<string>();
    if (keys.has(key)) continue;
    keys.add(key);
    seen.set(at.value, keys);
    if (jsonReadingFrames(at, { ...context, pending })) return true;
  }
  return false;
}

interface JsonReadingContext {
  readonly call: Node;
  readonly names: readonly string[];
  readonly frames: ReadonlySet<string>;
  readonly proof: JsonFrameProof;
  readonly pending: JsonReading[];
}

/** One serialization step invokes its own toJSON once, then reads only the resulting value. */
function jsonReadingFrames(at: JsonReading, context: JsonReadingContext): boolean {
  const { names, frames, proof } = context;
  if (at.keys.length > 0)
    return (
      selectedErrorFrames(at, names, frames, proof) ||
      (at.memberRead === true && projectedMemberFrames(at, context))
    );
  const source = jsonValueSource(at.value);
  if (at.toJSON && jsonToJSONReading(at, source, context)) return false;
  if (framedJsonBoxedValue(at.value, context.call)) return false;
  if (jsonLiteralContainer(source, context)) return false;
  return jsonReceiverFrames(at, source, context);
}

/** A known toJSON replacement suppresses this step's original receiver, even when it returns data. */
function jsonToJSONReading(
  at: JsonReading,
  source: JsonValueSource,
  context: JsonReadingContext,
): boolean {
  const transformed = jsonToJSON(at.value, source, context.call);
  if (transformed === undefined) return false;
  if (transformed !== null)
    context.pending.push(...transformed.map((value) => ({ value, keys: [], toJSON: false })));
  return true;
}

/** Literal arrays retain every serialized element; literal objects retain their listed member paths. */
function jsonLiteralContainer(source: JsonValueSource, context: JsonReadingContext): boolean {
  const { names, pending } = context;
  if (isArrayLiteralExpression(source.value)) {
    appendJsonElements(source.value, context);
    return true;
  }
  if (isObjectLiteralExpression(source.value)) {
    const memberReads = literalMemberReadsQuiet(source.value, context);
    for (const name of names) {
      const entries = framedObjectSources(source.value, [name]) ?? [];
      const memberRead =
        memberReads && jsonOwnMember(source.value, source, context.call, name) === undefined;
      pending.push(...entries.map((each) => ({ ...each, toJSON: true, memberRead })));
    }
    return true;
  }
  return false;
}

/** A retained final member is observed before JSON classifies the selected value as a receiver. */
function projectedMemberFrames(at: JsonReading, context: JsonReadingContext): boolean {
  const name = at.keys.at(-1);
  if (name === undefined || !isCallExpression(context.call)) return false;
  const value = unwrapped(at.value);
  if (
    !framedNativeErrorInput(value, context.call, undefined, false) &&
    !(isNewExpression(value) && framedQuietInputs([value], NATIVE_INPUTS))
  )
    return false;
  const receiver = { ...at, keys: at.keys.slice(0, -1) };
  if (receiver.keys.length === 0) {
    const source = jsonValueSource(value);
    if (
      jsonOwnMember(value, source, context.call, name) !== undefined ||
      context.proof.data(value, [name]) ||
      context.proof.data(source.value, [name])
    )
      return false;
  }
  return selectedErrorFrames(receiver, [name], context.frames, context.proof);
}

/** Added inherited reads require quiet original operands, literal fields and prior owner work. */
function literalMemberReadsQuiet(
  object: ObjectLiteralExpression,
  context: JsonReadingContext,
): boolean {
  if (!isCallExpression(context.call) || !framedOriginPrefix(context.call)) return false;
  const selected = framedNativeArguments(context.call, STRINGIFY);
  const value = selected?.args?.[0];
  return (
    value !== undefined &&
    quietLiteralFields(object) &&
    quietOriginalOperands(context.call.arguments, value)
  );
}

/** Literal prototype syntax is quiet; arbitrary spreads, getters and computed work prove nothing. */
function quietLiteralFields(object: ObjectLiteralExpression): boolean {
  const pending = [object];
  const values: Expression[] = [];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    for (const property of at.properties) {
      const value = literalFieldValue(property);
      if (value === undefined) return false;
      const literal = unwrapped(value);
      if (isObjectLiteralExpression(literal)) pending.push(literal);
      else values.push(value);
    }
  }
  return framedQuietInputs(values, NATIVE_INPUTS);
}

/** One literal field contributes only its source-written quiet value or direct getter result. */
function literalFieldValue(property: ObjectLiteralElementLike): Expression | undefined {
  if (isSpreadAssignment(property)) return undefined;
  if (isComputedPropertyName(property.name) && !framedQuietPrimitive(property.name.expression))
    return undefined;
  if (isPropertyAssignment(property)) return property.initializer;
  if (isShorthandPropertyAssignment(property) && isIdentifier(property.name)) return property.name;
  return isGetAccessorDeclaration(property) ? framedQuietGetter(property) : undefined;
}

/** Wrapper argument arrays retain the actual value slot while every other operand remains quiet. */
function quietOriginalOperands(args: readonly Expression[], value: Expression): boolean {
  const pending = [...args];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (at === value) continue;
    if (isArrayLiteralExpression(at)) pending.push(...at.elements);
    else if (!framedQuietInputs([at], NATIVE_INPUTS)) return false;
  }
  return true;
}

/** Array elements serialize independently of the property list used for object members. */
function appendJsonElements(array: ArrayLiteralExpression, context: JsonReadingContext): void {
  const { pending, call } = context;
  for (const element of array.elements) {
    if (isOmittedExpression(element)) continue;
    if (isSpreadElement(element)) {
      const expanded = framedJsonSpreadElements(
        element.expression,
        call,
        (value) => context.proof.frame(value, []) || context.proof.words(value, []),
      );
      if (expanded !== undefined) {
        pending.push(...expanded.map((value) => ({ value, keys: [], toJSON: true })));
        continue;
      }
    }
    const value = isSpreadElement(element) ? element.expression : element;
    pending.push({ value, keys: [], toJSON: true });
  }
}

/** Own fields supply their written values before the native Error receiver proof is considered. */
function jsonReceiverFrames(
  at: JsonReading,
  source: JsonValueSource,
  context: JsonReadingContext,
): boolean {
  const { names, pending, call, proof, frames } = context;
  for (const name of names) {
    const own = jsonOwnMember(at.value, source, call, name);
    if (own !== undefined && own !== null) {
      pending.push(...own.map((value) => ({ value, keys: [], toJSON: true })));
      continue;
    }
    if (
      !proof.data(at.value, [name]) &&
      !proof.data(source.value, [name]) &&
      selectedErrorFrames(at, [name], frames, proof)
    )
      return true;
  }
  return false;
}

/** Only engine frame names and an externally supplied Error's message are engine observations. */
function selectedErrorFrames(
  at: JsonReading,
  names: readonly string[],
  frames: ReadonlySet<string>,
  proof: JsonFrameProof,
): boolean {
  return (
    (names.some((name) => frames.has(name)) && proof.frame(at.value, at.keys)) ||
    (names.includes('message') && proof.words(at.value, at.keys))
  );
}
