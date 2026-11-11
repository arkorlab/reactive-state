import {
  type Block,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isCallExpression,
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
import { globalPathOf } from './code-globals.ts';
import type { WrittenArrayElement } from './framed-array-elements.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { heldMemberWrites, heldValue } from './framed-held-member-writes.ts';
import { framedKeyNames } from './framed-keys.ts';
import { mutatorInvocation, PATHS, writtenArguments } from './framed-mutator-calls.ts';
import { functionReturns, alternativesOf, returnedValues } from './framed-mutator-getters.ts';
import { keyMayBeSlot, nameMayBeSlot, slotKey } from './framed-mutator-keys.ts';

/** Native object mutators install the values their written numeric keys carry on an array. */

export interface MutatorElements {
  readonly target: Expression;
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
  const reading = freshReading();
  const mutated = returnedTarget(target);
  if (path === PATHS.assign)
    return {
      target: mutated,
      elements: rest.flatMap((source) => assignedValues(source, index, reading)),
    };
  const defined =
    path === PATHS.properties
      ? definedMaps(rest, index, reading)
      : definedProperty(rest, index, reading);
  return { target: mutated, elements: defined };
}

/** The natives that hand back the object they were given first. */
const RETURNS_TARGET: ReadonlySet<string> = new Set([
  'Object.freeze',
  'Object.preventExtensions',
  'Object.seal',
  'Object.setPrototypeOf',
  PATHS.assign,
  PATHS.properties,
  PATHS.property,
]);

/**
 * The object a mutation reaches through the natives that return their first argument:
 * Object.assign(Object.assign(a, {}), ...) mutates a.
 */
function returnedTarget(target: Expression): Expression {
  let at = target;
  for (;;) {
    const inner = unwrapped(at);
    if (!isCallExpression(inner)) return at;
    const path = globalPathOf(unwrapped(inner.expression))?.join('.');
    const [first] = writtenArguments(inner);
    if (path === undefined || !RETURNS_TARGET.has(path)) return at;
    if (first === undefined || isSpreadElement(first)) return at;
    at = first;
  }
}

/**
 * What a read of descriptors goes through: whether a descriptor's inherited fields count, as they
 * do for a descriptor and not for what a spread copies, and the objects a constant holds, which
 * are read once in each way however many times the program names them.
 */
interface Reading {
  readonly inherited: boolean;
  readonly seen: {
    readonly full: Map<Node, readonly Hidden[]>;
    readonly own: Map<Node, readonly Hidden[]>;
    readonly maps: Map<Node, readonly Hidden[]>;
    readonly sources: Map<Node, readonly Hidden[]>;
  };
}

function freshReading(): Reading {
  return {
    inherited: true,
    seen: { full: new Map(), own: new Map(), maps: new Map(), sources: new Map() },
  };
}

/** No name hidden: the state a read of a source starts from. */
const NOTHING_HIDDEN: Hidden = { data: new Set(), getters: new Set() };

/** How many reads of one object are kept apart: past it, one read under nothing hidden covers all. */
const READS = { kept: 4 } as const;

/**
 * The names to read an object under, none where it has already been read under names hidden no
 * more than now: a read under fewer hidden names reads everything a read under more would. Past a
 * few reads kept apart the object is read once under nothing hidden, which covers every other.
 */
function readUnder(
  table: Map<Node, readonly Hidden[]>,
  held: Node,
  hidden: Hidden,
): Hidden | undefined {
  const earlier = table.get(held) ?? [];
  const covered = earlier.some(
    (each) => isSubset(each.data, hidden.data) && isSubset(each.getters, hidden.getters),
  );
  if (covered) return undefined;
  const used = earlier.length >= READS.kept ? NOTHING_HIDDEN : hidden;
  table.set(held, [...earlier, { data: new Set(used.data), getters: new Set(used.getters) }]);
  return used;
}

function isSubset(small: ReadonlySet<string>, large: ReadonlySet<string>): boolean {
  for (const each of small) if (!large.has(each)) return false;
  return true;
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
      const keys = [written === 0 && !spread ? '1' : '0', 'value'];
      found.push({ value: argument.expression, keys });
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
  if (isSpreadElement(source)) return [{ value: source.expression, keys: ['0', slotKey(index)] }];
  const value = unwrapped(source);
  if (isArrayLiteralExpression(value)) return [{ value, keys: [], array: true }];
  if (!isObjectLiteralExpression(value)) {
    const held = heldValue(value);
    const alternatives = isObjectLiteralExpression(held) ? [held] : alternativesOf(held);
    const opaque = opaqueSource(source, index);
    const used =
      alternatives === undefined ? undefined : readUnder(reading.seen.sources, held, hidden);
    if (alternatives === undefined || used === undefined) return opaque;
    return [
      ...opaque,
      ...alternatives.flatMap((each) => assignedValues(each, index, reading, used)),
    ];
  }
  return sourceFields(value, index, reading, hidden);
}

/** The elements the fields of an assign source install, each as the fields after it leave it. */
function sourceFields(
  object: ObjectLiteralExpression,
  index: number | undefined,
  reading: Reading,
  hidden: Hidden,
): WrittenArrayElement[] {
  return fieldsAfter(object, hidden, (property, later) =>
    propertyElements(property, index, reading, later),
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
): WrittenArrayElement[] {
  const found: (readonly WrittenArrayElement[])[] = [];
  const later = { data: new Set(hidden.data), getters: new Set(hidden.getters) };
  for (const property of object.properties.toReversed()) {
    const name = sourceName(property);
    const taken = isGetAccessorDeclaration(property) ? later.getters : later.data;
    if (name === undefined || !taken.has(name)) found.push(read(property, later));
    for (const each of sourceNames(property)) {
      later.data.add(each);
      if (!isSetAccessorDeclaration(property)) later.getters.add(each);
    }
  }
  return found.toReversed().flat();
}

/**
 * The names the fields after one have set: a setter after a getter completes its accessor, and a
 * setter hides a value written before it; every other field hides both.
 */
interface Hidden {
  readonly data: ReadonlySet<string>;
  readonly getters: ReadonlySet<string>;
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
  if (!isObjectLiteralExpression(value)) {
    const held = heldValue(value);
    const opaque = [{ value: descriptors, keys: [slot, 'value'] }];
    const alternatives = isObjectLiteralExpression(held) ? [held] : alternativesOf(held);
    const used =
      alternatives === undefined ? undefined : readUnder(reading.seen.maps, held, hidden);
    if (alternatives === undefined || used === undefined) return opaque;
    return [
      ...opaque,
      ...alternatives.flatMap((each) => definedValues(each, index, reading, used)),
    ];
  }
  return fieldsAfter(value, hidden, (property, later) =>
    mapElements(property, index, reading, later),
  );
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
 * constant's fields may be assigned, and each value assigned to `value` or `get` is possible.
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
  if (alternatives === undefined || used === undefined) return opaque;
  const chosen = alternatives.flatMap((each) => {
    return isObjectLiteralExpression(each)
      ? descriptorFields(each, reading, used)
      : descriptorValues(each, reading, used);
  });
  return [...opaque, ...chosen, ...descriptorWrites(names)];
}

/** The values the fields of a written descriptor give, each as the fields after it leave it. */
function descriptorFields(
  object: ObjectLiteralExpression,
  reading: Reading,
  hidden: Hidden,
): WrittenArrayElement[] {
  return fieldsAfter(object, hidden, (property, later) =>
    descriptorEntry(property, reading, later),
  );
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
  const shadowed = { data: withNames(later.data, own), getters: withNames(later.getters, own) };
  return descriptorValues(prototype, reading, shadowed);
}

/** The names of a set, and more. */
function withNames(names: ReadonlySet<string>, more: readonly string[]): Set<string> {
  const merged = new Set(names);
  for (const each of more) merged.add(each);
  return merged;
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
    found.push(...functionReturns(property.initializer));
  if (key !== 'value' && isShorthandPropertyAssignment(property) && isIdentifier(property.name))
    found.push(...functionReturns(property.name));
  return isGetAccessorDeclaration(property) ? [...found, ...accessedValues(property, key)] : found;
}

/** The object a written `__proto__: object` field sets as the prototype, whose fields are inherited. */
function prototypeField(
  property: ObjectLiteralElementLike,
  key: string | undefined,
): Expression | undefined {
  const written = key === '__proto__' && isPropertyAssignment(property);
  return written && !isComputedPropertyName(property.name) ? property.initializer : undefined;
}

/** A descriptor field written as an accessor: its `value`, or the getter its `get` hands over. */
function accessedValues(
  property: ObjectLiteralElementLike & { readonly body?: Block | undefined },
  key: string | undefined,
): WrittenArrayElement[] {
  const returned = returnedValues(property.body);
  const getters = key === 'value' ? [] : returned.flatMap((each) => functionReturns(each.value));
  return key === 'get' ? getters : [...returned, ...getters];
}

/**
 * The values assigned to the `value` and `get` fields of an object a constant holds, or of what it
 * is aliased to: a constant does not keep its fields from changing. An assignment anywhere counts.
 */
function descriptorWrites(names: readonly Identifier[]): WrittenArrayElement[] {
  const [first] = names;
  if (first === undefined) return [];
  return heldMemberWrites(first, names).flatMap(({ key, value }) => {
    const installed = key === undefined || key === 'value' ? [{ value, keys: [] }] : [];
    return key === undefined || key === 'get'
      ? [...installed, ...functionReturns(value)]
      : installed;
  });
}
