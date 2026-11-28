import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isVariableDeclaration,
  isVariableDeclarationList,
  type NewExpression,
  type SpreadElement,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { executionOwner } from './framed-array-mutations.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedIterationInstalled } from './framed-collection-prototypes.ts';
import { immediateSelection, quietErrorConstruction } from './framed-copy-guards.ts';
import {
  type DeclaredCollection,
  framedCollectionDeclared,
  framedDeclaredAdmitted,
} from './framed-declared-collections.ts';
import { framedIterationWritten } from './framed-iteration-writes.ts';
import {
  DEFAULT_ITERATOR,
  iteratorPrefixQuiet,
  iteratorQuietValues,
} from './framed-iterator-guards.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import { framedReplacedIteration } from './framed-own-iterations.ts';
import { framedQuietOperand } from './framed-quiet-operands.ts';
import { setCarriedUnexposed } from './framed-set-carried.ts';
import { setIdentity } from './framed-set-positions.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedUnreadInput } from './framed-unread-inputs.ts';

/**
 * A native Map spread into an array literal yields one `[key, value]` entry per distinct key, in
 * first-insertion order, each holding the last value written for its key.
 */

const MAPS = new Set(['Map']);
const SLOTS = new Set(['0', '1']);

interface MapEntry {
  readonly key: Expression;
  readonly value: Expression | undefined;
}

interface MapSource {
  readonly entries: readonly MapEntry[];
  readonly roots: readonly Expression[];
}

interface MapSpread {
  readonly spread: SpreadElement;
  readonly array: ArrayLiteralExpression;
  readonly position: number | undefined;
  readonly keys: readonly string[];
}

/**
 * The key or value slot a fresh native Map spread supplies at a known result position of an
 * immediately selected array literal whose other elements are quiet; none before the spread's
 * offset, and none for a whole entry, an array no member read of which is an Error. A spread may
 * iterate the Map's `values()`, `keys()` or `entries()`. A Map given an input the compile cannot
 * read may hold an Error in a slot at any position, known or not (`unreadViews`).
 */
export function mapSpreadViews(
  spread: SpreadElement,
  array: ArrayLiteralExpression,
  position: number | undefined,
  keys: readonly string[],
): readonly ArrayElementView[] | undefined {
  const iterated = iteratedMap(spread.expression);
  const at = { spread, array, position, keys };
  return (
    replacedViews(at, iterated) ??
    rewrittenViews(at, iterated) ??
    writtenViews(at, iterated) ??
    unreadViews(iterated, keys)
  );
}

/**
 * What the spread yields where the statement right before it replaces the iterated method on a
 * name a native Map is read through, as the replacement reads (`framedReplacedIteration`).
 */
function replacedViews(
  at: MapSpread,
  iterated: IteratedMap,
): readonly ArrayElementView[] | undefined {
  const bindings = new Set<FrameBinding>();
  const construction = constantValue(iterated.receiver, bindings);
  if (
    construction === undefined ||
    !isNewExpression(construction) ||
    !framedNativeConstructor(construction.expression, MAPS)
  )
    return undefined;
  const offset = at.array.elements.indexOf(at.spread);
  const shifted = at.array.elements.slice(0, offset).some((each) => isSpreadElement(each));
  const index = shifted || at.position === undefined ? undefined : at.position - offset;
  return framedReplacedIteration(bindings, iterated.method, at.spread, { index, keys: at.keys });
}

/** The slot a Map made of written entries in the reader's owner supplies at the position. */
function writtenViews(
  at: MapSpread,
  iterated: IteratedMap,
): readonly ArrayElementView[] | undefined {
  const { spread, array, position, keys } = at;
  const offset = array.elements.indexOf(spread);
  const others = array.elements.filter((each) => each !== spread && !isOmittedExpression(each));
  if (
    position === undefined ||
    offset === -1 ||
    others.some((each) => isSpreadElement(each)) ||
    !iteratorQuietValues(others) ||
    !immediateSelection(array)
  )
    return undefined;
  const source = mapSource(iterated.receiver, array);
  const entries = source === undefined ? undefined : distinctEntries(source.entries, array);
  if (source === undefined || entries === undefined) return undefined;
  const [slot, ...rest] = iterated.slot === undefined ? keys : [iterated.slot, ...keys];
  const entry = position < offset ? undefined : entries[position - offset];
  if (entry === undefined || slot === undefined || !SLOTS.has(slot)) return [];
  const value = slot === '0' ? entry.key : entry.value;
  if (value === undefined) return [];
  return framedOriginCoowned(value, array) && setCarriedUnexposed(source.roots, [{ value }], array)
    ? [{ value, index: undefined, element: true, keys: rest }]
    : undefined;
}

