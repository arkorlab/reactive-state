import {
  type ArrayLiteralExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isComputedPropertyName,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isOmittedExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSetAccessorDeclaration,
  isSpreadAssignment,
  isSpreadElement,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyName,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import type { WrittenArrayElement } from './framed-array-elements.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { type AssignedFrameSource, iteratedFrameSources } from './framed-assignment-patterns.ts';
import { descriptorRewrites } from './framed-descriptor-rewrites.ts';
import { getterElements, getterUnfollowed, getterWrittenValues } from './framed-getter-elements.ts';
import { type HeldWrite, heldMemberWrites, heldValue } from './framed-held-member-writes.ts';
import { framedKeyNames } from './framed-keys.ts';
import { listSource } from './framed-list-sources.ts';
import { mutatorInvocation, PATHS, returnedTargets } from './framed-mutator-calls.ts';
import {
  accessedValues,
  alternativesOf,
  functionReturns,
  prototypeField,
  returnedValues,
} from './framed-mutator-getters.ts';
import { keyMayBeSlot, nameMayBeSlot, possibleKey, slotKey } from './framed-mutator-keys.ts';
import { withNames } from './framed-name-sets.ts';
import {
  type Hidden,
  NOTHING_HIDDEN,
  readUnder,
  readUnderSlot,
  type SlotReads,
} from './framed-seen-reads.ts';
import { selectedValues } from './framed-selected-sources.ts';

/** Native object mutators install the values their written numeric keys carry on an array. */

export interface MutatorElements {
  readonly targets: readonly Expression[];
  readonly elements: readonly WrittenArrayElement[];
}

/**
 * The target of a native object mutator and the values it may install at the selected index: a
 * written numeric key carries its value, an opaque key or source keeps each value possible.
 */
export function objectMutatorElements(
  call: CallExpression,
  index: number | undefined,
): MutatorElements | undefined {
  const invoked = mutatorInvocation(call);
  if (invoked === undefined) return undefined;
  const { path } = invoked;
  const [target, ...rest] = invoked.args;
  if (target === undefined || isSpreadElement(target)) return undefined;
  const reading = freshReading(call);
  const mutated = returnedTargets(target);
  if (path === PATHS.assign)
    return {
      targets: mutated,
      elements: rest.flatMap((source) => assignedValues(source, index, reading)),
    };
  const defined =
    path === PATHS.properties
      ? definedMaps(rest, index, reading)
      : definedProperty(rest, index, reading);
  return { targets: mutated, elements: defined };
}

/**
 * What a read of descriptors goes through: whether a descriptor's inherited fields count, as they
 * do for a descriptor and not for what a spread copies, and the objects a constant holds, which
 * are read once in each way however many times the program names them.
 */
interface Reading {
  /** The call that reads the sources, where the descriptors a constant holds are consumed. */
  readonly at: Node;
  readonly inherited: boolean;
  readonly seen: {
    readonly full: Map<Node, readonly Hidden[]>;
    readonly own: Map<Node, readonly Hidden[]>;
    readonly maps: SlotReads;
    readonly sources: SlotReads;
  };
}

function freshReading(at: Node): Reading {
  return {
    at,
    inherited: true,
    seen: { full: new Map(), own: new Map(), maps: new Map(), sources: new Map() },
  };
}

/**
 * The key and the descriptor of a definition, after its target. A spread the compile cannot read
 * may be empty, so the argument that follows it may be the key or the descriptor, and what it
 * holds is possible beside that.
 */
function definedProperty(
  args: readonly Expression[],
  index: number | undefined,
  reading: Reading,
): WrittenArrayElement[] {
  const [key] = args;
  if (key === undefined) return [];
  if (!isSpreadElement(key) && !keyMayBeSlot(key, index)) return [];
  return descriptorCandidates(args, reading);
}

/**
 * Where a spread may hold the descriptor: at the second place of the arguments, where the key is a
 * written one before it, the first place; a spread the first of those that were written out may be
 * empty, and the key is there, the second place is the descriptor's, and where one before it holds
 * the key alone, the first.
 */
function spreadSlots(written: number, spread: boolean): readonly string[] {
  if (written > 0) return ['0'];
  return spread ? ['0', '1'] : ['1'];
}

/**
 * Every argument that may take the descriptor's position: a spread may be empty, so each argument
 * up to the second written one may be preceded by the key alone.
 */
function descriptorCandidates(
  args: readonly Expression[],
  reading: Reading,
): WrittenArrayElement[] {
  const found: WrittenArrayElement[] = [];
  let written = 0;
  let spread = false;
  for (const argument of args) {
    if (written > 1) break;
    if (isSpreadElement(argument)) {
      for (const slot of spreadSlots(written, spread))
        found.push({ value: argument.expression, keys: [slot, 'value'] });
      spread = true;
    } else {
      if (spread || written === 1) found.push(...descriptorValues(argument, reading));
      written += 1;
    }
  }
  return found;
}

/** The descriptor maps that may take the position after the target: each up to the first written one. */
function definedMaps(
  args: readonly Expression[],
  index: number | undefined,
  reading: Reading,
): WrittenArrayElement[] {
  const found: WrittenArrayElement[] = [];
  for (const map of args) {
    found.push(...definedValues(map, index, reading));
    if (!isSpreadElement(map)) break;
  }
  return found;
}

/** One assign source's values at numeric keys; a getter there answers what it returns. */
function assignedValues(
  source: Expression,
  index: number | undefined,
  reading: Reading,
  hidden: Hidden = NOTHING_HIDDEN,
): WrittenArrayElement[] {
  if (isOmittedExpression(source)) return [];
  if (isSpreadElement(source))
    return iteratedFrameSources(source.expression).map((each) => atSlot(each, index));
  const value = unwrapped(source);
  if (isArrayLiteralExpression(value)) return listSource(value, hidden.data);
  if (!isObjectLiteralExpression(value)) {
    const names: Identifier[] = [];
    const held = heldValue(value, names);
    const alternatives = isObjectLiteralExpression(held) ? [held] : alternativesOf(held);
    const opaque = opaqueSource(source, index);
    const used =
      alternatives === undefined
        ? undefined
        : readUnderSlot(reading.seen.sources, index, held, hidden);
    if (alternatives === undefined) return opaque;
    const written = sourceWrites(names, index, reading, hidden);
    if (used === undefined) return [...opaque, ...written];
    return [
      ...opaque,
      ...alternatives.flatMap((each) => assignedValues(each, index, reading, used)),
      ...written,
    ];
  }
  return sourceFields(value, index, reading, hidden);
}

/** The writes to the members of the constant the names stand for, before the place that reads it. */
function writesTo(names: readonly Identifier[], reading: Reading): readonly HeldWrite[] {
  const [first] = names;
  return first === undefined ? [] : heldMemberWrites(first, names, reading.at);
}

/**
 * The elements the writes to the members of an assign source a constant holds install: a constant
 * does not keep its members from changing, and a write to the key of the slot, or to a key the
 * compile cannot read, before the place that names it, is possible, unless a field after hides it.
 * A rest that copied the source into the member gave it a plain object, which installs nothing.
 */
function sourceWrites(
  names: readonly Identifier[],
  index: number | undefined,
  reading: Reading,
  hidden: Hidden,
): WrittenArrayElement[] {
  return writesTo(names, reading).flatMap(({ key, value, keys, node, copiedAt }) => {
    const hides = key !== undefined && hidden.data.has(key);
    if (copiedAt !== undefined || hides || (key !== undefined && !possibleKey(key, index)))
      return [];
    return selectedValues(value, keys, node);
  });
}

/** The elements the fields of an assign source install, each as the fields after it leave it. */
function sourceFields(
  object: ObjectLiteralExpression,
  index: number | undefined,
  reading: Reading,
  hidden: Hidden,
): WrittenArrayElement[] {
  return fieldsAfter(
    object,
    hidden,
    (property, later) => propertyElements(property, index, reading, later),
    (property, outer, name) => getterElements(property, name, index, outer.data),
  );
}

/**
 * What the fields of a written object read, each as the fields after it leave it: read from the
 * last, a field is skipped where a later one has set its name.
 */
function fieldsAfter(
  object: ObjectLiteralExpression,
  hidden: Hidden,
  read: (property: ObjectLiteralElementLike, later: Hidden) => WrittenArrayElement[],
  effects?: (
    property: ObjectLiteralElementLike,
    outer: Hidden,
    name: string | undefined,
  ) => WrittenArrayElement[],
): WrittenArrayElement[] {
  const found: (readonly WrittenArrayElement[])[] = [];
  const later = { data: new Set(hidden.data), getters: new Set(hidden.getters), own: hidden.own };
  const replacing = new Set<string>();
  for (const property of object.properties.toReversed()) {
    const name = sourceName(property);
    const getter = isGetAccessorDeclaration(property);
    const taken = getter ? later.getters : later.data;
    if (name === undefined || !taken.has(name)) found.push(read(property, later));
    if (effects !== undefined && getter && (name === undefined || !replacing.has(name)))
      found.push(effects(property, hidden, name));
    for (const each of sourceNames(property)) {
      later.data.add(each);
      if (!isSetAccessorDeclaration(property)) {
        later.getters.add(each);
        replacing.add(each);
      }
    }
  }
  return found.toReversed().flat();
}

/**
 * The elements one field of an assign source installs: its value, what its getter returns, and the
 * own entries of a spread, whose getters were read, so a field after it hides them as values.
 */
function propertyElements(
  property: ObjectLiteralElementLike,
  index: number | undefined,
  reading: Reading,
  later: Hidden,
): WrittenArrayElement[] {
  if (isSpreadAssignment(property)) {
    const copied = { data: later.data, getters: later.data };
    return assignedValues(property.expression, index, reading, copied);
  }
  if (!nameMayBeSlot(property.name, index)) return [];
  if (isPropertyAssignment(property)) return [{ value: property.initializer, keys: [] }];
  return isGetAccessorDeclaration(property) ? returnedValues(property.body) : [];
}

/** The name a field of an assign source sets, none for a spread, a name unread, or a prototype. */
function sourceName(property: ObjectLiteralElementLike): string | undefined {
  if (isSpreadAssignment(property)) return undefined;
  const key = writtenArrayKey(property.name);
  if (prototypeField(property, key) !== undefined) return undefined;
  if (key !== undefined || !isComputedPropertyName(property.name)) return key;
  const names = framedKeyNames(property.name.expression);
  return names?.length === 1 ? names[0] : undefined;
}

/** The names a field of an assign source always sets: its own, or those of the literal it spreads. */
function sourceNames(property: ObjectLiteralElementLike): readonly string[] {
  if (!isSpreadAssignment(property)) {
    const name = sourceName(property);
    return name === undefined ? [] : [name];
  }
  const copied = unwrapped(property.expression);
  return isObjectLiteralExpression(copied)
    ? copied.properties.flatMap((each) => sourceNames(each))
    : [];
}

/** What a source holds at the selected slot: the path of the source, then the slot's own. */
function atSlot(source: AssignedFrameSource, index: number | undefined): WrittenArrayElement {
  return { value: source.value, keys: [...source.keys, slotKey(index)] };
}

/**
 * An opaque source's value at the selected slot; at an unknown one, any element it holds as an
 * array or a tuple does.
 */
function opaqueSource(source: Expression, index: number | undefined): WrittenArrayElement[] {
  const selected = { value: source, keys: [slotKey(index)] };
  return index === undefined ? [selected, { value: source, keys: [], array: true }] : [selected];
}

/**
 * A descriptor map's entries at numeric keys, those of a spread or a constant it names read as
 * written; an opaque map keeps its slot's descriptor.
 */
function definedValues(
  descriptors: Expression,
  index: number | undefined,
  reading: Reading,
  hidden: Hidden = NOTHING_HIDDEN,
): WrittenArrayElement[] {
  if (isOmittedExpression(descriptors)) return [];
  const slot = slotKey(index);
  const value = unwrapped(descriptors);
  if (isSpreadElement(descriptors))
    return [{ value: descriptors.expression, keys: ['0', slot, 'value'] }];
  if (isArrayLiteralExpression(value)) return listedDescriptors(value, index, reading, hidden);
  if (!isObjectLiteralExpression(value)) {
    const names: Identifier[] = [];
    const held = heldValue(value, names);
    const opaque = [{ value: descriptors, keys: [slot, 'value'] }];
    const literal = isObjectLiteralExpression(held) || isArrayLiteralExpression(held);
    const alternatives = literal ? [held] : alternativesOf(held);
    const used =
      alternatives === undefined
        ? undefined
        : readUnderSlot(reading.seen.maps, index, held, hidden);
    if (alternatives === undefined) return opaque;
    const written = mapWrites(names, index, reading, hidden);
    if (used === undefined) return [...opaque, ...written];
    return [
      ...opaque,
      ...alternatives.flatMap((each) => definedValues(each, index, reading, used)),
      ...written,
    ];
  }
  return fieldsAfter(
    value,
    hidden,
    (property, later) => mapElements(property, index, reading, later),
    (property, outer, name) => {
      const written = getterWrittenValues(property, name, index, outer.data).flatMap((each) =>
        descriptorValues(each, reading),
      );
      if (!getterUnfollowed(property, name, index) || !isObjectLiteralExpression(property.parent))
        return written;
      return [...written, { value: property.parent, keys: [slotKey(index), 'value'] }];
    },
  );
}

/**
 * The descriptors of a map written as a list: the entry at the slot's position, or, where a
 * spread may shift the positions or the slot is unknown, each entry. A spread hands over each
 * entry of what it spreads, read as a list of descriptors in turn. A field after the list that
 * names a position hides the entry there.
 */
function listedDescriptors(
  list: ArrayLiteralExpression,
  index: number | undefined,
  reading: Reading,
  hidden: Hidden,
): WrittenArrayElement[] {
  let shifted = false;
  return list.elements.flatMap((element, at) => {
    if (isSpreadElement(element)) {
      shifted = true;
      return [
        { value: element.expression, keys: [slotKey(index), 'value'] },
        ...definedValues(element.expression, undefined, reading),
      ];
    }
    if (isOmittedExpression(element)) return [];
    const hides = !shifted && hidden.data.has(String(at));
    const wanted = shifted || index === undefined || at === index;
    return wanted && !hides ? descriptorValues(element, reading) : [];
  });
}

/**
 * The descriptors assigned to the entries of a map a constant holds before the place that names it:
 * a constant does not keep its entries from changing, and the entry of the slot is possible,
 * unless a field after the place hides it.
 */
function mapWrites(
  names: readonly Identifier[],
  index: number | undefined,
  reading: Reading,
  hidden: Hidden,
): WrittenArrayElement[] {
  return writesTo(names, reading).flatMap((write) => {
    const { key, value, keys, without, copiedAt } = write;
    const hides = key !== undefined && hidden.data.has(key);
    if (hides || write.list === true || (key !== undefined && !possibleKey(key, index))) return [];
    const read = copiedAt === undefined ? reading : { ...reading, at: copiedAt, inherited: false };
    return selectedValues(value, keys, write.node).flatMap((each) => {
      if (each.inList === true) return [];
      const omitted = [...(without ?? []), ...(each.without ?? [])];
      const left = { data: new Set(omitted), getters: new Set(omitted) };
      return each.keys.length > 0
        ? [{ value: each.value, keys: [...each.keys, 'value'] }]
        : descriptorValues(each.value, read, left);
    });
  });
}

/**
 * The descriptors one field of a descriptor map defines: its value, what its getter returns, and
 * those of a spread, whose getters were read, so a field after it hides them as values.
 */
function mapElements(
  property: ObjectLiteralElementLike,
  index: number | undefined,
  reading: Reading,
  later: Hidden,
): WrittenArrayElement[] {
  if (isSpreadAssignment(property))
    return definedValues(property.expression, index, reading, {
      data: later.data,
      getters: later.data,
    });
  if (!nameMayBeSlot(property.name, index)) return [];
  if (isPropertyAssignment(property)) return descriptorValues(property.initializer, reading);
  if (!isGetAccessorDeclaration(property)) return [];
  return returnedValues(property.body).flatMap((each) => descriptorValues(each.value, reading));
}

/**
 * A descriptor's written `value` and what its written `get` returns; an opaque one keeps both. A
 * constant's fields may be assigned, and each value assigned to `value` or `get` before the place
 * that names it is possible, whether or not the object was read from another place.
 */
function descriptorValues(
  descriptor: Expression | undefined,
  reading: Reading,
  hidden: Hidden = NOTHING_HIDDEN,
): WrittenArrayElement[] {
  if (descriptor === undefined || isOmittedExpression(descriptor)) return [];
  if (isSpreadElement(descriptor)) return [{ value: descriptor.expression, keys: ['0', 'value'] }];
  const value = unwrapped(descriptor);
  if (isObjectLiteralExpression(value)) return descriptorFields(value, reading, hidden);
  const names: Identifier[] = [];
  const held = heldValue(value, names);
  const opaque = [{ value: descriptor, keys: ['value'] }];
  const table = reading.inherited ? reading.seen.full : reading.seen.own;
  const alternatives = isObjectLiteralExpression(held) ? [held] : alternativesOf(held);
  const used = alternatives === undefined ? undefined : readUnder(table, held, hidden);
  if (alternatives === undefined) return opaque;
  if (used === undefined) return [...opaque, ...descriptorWrites(names, hidden, reading)];
  const chosen = alternatives.flatMap((each) => {
    return isObjectLiteralExpression(each)
      ? descriptorFields(each, reading, used)
      : descriptorValues(each, reading, used);
  });
  return [...opaque, ...chosen, ...descriptorWrites(names, hidden, reading)];
}

/** The values the fields of a written descriptor give, each as the fields after it leave it. */
function descriptorFields(
  object: ObjectLiteralExpression,
  reading: Reading,
  hidden: Hidden,
): WrittenArrayElement[] {
  return [
    ...fieldsAfter(object, hidden, (property, later) => descriptorEntry(property, reading, later)),
    ...descriptorRewrites(object, hidden, !reading.inherited),
  ];
}

/**
 * The name a descriptor's field is written under, a computed one resolved by what its constants
 * and annotations allow. A name that may be `value` or `get` and may be another is none known.
 */
function descriptorKey(name: PropertyName): string | undefined {
  const key = writtenArrayKey(name);
  if (key !== undefined || !isComputedPropertyName(name)) return key;
  const names = framedKeyNames(name.expression);
  if (names === undefined || names.length === 0) return undefined;
  const reads = names.some((each) => each === 'value' || each === 'get');
  return !reads || names.length === 1 ? names[0] : undefined;
}

/** The fields a spread copies, or those a written prototype gives a descriptor to inherit. */
function copiedFields(
  property: ObjectLiteralElementLike,
  reading: Reading,
  later: Hidden,
): WrittenArrayElement[] | undefined {
  if (isSpreadAssignment(property)) {
    const copied = { data: later.data, getters: later.data };
    return descriptorValues(property.expression, { ...reading, inherited: false }, copied);
  }
  const prototype = reading.inherited
    ? prototypeField(property, writtenArrayKey(property.name))
    : undefined;
  if (prototype === undefined) return undefined;
  const own = isObjectLiteralExpression(property.parent)
    ? property.parent.properties.flatMap((each) => sourceNames(each))
    : [];
  const shadowed = {
    data: withNames(later.data, own),
    getters: withNames(later.getters, own),
    own: withNames(later.own ?? new Set<string>(), own),
  };
  return descriptorValues(prototype, reading, shadowed);
}

/**
 * One field of a written descriptor: its `value`, what its `get` returns, the own fields of a
 * spread, the fields of a prototype. A spread copies own fields only, so what it holds inherited
 * from its prototype is lost.
 */
function descriptorEntry(
  property: ObjectLiteralElementLike,
  reading: Reading,
  later: Hidden,
): WrittenArrayElement[] {
  const copied = copiedFields(property, reading, later);
  if (copied !== undefined) return copied;
  if (isSpreadAssignment(property)) return [];
  const key = descriptorKey(property.name);
  if (key !== undefined && key !== 'value' && key !== 'get') return [];
  const found: WrittenArrayElement[] = [];
  if (key !== 'get' && isPropertyAssignment(property))
    found.push({ value: property.initializer, keys: [] });
  else if (
    key === 'value' &&
    isShorthandPropertyAssignment(property) &&
    isIdentifier(property.name)
  )
    found.push({ value: property.name, keys: [] });
  else if (key !== 'value' && isMethodDeclaration(property) && !answersLater(property))
    found.push(...returnedValues(property.body));
  if (key !== 'value' && isPropertyAssignment(property))
    found.push(...functionReturns(property.initializer, new Set(), selectedValues));
  if (key !== 'value' && isShorthandPropertyAssignment(property) && isIdentifier(property.name))
    found.push(...functionReturns(property.name, new Set(), selectedValues));
  return isGetAccessorDeclaration(property) ? [...found, ...accessedValues(property, key)] : found;
}

/**
 * The values assigned to the `value` and `get` fields of an object a constant holds, or of what it
 * is aliased to: a constant does not keep its fields from changing. An assignment anywhere counts.
 */
function descriptorWrites(
  names: readonly Identifier[],
  hidden: Hidden,
  reading: Reading,
): WrittenArrayElement[] {
  return writesTo(names, reading).flatMap(({ key, value, keys, list, node, copiedAt }) => {
    if (copiedAt !== undefined || (key !== undefined && hidden.data.has(key))) return [];
    return selectedValues(value, keys, node).flatMap((each) => {
      const installed = key === undefined || key === 'value' ? [each] : [];
      const calls = key === undefined || key === 'get';
      const callable = list !== true && each.inList !== true && each.keys.length === 0;
      const returned =
        calls && callable ? functionReturns(each.value, new Set(), selectedValues) : [];
      return [...installed, ...returned];
    });
  });
}
