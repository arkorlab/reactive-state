import {
  type ArrayBindingPattern,
  type BindingElement,
  type BindingName,
  type Expression,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBindingElement,
  isComputedPropertyName,
  isIdentifier,
  isNewExpression,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isOmittedExpression,
  isSpreadElement,
  type Node,
  type ParameterDeclaration,
} from 'typescript/ast';

import { frameMemberName } from './framed-bindings.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { mapperMemberSlots, mapperSlotValues, type MapperSlot } from './framed-mapper-slots.ts';
import { framedQuietSource } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** A native callback rest pattern reads only its fresh pack and source-proved literal own data. */

const SETS = new Set(['Set']);
const MAPS = new Set(['Map']);

interface NativeInput {
  readonly receiver: Expression;
  readonly parameter: number;
  readonly method: string;
  readonly borrowed: boolean;
}

interface BoundSlots {
  readonly name: BindingName;
  readonly slots: readonly MapperSlot[];
}

/** Only this native rest binding may replace the prefix proof's plain-parameter requirement. */
export function quietNativeCallbackRest(
  parameter: ParameterDeclaration,
  source: NativeInput,
): boolean {
  if (parameter.dotDotDotToken === undefined || parameter.initializer !== undefined) return false;
  if (isIdentifier(parameter.name)) return true;
  if (!isArrayBindingPattern(parameter.name)) return false;
  const pending = packedBindings(parameter.name, source);
  if (pending === undefined) return false;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const children = boundChildren(next);
    if (children === undefined) return false;
    pending.push(...children);
  }
  return true;
}

/** The outer array is the native argument pack; nested patterns need each actual argument's data. */
function packedBindings(
  pattern: ArrayBindingPattern,
  source: NativeInput,
): BoundSlots[] | undefined {
  const found: BoundSlots[] = [];
  for (const [index, field] of pattern.elements.entries()) {
    if (omittedBinding(field)) continue;
    if (!plainBinding(field) || field.propertyName !== undefined) return undefined;
    if (isIdentifier(field.name)) continue;
    const slots = argumentSlots(source, source.parameter + index);
    if (slots === undefined) return undefined;
    found.push({ name: field.name, slots });
  }
  return found;
}

/** Defaults and nested rest work stay outside this added proof. */
function plainBinding(node: Node): node is BindingElement & { readonly name: BindingName } {
  return (
    isBindingElement(node) &&
    node.name !== undefined &&
    node.dotDotDotToken === undefined &&
    node.initializer === undefined
  );
}

/** The Beta API represents an array omission as an empty binding element. */
function omittedBinding(node: Node): boolean {
  return (
    isOmittedExpression(node) ||
    (isBindingElement(node) &&
      isArrayBindingPattern(node.parent) &&
      node.name === undefined &&
      node.dotDotDotToken === undefined &&
      node.initializer === undefined &&
      node.propertyName === undefined)
  );
}

/** Nested object patterns use literal own data; nested array patterns use literal native iteration. */
function boundChildren(next: BoundSlots): BoundSlots[] | undefined {
  if (isIdentifier(next.name)) return [];
  const array = isArrayBindingPattern(next.name);
  if (!array && !isObjectBindingPattern(next.name)) return undefined;
  if (
    next.slots.some((slot) => {
      return (
        typeof slot === 'string' ||
        (!isArrayLiteralExpression(slot) && (array || !isObjectLiteralExpression(slot)))
      );
    })
  )
    return undefined;
  const found: BoundSlots[] = [];
  for (const [index, field] of next.name.elements.entries()) {
    if (array && omittedBinding(field)) continue;
    if (!plainBinding(field)) return undefined;
    const key = bindingKey(field, index, array);
    if (key === undefined) return undefined;
    const slots = next.slots.flatMap((slot) => mapperMemberSlots(slot, key));
    if (slots.some((slot) => typeof slot === 'string')) return undefined;
    found.push({ name: field.name, slots });
  }
  return found;
}

/** A computed binding key must already be a source-proved primitive. */
function bindingKey(field: BindingElement, index: number, array: boolean): string | undefined {
  const property = field.propertyName;
  if (
    property !== undefined &&
    isComputedPropertyName(property) &&
    framedMapKey(property.expression) === undefined
  )
    return undefined;
  return array ? String(index) : frameMemberName(field);
}

/** Only written literal argument values establish nested binding data, never a tuple annotation. */
function argumentSlots(source: NativeInput, parameter: number): MapperSlot[] | undefined {
  const value = framedQuietSource(source.receiver);
  if (value === undefined) return undefined;
  if (isArrayLiteralExpression(value))
    return parameter === 0 ? literalSlots(value.elements) : undefined;
  if (source.borrowed || source.method !== 'forEach' || !isNewExpression(value)) return undefined;
  const first = value.arguments?.[0];
  const entries = first === undefined ? undefined : framedQuietSource(first);
  if (entries === undefined || !isArrayLiteralExpression(entries)) return undefined;
  if (framedNativeConstructor(value.expression, SETS))
    return parameter <= 1 ? literalSlots(entries.elements) : undefined;
  return framedNativeConstructor(value.expression, MAPS)
    ? mapSlots(entries.elements, parameter)
    : undefined;
}

/** A spread or a hole cannot establish a present own container for nested destructuring. */
function literalSlots(values: readonly Expression[]): MapperSlot[] | undefined {
  if (values.some((value) => isSpreadElement(value) || isOmittedExpression(value)))
    return undefined;
  return values.flatMap((value) => mapperSlotValues(value));
}

/** Every source-written Map pair keeps its value before its key, including replaced earlier entries. */
function mapSlots(entries: readonly Expression[], parameter: number): MapperSlot[] | undefined {
  if (parameter > 1) return undefined;
  const found: MapperSlot[] = [];
  for (const entry of entries) {
    const pair = framedQuietSource(entry);
    if (
      pair === undefined ||
      !isArrayLiteralExpression(pair) ||
      pair.elements.some((element) => isSpreadElement(element))
    )
      return undefined;
    const value = pair.elements[parameter === 0 ? 1 : 0];
    if (value === undefined || isOmittedExpression(value)) return undefined;
    found.push(...mapperSlotValues(value));
  }
  return found;
}