/**
 * The Map a spread iterates, the method it calls, and the slot of each entry it yields: `values()`,
 * `keys()`, all.
 */
interface IteratedMap {
  readonly receiver: Expression;
  readonly method: string;
  readonly slot: '0' | '1' | undefined;
}

/**
 * What a spread iterates: a Map's `values()`, which yield each entry's value, `keys()`, each key,
 * or `entries()` and the Map itself, each whole entry.
 */
function iteratedMap(expression: Expression): IteratedMap {
  const value = framedQuietOperand(expression);
  const callee =
    isCallExpression(value) && value.arguments.length === 0 ? value.expression : undefined;
  const member = callee === undefined ? undefined : unwrapped(callee);
  if (
    member === undefined ||
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member))
  )
    return { receiver: expression, method: DEFAULT_ITERATOR, slot: undefined };
  const name = frameMemberName(member);
  if (name === 'values') return { receiver: member.expression, method: name, slot: '1' };
  if (name === 'keys') return { receiver: member.expression, method: name, slot: '0' };
  return name === 'entries'
    ? { receiver: member.expression, method: name, slot: undefined }
    : { receiver: expression, method: DEFAULT_ITERATOR, slot: undefined };
}

/**
 * A native Map whose iteration something may replace before the spread, on it
 * (`framedIterationWritten`) or on its prototype (`framedIterationInstalled`), yields what the
 * reader cannot read: anything, where no type is declared, and otherwise what may
 * be an Error where the declared type admits one at the read keys (`admittedViews`), beside what
 * its native entries may yield, which a replacement never takes away.
 */
function rewrittenViews(
  at: MapSpread,
  iterated: IteratedMap,
): readonly ArrayElementView[] | undefined {
  const bindings = new Set<FrameBinding>();
  const construction = constantValue(iterated.receiver, bindings);
  if (
    construction === undefined ||
    !isNewExpression(construction) ||
    !framedNativeConstructor(construction.expression, MAPS) ||
    !(
      framedIterationWritten(bindings, at.spread) ||
      framedIterationInstalled(at.spread.getSourceFile(), 'Map')
    )
  )
    return undefined;
  // The native entries stay possible: what a replacement may yield only adds to them.
  const native = writtenViews(at, iterated) ?? unreadViews(iterated, at.keys) ?? [];
  const unread = { value: iterated.receiver, index: undefined, element: true, unread: true };
  if (!framedCollectionDeclared(declaredMap(construction, bindings), 'Map'))
    return [...native, { ...unread, keys: at.keys }];
  return [...native, ...(admittedViews(iterated, construction, bindings, at.keys) ?? [])];
}

/**
 * A native Map given an input the compile cannot read (`framedUnreadInput`) yields keys or values
 * that may be Errors where its declared type admits one at the read keys (`admittedViews`).
 */
function unreadViews(
  iterated: IteratedMap,
  keys: readonly string[],
): readonly ArrayElementView[] | undefined {
  const bindings = new Set<FrameBinding>();
  const construction = constantValue(iterated.receiver, bindings);
  if (
    construction === undefined ||
    !isNewExpression(construction) ||
    !framedNativeConstructor(construction.expression, MAPS)
  )
    return undefined;
  const input = construction.arguments?.[0];
  if (input === undefined || !framedUnreadInput(input, true)) return undefined;
  return admittedViews(iterated, construction, bindings, keys);
}

/**
 * The key or value slot that may be an Error where the Map's declared type admits one at the read
 * keys (`framedDeclaredAdmitted`): the construction's own arguments, else the annotation of a name
 * it is read through, past local aliases. A whole entry is an array.
 */
function admittedViews(
  iterated: IteratedMap,
  construction: NewExpression,
  bindings: ReadonlySet<FrameBinding>,
  keys: readonly string[],
): readonly ArrayElementView[] | undefined {
  const [slot, ...rest] = iterated.slot === undefined ? keys : [iterated.slot, ...keys];
  if (slot !== '0' && slot !== '1') return undefined;
  const declared = declaredMap(construction, bindings);
  return framedDeclaredAdmitted(declared, 'Map', Number(slot), rest)
    ? [{ value: iterated.receiver, index: undefined, element: true, keys, unread: true }]
    : undefined;
}

