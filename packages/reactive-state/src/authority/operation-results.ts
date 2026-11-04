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

/** Missing and undefined own slots carry null, without any inherited indexed read. */
function arraySnapshot(
  entries: ReadonlyMap<string, OwnData>,
  depth: number,
  seen: Set<WeakKey>,
): Snapshot {
  const length = arrayLength(entries);
  const result: Json[] = [];
  let valid = length !== undefined;
  for (let index = 0; index < (length ?? 0); index += 1) {
    const item = entries.get(String(index))?.value;
    const normalized = item === undefined ? null : snapshot(item, depth + 1, seen);
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
  seen: Set<WeakKey>,
): Snapshot {
  const result: Record<string, Json> = {};
  let valid = true;
  for (const [key, entry] of entries) {
    if (!entry.enumerable) {
      valid = false;
      break;
    }
    if (entry.value === undefined) continue;
    const normalized = snapshot(entry.value, depth + 1, seen);
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
function containerSnapshot(
  value: Exclude<WeakKey, symbol>,
  depth: number,
  seen: Set<WeakKey>,
): Snapshot {
  let result: Snapshot = INVALID;
  const array = Array.isArray(value);
  const entries = array || ordinary(value) ? ownData(value) : undefined;
  if (entries !== undefined) {
    seen.add(value);
    try {
      result = array ? arraySnapshot(entries, depth, seen) : objectSnapshot(entries, depth, seen);
    } finally {
      seen.delete(value);
    }
  }
  return result;
}

/** Validated primitives or detached own data; only the current path counts as a cycle. */
function snapshot(value: unknown, depth: number, seen: Set<WeakKey>): Snapshot {
  let result: Snapshot = INVALID;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') result = value;
  else if (typeof value === 'number') result = Number.isFinite(value) ? value + 0 : INVALID;
  else if (typeof value === 'object' && depth < MAX_DEPTH && !seen.has(value))
    result = containerSnapshot(value, depth, seen);
  return result;
}

/** An operation's JSON result in its original key order, or null for no JSON. */
export function operationResult(returned: unknown): Json {
  const result = snapshot(returned, 0, new Set());
  return result === INVALID ? null : result;
}
