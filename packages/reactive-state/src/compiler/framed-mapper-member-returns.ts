import {
  type ArrowFunction,
  type ArrayLiteralExpression,
  type BindingName,
  type CallExpression,
  type Expression,
  type FunctionExpression,
  type Identifier,
  isArrayLiteralExpression,
  isArrayBindingPattern,
  isArrowFunction,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isBindingElement,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isSpreadElement,
  type ParameterDeclaration,
} from 'typescript/ast';

import type { Answering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { concatSource } from './framed-concat-properties.ts';
import { framedGroupByOwnedInput } from './framed-groupby-inputs.ts';
import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { quietMapperFunction } from './framed-mapper-quiet.ts';
import { mapperMemberSlots, mapperSlotValues, type MapperSlot } from './framed-mapper-slots.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';

/** Native mappers retain returned input members only through quiet literal own data. */

interface MemberRead {
  readonly receiver: Expression;
  readonly index: number | undefined;
  readonly capture: CallExpression;
  readonly stable: (value: Expression) => boolean;
  readonly method: string;
}

interface InputMember {
  readonly keys: readonly string[];
  readonly parameter: ParameterDeclaration;
  readonly read: Expression;
}

interface Members {
  readonly values: readonly Expression[];
  readonly roots: readonly Expression[];
}

interface BoundSlots {
  readonly name: BindingName;
  readonly slots: readonly MapperSlot[];
}

/** A written input member has the original slot's own data, without invoking an accessor or key. */
export function mapperReturnedMemberViews(
  returned: Expression,
  read: MemberRead,
  owner: Answering | undefined,
): readonly ArrayElementView[] {
  if (owner === undefined || (!isArrowFunction(owner) && !isFunctionExpression(owner))) return [];
  if (read.method === 'flatMap' && !isArrayLiteralExpression(useOf(returned).parent)) return [];
  const input = inputMemberKeys(returned, owner);
  if (input === undefined || !plainOtherParameters(owner, input.parameter)) return [];
  const source = concatSource(read.receiver, read.stable, false);
  if (
    source === undefined ||
    !isArrayLiteralExpression(source) ||
    source.elements.some((each) => isSpreadElement(each))
  )
    return [];
  const selected = selectedMembers(source.elements, read.index, input.keys);
  const all = selectedMembers(source.elements, undefined, input.keys);
  if (selected === undefined || all === undefined) return [];
  const given = quietArguments(owner, source, read, input);
  if (given === undefined) return [];
  if (
    !iteratorCarriedUnexposed(
      [source, ...all.roots, ...given],
      selected.values.map((value) => ({ value })),
      read.capture,
    )
  )
    return [];
  return selected.values
    .filter((value) => framedOriginCoowned(value, read.capture))
    .map((value) => ({ value, index: undefined, element: true, capture: read.capture }));
}

/** All original arguments and every invocation's parameter and callback work stay quiet. */
function quietArguments(
  owner: ArrowFunction | FunctionExpression,
  source: ArrayLiteralExpression,
  read: MemberRead,
  input: InputMember,
): readonly Expression[] | undefined {
  const given = framedArgumentPrefix(read.capture, read.capture.arguments, Infinity, false);
  if (
    input.parameter.initializer !== undefined ||
    given.unknown ||
    (given.alternatives?.length ?? 0) > 0 ||
    !quietBoundMembers(input.parameter, source.elements) ||
    !framedOriginCoowned(source, read.capture) ||
    !quietMapperFunction(owner, read.capture, source, {
      evaluated: given.values,
      read: input.read,
    })
  )
    return undefined;
  return given.values;
}

/** A literal member chain roots in the callback's first runtime parameter or a whole local alias. */
function inputMemberKeys(
  returned: Expression,
  owner: ArrowFunction | FunctionExpression,
): InputMember | undefined {
  const keys: string[] = [];
  const read = framedGroupByOwnedInput(returned, returned);
  let value = unwrapped(read);
  while (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const name = frameMemberName(value);
    if (
      name === undefined ||
      (isElementAccessExpression(value) && framedMapKey(value.argumentExpression) === undefined)
    )
      return undefined;
    keys.unshift(name);
    value = unwrapped(value.expression);
  }
  if (keys.length === 0) return undefined;
  const original = framedGroupByOwnedInput(value, returned);
  const input = isIdentifier(original) ? parameterMemberKeys(original, owner, keys) : undefined;
  return input === undefined ? undefined : { ...input, read };
}

/** Parameter patterns contribute their original keys, while a type-only leading this takes no slot. */
function parameterMemberKeys(
  name: Identifier,
  owner: ArrowFunction | FunctionExpression,
  keys: readonly string[],
): Omit<InputMember, 'read'> | undefined {
  const selected = frameBindingOf(name);
  if (selected === undefined || !isParameterDeclaration(selected.binding)) return undefined;
  const parameter = selected.binding;
  const parameters = owner.parameters;
  const firstName = parameters[0]?.name;
  const at =
    firstName !== undefined && isIdentifier(firstName) && firstName.text === 'this' ? 1 : 0;
  return parameters[at] === parameter
    ? { parameter, keys: [...selected.keys, ...keys] }
    : undefined;
}

/** Every other runtime input binds a plain name, without a destructuring read or default. */
function plainOtherParameters(
  owner: ArrowFunction | FunctionExpression,
  first: ParameterDeclaration,
): boolean {
  return owner.parameters.every((each) => {
    return (
      each === first ||
      (isIdentifier(each.name) &&
        each.initializer === undefined &&
        each.dotDotDotToken === undefined)
    );
  });
}

/** Every input's first binding pattern reads present own data and iterates only literal arrays. */
function quietBoundMembers(
  parameter: ParameterDeclaration,
  elements: readonly Expression[],
): boolean {
  const pending: BoundSlots[] = [{ name: parameter.name, slots: inputSlots(elements) }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const children = boundChildren(next);
    if (children === undefined) return false;
    pending.push(...children);
  }
  return true;
}

/** Object patterns read literal data containers; array patterns use a literal array's native iterator. */
function boundChildren(next: BoundSlots): readonly BoundSlots[] | undefined {
  if (isIdentifier(next.name)) return [];
  const array = isArrayBindingPattern(next.name);
  if (!array && !isObjectBindingPattern(next.name)) return undefined;
  if (!literalPatternSlots(next.slots, array)) return undefined;
  const found: BoundSlots[] = [];
  for (const [index, field] of next.name.elements.entries()) {
    if (isOmittedExpression(field)) continue;
    const key = array ? String(index) : frameMemberName(field);
    if (
      key === undefined ||
      !isBindingElement(field) ||
      field.name === undefined ||
      field.dotDotDotToken !== undefined ||
      field.initializer !== undefined
    )
      return undefined;
    const slots = next.slots.flatMap((slot) => mapperMemberSlots(slot, key));
    if (slots.some((slot) => typeof slot === 'string')) return undefined;
    found.push({ name: field.name, slots });
  }
  return found;
}

/** Missing or opaque containers cannot establish quiet implicit binding reads. */
function literalPatternSlots(slots: readonly MapperSlot[], array: boolean): boolean {
  return slots.every((slot) => {
    if (typeof slot === 'string') return false;
    return isArrayLiteralExpression(slot) || (!array && isObjectLiteralExpression(slot));
  });
}

/** Exact selected input slots, or every present slot, followed only through literal own data. */
function selectedMembers(
  elements: readonly Expression[],
  index: number | undefined,
  keys: readonly string[],
): Members | undefined {
  const chosen = index === undefined ? elements : elements.slice(index, index + 1);
  let slots = inputSlots(chosen);
  const roots: Expression[] = [];
  for (const key of keys) {
    if (slots.some((slot) => typeof slot === 'string')) return undefined;
    roots.push(...slots.flatMap((slot) => (typeof slot === 'string' ? [] : [slot])));
    slots = slots.flatMap((slot) => mapperMemberSlots(slot, key));
    if (slots.some((slot) => typeof slot === 'string')) return undefined;
  }
  return { values: slots.flatMap((slot) => (typeof slot === 'string' ? [] : [slot])), roots };
}

/** Source holes invoke no callback and every present literal slot retains its lexical value. */
function inputSlots(elements: readonly Expression[]): MapperSlot[] {
  return elements.flatMap((each) => (isOmittedExpression(each) ? [] : mapperSlotValues(each)));
}