/** A Map's own type arguments and the annotation of a name it is read through. */
function declaredMap(
  construction: NewExpression,
  bindings: ReadonlySet<FrameBinding>,
): DeclaredCollection {
  const annotation = [...bindings].find((binding) => binding.type !== undefined)?.type;
  return { written: construction.typeArguments, annotation };
}

/** A fresh native Map of written entries, through whole const aliases, made quietly in the reader's owner. */
function mapSource(expression: Expression, array: ArrayLiteralExpression): MapSource | undefined {
  const bindings = new Set<FrameBinding>();
  const construction = constantValue(expression, bindings);
  if (
    construction === undefined ||
    !isNewExpression(construction) ||
    !framedNativeConstructor(construction.expression, MAPS) ||
    executionOwner(construction) !== executionOwner(array) ||
    !framedOriginPrefix(construction) ||
    !iteratorPrefixQuiet(construction, expression) ||
    argumentArrayExposed(expression, bindings, undefined, false)
  )
    return undefined;
  const prefix = framedArgumentPrefix(construction, construction.arguments ?? [], Infinity);
  const [input, ...rest] = prefix.values;
  if (prefix.unknown || prefix.alternatives !== undefined || !iteratorQuietValues(rest))
    return undefined;
  const entries = input === undefined ? [] : writtenEntries(input, construction);
  return entries === undefined
    ? undefined
    : { entries, roots: [...rest, ...entries.flatMap((entry) => entryValues(entry))] };
}

/** The entries a written input array holds, each a literal pair of quiet values. */
function writtenEntries(input: Expression, construction: NewExpression): MapEntry[] | undefined {
  const key = framedMapKey(input);
  if (key === 'null' || key === 'undefined') return [];
  const bindings = new Set<FrameBinding>();
  const literal = constantValue(input, bindings);
  if (
    literal === undefined ||
    !isArrayLiteralExpression(literal) ||
    argumentArrayExposed(input, bindings, undefined, false)
  )
    return undefined;
  const entries: MapEntry[] = [];
  for (const element of literal.elements) {
    const pair = unwrapped(element);
    if (!isArrayLiteralExpression(pair)) return undefined;
    const [first, second] = pair.elements;
    if (
      first === undefined ||
      pair.elements.some((each) => isSpreadElement(each) || isOmittedExpression(each))
    )
      return undefined;
    entries.push({ key: first, value: second });
  }
  return entries.flatMap((entry) => entryValues(entry)).every((value) => quietValue(value)) &&
    iteratorPrefixQuiet(literal, construction)
    ? entries
    : undefined;
}

/** The distinct entries in first-insertion order, each with its last written value. */
function distinctEntries(
  entries: readonly MapEntry[],
  read: Expression,
): readonly MapEntry[] | undefined {
  const distinct = new Map<string, MapEntry>();
  let uncertain: string | undefined;
  for (const entry of entries) {
    const identity = setIdentity(entry.key, read);
    if (identity === undefined) return undefined;
    // Two supplied objects may be one key; their positions and values are then not shown.
    if (uncertain !== undefined && identity.uncertain && uncertain !== identity.key)
      return undefined;
    if (identity.uncertain) uncertain = identity.key;
    const first = distinct.get(identity.key);
    distinct.set(identity.key, { key: first?.key ?? entry.key, value: entry.value });
  }
  return [...distinct.values()];
}

/** An entry's written key and value. */
function entryValues(entry: MapEntry): readonly Expression[] {
  return entry.value === undefined ? [entry.key] : [entry.key, entry.value];
}

/** Literals, reads and quiet native Error constructions run no application code. */
function quietValue(value: Expression): boolean {
  return iteratorQuietValues([value]) || quietErrorConstruction(unwrapped(value));
}

/** The value a whole const alias chain holds. */
function constantValue(
  expression: Expression,
  bindings: Set<FrameBinding>,
): Expression | undefined {
  let value = framedQuietOperand(expression);
  while (isIdentifier(value)) {
    const initializer = constantInitializer(value, bindings);
    if (initializer === undefined) return undefined;
    value = framedQuietOperand(initializer);
  }
  return value;
}

/** A whole const binding's initializer, not followed twice. */
function constantInitializer(
  name: Identifier,
  bindings: Set<FrameBinding>,
): Expression | undefined {
  const selected = frameBindingOf(name);
  const binding = selected?.binding;
  if (
    binding === undefined ||
    selected?.keys.length !== 0 ||
    bindings.has(binding) ||
    !isVariableDeclaration(binding) ||
    !isVariableDeclarationList(binding.parent) ||
    !/^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
  )
    return undefined;
  bindings.add(binding);
  return binding.initializer;
}
