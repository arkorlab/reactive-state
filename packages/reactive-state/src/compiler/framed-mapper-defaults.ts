import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBindingElement,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isSpreadElement,
  type Node,
  type ParameterDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { frameMemberName } from './framed-bindings.ts';
import { concatSource } from './framed-concat-properties.ts';
import { iteratorCarriedUnexposed } from './framed-iterator-carried.ts';
import { quietMapperCall } from './framed-mapper-quiet.ts';
import {
  mapperMemberSlots,
  mapperSlotAbsent,
  mapperSlotValues,
  type MapperSlot,
} from './framed-mapper-slots.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { bindingIdentifiers } from './scope.ts';

/** Written defaults a native mapper's first parameter applies where its source slot holds no value. */

/** The native call that maps a written receiver, and whether that receiver keeps its written slots. */
export interface MapperDefaultRead {
  readonly receiver: Expression;
  readonly index: number | undefined;
  readonly capture: CallExpression;
  readonly stable: (value: Expression) => boolean;
}

/** One step of a parameter's binding path: its written default and the key to the next step. */
interface BindingLevel {
  readonly initializer: Expression | undefined;
  readonly key: string | undefined;
}

/** A value the bound name may take, read further by its remaining keys. */
export interface DefaultValue {
  readonly value: Expression;
  readonly keys: readonly string[];
}

/**
 * The defaults a returned first parameter, or a name its pattern binds, may take instead of its
 * source slot: each one whose step a quiet literal receiver's selected slot may leave undefined.
 */
export function mapperDefaultViews(
  name: Identifier,
  parameter: ParameterDeclaration,
  read: MapperDefaultRead,
): readonly ArrayElementView[] {
  if (!hasDefaults(name, parameter)) return [];
  const source = concatSource(read.receiver, read.stable, false);
  if (
    source === undefined ||
    !isArrayLiteralExpression(source) ||
    !quietMapperCall(parameter, read.capture, source)
  )
    return [];
  const defaults = parameterDefaults(name, parameter, inputSlots(source, read.index));
  const values = defaults.map(({ value }) => ({ value }));
  if (
    defaults.some(({ value }) => !framedOriginCoowned(value, read.capture)) ||
    !iteratorCarriedUnexposed([source, ...read.capture.arguments], values, read.capture)
  )
    return [];
  return defaults.map((each) => defaultView(each, read.capture));
}

/** Whether a parameter, or the steps binding a name of its pattern, write a default. */
export function hasDefaults(name: Identifier, parameter: ParameterDeclaration): boolean {
  return bindingLevels(name, parameter)?.some((each) => each.initializer !== undefined) === true;
}

/**
 * The defaults a parameter, or a name its pattern binds, takes where the values reaching it, the
 * `slots`, may leave a step undefined, each read on through written literal members.
 */
export function parameterDefaults(
  name: Identifier,
  parameter: ParameterDeclaration,
  slots: readonly MapperSlot[],
): readonly DefaultValue[] {
  const levels = bindingLevels(name, parameter);
  return levels === undefined
    ? []
    : appliedDefaults(slots, levels).flatMap((each) => resolvedDefault(each));
}

/** A rest pattern first selects one native argument, before its ordinary nested defaults apply. */
export function packedParameterDefaults(
  name: Identifier,
  parameter: ParameterDeclaration,
  slotsForKey: (key: string) => readonly MapperSlot[],
): readonly DefaultValue[] {
  const levels = bindingLevels(name, parameter);
  if (levels === undefined) return [];
  const first = levels[0];
  if (first?.key === undefined) return [];
  return appliedDefaults(slotsForKey(first.key), levels.slice(1)).flatMap((each) =>
    resolvedDefault(each),
  );
}

/** A default stands as a written element read further by its remaining keys. */
function defaultView(selected: DefaultValue, capture: CallExpression): ArrayElementView {
  return { value: selected.value, index: undefined, element: true, capture, keys: selected.keys };
}

/** The steps from the parameter to the name it binds, each with its written default. */
function bindingLevels(
  name: Identifier,
  parameter: ParameterDeclaration,
): readonly BindingLevel[] | undefined {
  const bound = bindingIdentifiers(parameter.name).find((each) => each.text === name.text);
  if (bound === undefined) return undefined;
  const levels: BindingLevel[] = [];
  let key: string | undefined;
  for (let node: Node = bound.parent; ;) {
    if (isParameterDeclaration(node)) {
      levels.push({ initializer: node.initializer, key });
      return levels.toReversed();
    }
    if (!isBindingElement(node) || node.dotDotDotToken !== undefined) return undefined;
    levels.push({ initializer: node.initializer, key });
    const pattern = node.parent;
    key = isArrayBindingPattern(pattern)
      ? String(pattern.elements.indexOf(node))
      : frameMemberName(node);
    if (key === undefined) return undefined;
    node = pattern.parent;
  }
}

/** A known slot, or every present one; native map never calls its callback for a written hole. */
function inputSlots(source: ArrayLiteralExpression, index: number | undefined): MapperSlot[] {
  const spread = source.elements.some((each) => isSpreadElement(each));
  if (index === undefined || spread) return source.elements.flatMap((each) => elementSlots(each));
  const element = source.elements[index < 0 ? source.elements.length + index : index];
  return element === undefined ? [] : elementSlots(element);
}

/** A written hole calls no callback; a spread of a written array materializes its holes as undefined. */
function elementSlots(element: Expression): MapperSlot[] {
  if (isOmittedExpression(element)) return [];
  if (!isSpreadElement(element)) return mapperSlotValues(element);
  const spread = unwrapped(element.expression);
  if (!isArrayLiteralExpression(spread)) return ['unknown'];
  return spread.elements.flatMap((each) =>
    isOmittedExpression(each) ? ['absent' as const] : mapperSlotValues(each),
  );
}

/** Each default a step applies where the value reaching it may be undefined, with its remaining keys. */
function appliedDefaults(
  slots: readonly MapperSlot[],
  levels: readonly BindingLevel[],
): readonly DefaultValue[] {
  const found = new Map<Expression, readonly string[]>();
  let states = slots;
  for (const [at, level] of levels.entries()) {
    const next: MapperSlot[] = [];
    for (const state of states) {
      if (state !== 'absent') next.push(state);
      if (level.initializer !== undefined && mapperSlotAbsent(state)) {
        next.push(...mapperSlotValues(level.initializer));
        found.set(level.initializer, keysAfter(levels, at));
      }
    }
    const { key } = level;
    if (key === undefined) break;
    states = next.flatMap((state) => mapperMemberSlots(state, key));
  }
  return [...found].map(([value, keys]) => ({ value, keys }));
}

/** The keys a step's value is read by down to the bound name. */
function keysAfter(levels: readonly BindingLevel[], at: number): readonly string[] {
  return levels.slice(at).flatMap((each) => (each.key === undefined ? [] : [each.key]));
}

/**
 * A default read through written literal members down to the bound name; an undefined member is
 * left to a later step's own default, and an unshown one keeps the literal and its remaining keys.
 */
function resolvedDefault(start: DefaultValue): readonly DefaultValue[] {
  const found: DefaultValue[] = [];
  const pending = [start];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [key, ...rest] = next.keys;
    const value = unwrapped(next.value);
    if (
      key === undefined ||
      (!isArrayLiteralExpression(value) && !isObjectLiteralExpression(value))
    ) {
      found.push(next);
      continue;
    }
    const slots = mapperMemberSlots(value, key);
    if (slots.includes('unknown')) found.push(next);
    for (const slot of slots)
      if (typeof slot !== 'string') pending.push({ value: slot, keys: rest });
  }
  return found;
}
