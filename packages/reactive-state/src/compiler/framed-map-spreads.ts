import {
  type ArrayLiteralExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isIdentifier,
  isNewExpression,
  isOmittedExpression,
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
import { frameBindingOf, type FrameBinding } from './framed-bindings.ts';
import { immediateSelection, quietErrorConstruction } from './framed-copy-guards.ts';
import { iteratorPrefixQuiet, iteratorQuietValues } from './framed-iterator-guards.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedMapKey } from './framed-map-keys.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedOriginPrefix } from './framed-origin-prefix.ts';
import { setCarriedUnexposed } from './framed-set-carried.ts';
import { setIdentity } from './framed-set-positions.ts';
import { framedNativeConstructor } from './framed-sources.ts';

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

/**
 * The key or value slot a fresh native Map spread supplies at a known result position of an
 * immediately selected array literal whose other elements are quiet; none before the spread's
 * offset, and none for a whole entry, an array no member read of which is an Error.
 */
export function mapSpreadViews(
  spread: SpreadElement,
  array: ArrayLiteralExpression,
  position: number,
  keys: readonly string[],
): readonly ArrayElementView[] | undefined {
  const offset = array.elements.indexOf(spread);
  const others = array.elements.filter((each) => each !== spread && !isOmittedExpression(each));
  if (
    offset === -1 ||
    others.some((each) => isSpreadElement(each)) ||
    !iteratorQuietValues(others) ||
    !immediateSelection(array)
  )
    return undefined;
  const source = mapSource(spread.expression, array);
  const entries = source === undefined ? undefined : distinctEntries(source.entries, array);
  if (source === undefined || entries === undefined) return undefined;
  const [slot, ...rest] = keys;
  const entry = position < offset ? undefined : entries[position - offset];
  if (entry === undefined || slot === undefined || !SLOTS.has(slot)) return [];
  const value = slot === '0' ? entry.key : entry.value;
  if (value === undefined) return [];
  return framedOriginCoowned(value, array) && setCarriedUnexposed(source.roots, [{ value }], array)
    ? [{ value, index: undefined, element: true, keys: rest }]
    : undefined;
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
  let value = unwrapped(expression);
  while (isIdentifier(value)) {
    const initializer = constantInitializer(value, bindings);
    if (initializer === undefined) return undefined;
    value = unwrapped(initializer);
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
