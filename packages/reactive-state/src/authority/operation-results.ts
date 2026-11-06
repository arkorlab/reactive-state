import type { Json } from '../program.ts';
import { MAX_CARRIED_BYTES } from './json-size.ts';

/** An operation's own JSON data, validated while its detached receipt is built. */

const INVALID = Symbol('Invalid operation result');
const MAX_DEPTH = 64;
const MAX_ARRAY_LENGTH = 4_294_967_295;
const NULL_BYTES = 4;

type Snapshot = Json | typeof INVALID;

interface OwnData {
  readonly enumerable: boolean;
  readonly value: unknown;
}

/** What one result's snapshot walks with, from its root on. */
interface Walk {
  /** The objects on the path to the value copied now: one met again among them is a cycle. */
  readonly seen: Set<WeakKey>;
  /**
   * Each object copied once already. One the result holds again — no cycle: shared — is copied again
   * where it stands, as JSON writes it at each place, though the application made it once: of a few
   * arrays, each holding the next twice, the copies would make as many values as two to the power of
   * how many arrays there are. Each copy after the first spends what it makes (`repeated`).
   */
  readonly copied: Set<WeakKey>;
  /**
   * How many values the copy may still make that the application never made: those the copies of
   * objects already copied make — an array's elements, holes among them, an object's entries — and
   * the holes of an array copied the first time, each a `null` of no element, which the application
   * makes as many of as it says at no cost. At first as many as a request carries bytes, which bounds
   * each array's holes as well (`arrayLength`).
   */
  repeated: number;
}

/** Each listed own descriptor is observed once; its data is all the later walk consumes. */
function ownData(value: Exclude<WeakKey, symbol>): ReadonlyMap<string, OwnData> | undefined {
  const entries = new Map<string, OwnData>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    entries.set(key, { enumerable: descriptor.enumerable === true, value: descriptor.value });
  }
  return entries;
}

/** Plain and null-prototype records, excluding native raw JSON text. */
function ordinary(value: Exclude<WeakKey, symbol>): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return false;
  const { isRawJSON } = JSON as { readonly isRawJSON?: (value: unknown) => boolean };
  return isRawJSON?.(value) !== true;
}

/** Canonical indexed own data and a captured length, before any holes are allocated. */
function arrayLength(entries: ReadonlyMap<string, OwnData>): number | undefined {
  const length = entries.get('length')?.value;
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_ARRAY_LENGTH
  )
    return undefined;
  for (const [key, entry] of entries) {
    if (key === 'length') continue;
    const index = Number(key);
    if (
      !entry.enumerable ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= length ||
      String(index) !== key
    )
      return undefined;
  }
  const present = entries.size - 1;
  const minimum = 2 + Math.max(0, length - 1) + present + (length - present) * NULL_BYTES;
  return present !== length && minimum > MAX_CARRIED_BYTES ? undefined : length;
}

/** Whether `values` more values the application never made fit what `walk` has left of them. */
function spent(values: number, walk: Walk): boolean {
  walk.repeated -= values;
  return walk.repeated >= 0;
}

/** Missing and undefined own slots carry null, without any inherited indexed read. */
function arraySnapshot(
  entries: ReadonlyMap<string, OwnData>,
  depth: number,
  walk: Walk,
  again: boolean,
): Snapshot {
  const length = arrayLength(entries);
  const result: Json[] = [];
  // Of a first copy, its holes alone are what the application never made; of a later one, all.
  let valid = length !== undefined && spent(again ? length : length - (entries.size - 1), walk);
  for (let index = 0; valid && index < (length ?? 0); index += 1) {
    const item = entries.get(String(index))?.value;
    const normalized = item === undefined ? null : snapshot(item, depth + 1, walk);
    if (normalized === INVALID) {
      valid = false;
      break;
    }
    result.push(normalized);
  }
  return valid ? result : INVALID;
}

/** Captured enumerable data keeps original key order and own prototype-named keys. */
function objectSnapshot(
  entries: ReadonlyMap<string, OwnData>,
  depth: number,
  walk: Walk,
  again: boolean,
): Snapshot {
  const result: Record<string, Json> = {};
  let valid = !again || spent(entries.size, walk);
  for (const [key, entry] of entries) {
    if (!valid || !entry.enumerable) {
      valid = false;
      break;
    }
    if (entry.value === undefined) continue;
    const normalized = snapshot(entry.value, depth + 1, walk);
    if (normalized === INVALID) {
      valid = false;
      break;
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: normalized,
      writable: true,
    });
  }
  return valid ? result : INVALID;
}

/** Detached object data, with source reflection complete before its captured values are visited. */
function containerSnapshot(value: Exclude<WeakKey, symbol>, depth: number, walk: Walk): Snapshot {
  let result: Snapshot = INVALID;
  const array = Array.isArray(value);
  const entries = array || ordinary(value) ? ownData(value) : undefined;
  if (entries !== undefined) {
    const again = walk.copied.has(value);
    walk.copied.add(value);
    walk.seen.add(value);
    try {
      result = array
        ? arraySnapshot(entries, depth, walk, again)
        : objectSnapshot(entries, depth, walk, again);
    } finally {
      walk.seen.delete(value);
    }
  }
  return result;
}

/** Validated primitives or detached own data; only the current path counts as a cycle. */
function snapshot(value: unknown, depth: number, walk: Walk): Snapshot {
  let result: Snapshot = INVALID;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') result = value;
  else if (typeof value === 'number') result = Number.isFinite(value) ? value + 0 : INVALID;
  else if (typeof value === 'object' && depth < MAX_DEPTH && !walk.seen.has(value))
    result = containerSnapshot(value, depth, walk);
  return result;
}

/**
 * An operation's JSON result in its original key order, or null for no JSON — and for one whose
 * copy would make more values the application never made than a request carries bytes (`Walk`):
 * copies of what it holds more than once, and its arrays' holes, all together as of each array.
 */
export function operationResult(returned: unknown): Json {
  const walk: Walk = { copied: new Set(), repeated: MAX_CARRIED_BYTES, seen: new Set() };
  const result = snapshot(returned, 0, walk);
  return result === INVALID ? null : result;
}
