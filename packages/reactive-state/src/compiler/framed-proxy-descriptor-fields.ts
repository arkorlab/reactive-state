import {
  type Expression,
  isArrayLiteralExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isOmittedExpression,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  type NewExpression,
  type Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from 'typescript/ast';

import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import {
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import {
  framedProxyFieldName,
  framedProxyFieldValue,
  framedProxyInputQuiet,
  framedProxyRecordQuiet,
  framedProxyTrapResult,
} from './framed-proxy-descriptor-inputs.ts';
import {
  framedProxyDescriptorCall,
  framedProxyObservationQuiet,
} from './framed-proxy-descriptor-observations.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** A returned descriptor's value getter is consumed as data by native Proxy descriptor conversion. */

const ERRORS = new Set([
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

/** Only quiet fresh-target descriptor conversions add getter-returned value origins. */
export function framedProxyDescriptorFields(
  creation: NewExpression,
  trap: Node,
  returned: Expression,
  proof: {
    readonly consumer: Expression;
    readonly observation: Expression;
    readonly names: readonly string[] | undefined;
    readonly emptyBindingPrefix?: boolean;
  },
): readonly Expression[] | undefined {
  const { consumer, observation, names } = proof;
  if (!framedProxyObservationQuiet(consumer, observation, proof.emptyBindingPrefix === true))
    return undefined;
  const call = framedProxyDescriptorCall(observation);
  if (call === undefined || !quietCreation(creation) || framedProxyTrapResult(trap, 2) !== returned)
    return undefined;
  const record = framedQuietSource(returned);
  if (record === undefined || !isObjectLiteralExpression(record) || !framedProxyRecordQuiet(record))
    return undefined;
  const value = descriptorGetter(record);
  if (value === undefined || !quietSelected(value, consumer)) return undefined;
  if (call.arguments.some((argument, index) => index !== 0 && !framedProxyInputQuiet(argument)))
    return undefined;
  if (!framedProxyDescriptorCall(observation, creation, names)) return undefined;
  if (
    proof.emptyBindingPrefix !== true &&
    !framedOriginPrefix(consumer, {
      construct: (node) => node === creation,
      call: (node) => node === call,
    })
  )
    return undefined;
  return [value];
}

/** A fresh empty ordinary target has no absent-property invariant or own trap exposure. */
function quietCreation(creation: NewExpression): boolean {
  const args = creation.arguments ?? [];
  const [target, handler] = args;
  const object = target === undefined ? undefined : framedQuietSource(target);
  const methods = handler === undefined ? undefined : framedQuietSource(handler);
  return (
    object !== undefined &&
    isObjectLiteralExpression(object) &&
    object.properties.length === 0 &&
    methods !== undefined &&
    isObjectLiteralExpression(methods) &&
    framedProxyRecordQuiet(methods) &&
    args.slice(2).every((argument) => framedProxyInputQuiet(argument))
  );
}

/** Every consumed attribute is quiet, and an accessor descriptor cannot also carry a value. */
interface DescriptorState {
  value: Expression | undefined;
  getter: boolean;
  configurable: boolean;
}

function descriptorGetter(record: ObjectLiteralExpression): Expression | undefined {
  const state: DescriptorState = { value: undefined, getter: false, configurable: false };
  for (const property of record.properties) {
    if (!readDescriptorField(property, state)) return undefined;
  }
  return state.getter && state.configurable ? state.value : undefined;
}

/** Every consumed getter has a direct quiet return; later setters preserve only a paired getter. */
function readDescriptorField(
  property: ObjectLiteralExpression['properties'][number],
  state: DescriptorState,
): boolean {
  if (isSpreadAssignment(property)) return false;
  const name = framedProxyFieldName(property.name);
  if (name === undefined || ['get', 'set'].includes(name)) return false;
  const selected = framedProxyFieldValue(property);
  if (selected !== undefined && !framedProxyInputQuiet(selected)) return false;
  if (selected === undefined && isGetAccessorDeclaration(property)) return false;
  if (name === 'configurable')
    state.configurable =
      selected !== undefined && framedQuietSource(selected)?.kind === SyntaxKind.TrueKeyword;
  if (name !== 'value') return true;
  if (isSetAccessorDeclaration(property)) {
    if (!state.getter) state.value = undefined;
  } else {
    state.value = selected;
    state.getter = isGetAccessorDeclaration(property);
  }
  return true;
}

/** Added carried values require unchanged coowned inputs, including each finite literal container. */
function quietSelected(source: Expression, consumer: Expression): boolean {
  const pending = [source];
  const seen = new Set<Expression>();
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (!framedOriginCoowned(node, consumer)) return false;
    const value = framedQuietSource(node);
    if (value === undefined) return false;
    if (seen.has(value)) continue;
    seen.add(value);
    if (!quietSelectedValue(value, consumer, pending)) return false;
  }
  return true;
}

/** Each finite value is coowned and unchanged, without arbitrary invocation or property inference. */
function quietSelectedValue(
  value: Expression,
  consumer: Expression,
  pending: Expression[],
): boolean {
  if (framedQuietPrimitive(value) || isOmittedExpression(value)) return true;
  if (isIdentifier(value)) return framedNativeErrorInput(value, consumer);
  if (isNewExpression(value))
    return (
      framedNativeConstructor(value.expression, ERRORS) &&
      (value.arguments ?? []).every((argument) => framedQuietInputs([argument], new Set()))
    );
  if (isArrayLiteralExpression(value)) {
    pending.push(...value.elements);
    return true;
  }
  return isObjectLiteralExpression(value) && selectedFields(value, pending);
}

/** Source-known data and sole-return getters retain only their written nested values. */
function selectedFields(record: ObjectLiteralExpression, pending: Expression[]): boolean {
  if (!framedProxyRecordQuiet(record)) return false;
  for (const property of record.properties) {
    const value = framedProxyFieldValue(property);
    if (value === undefined) return false;
    pending.push(value);
  }
  return true;
}

/** A finite original literal path selects the carried getter result without fabricating member nodes. */
export function framedProxyDescriptorProjection(
  values: readonly Expression[],
  keys: readonly string[],
): readonly Expression[] | undefined {
  const pending = values.map((value) => ({ value, keys }));
  const found: Expression[] = [];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const key = at.keys[0];
    if (key === undefined) {
      found.push(at.value);
      continue;
    }
    const value = framedQuietSource(at.value);
    if (value === undefined) return undefined;
    const next = literalSelection(value, key);
    if (next === undefined) return undefined;
    pending.push({ value: next, keys: at.keys.slice(1) });
  }
  return found;
}

/** Only a proved original object field or fixed array slot establishes a nested carried value. */
function literalSelection(value: Expression, key: string): Expression | undefined {
  if (isArrayLiteralExpression(value)) {
    return arraySlot(value.elements, key);
  }
  if (!isObjectLiteralExpression(value)) return undefined;
  let selected: Expression | undefined;
  let getter = false;
  for (const property of value.properties) {
    if (isSpreadAssignment(property)) return undefined;
    if (framedProxyFieldName(property.name) !== key) continue;
    if (isSetAccessorDeclaration(property)) {
      if (!getter) selected = undefined;
    } else {
      selected = framedProxyFieldValue(property);
      getter = isGetAccessorDeclaration(property);
    }
  }
  return selected;
}

/** Canonical finite array indices retain their original source element. */
function arraySlot(elements: readonly Expression[], key: string): Expression | undefined {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === key
    ? elements[index]
    : undefined;
}
