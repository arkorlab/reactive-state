import { createHash } from 'node:crypto';

import type { Json } from '../program.ts';
import { MAX_CARRIED_BYTES } from './json-size.ts';

/**
 * The one way the authority writes a value down to compare it: JSON, each object's keys sorted and
 * a property that holds `undefined` left out, so two values that are the same JSON are the same
 * text however their objects were built — by the application's code, by `JSON.parse` of an HTTP
 * body, or by a Durable Object's RPC, which keeps no property order of its own. A component's props
 * are keyed by it, and every digest the authority makes is of it.
 */

/** How deeply a JSON value may nest: deeper is refused, as a cycle is. */
const MAX_DEPTH = 64;

/**
 * The bytes JSON writes for a hole, `null`: one missing element occupies four bytes plus its comma.
 * A Durable Object's RPC can carry an array as long as its length without allocating the elements.
 */
const NULL_BYTES = 4;

/** The length of a short digest: 128 bits, which no two values of one application share. */
const SHORT_DIGEST = 32;

function isPlainObject(value: WeakKey): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Whether the own entry `name` of `value` is one JSON writes as it is: enumerated, of a value — not
 * computed by an accessor, which may answer otherwise each time it is read.
 */
function isWrittenAsIs(value: WeakKey, name: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor?.enumerable === true && 'value' in descriptor;
}

/**
 * Whether an object holds what JSON writes otherwise than its entries: an entry it does not
 * enumerate, which JSON leaves out; one an accessor computes, which the authority would read again
 * as it writes it; or raw JSON text (`JSON.rawJSON`), which JSON writes as the text it holds —
 * copied, any would be another value.
 */
function writesOtherwise(value: WeakKey): boolean {
  if (Object.getOwnPropertyNames(value).some((name) => !isWrittenAsIs(value, name))) {
    return true;
  }
  const { isRawJSON } = JSON as { readonly isRawJSON?: (value: unknown) => boolean };
  return isRawJSON?.(value) === true;
}

/**
 * Whether an array holds what JSON writes otherwise than its elements: an entry of a name of its own
 * beside them and its length, which JSON leaves out — `extra` of `Object.assign([1], { extra: 'x' })`
 * — an element an accessor computes, or, but where `holes` takes them, a hole, which JSON writes as
 * `null`: `Array(1)` — and one whose holes alone take more JSON than a request may carry.
 */
function arrayWritesOtherwise(value: readonly unknown[], holes: boolean): boolean {
  const names = Object.getOwnPropertyNames(value);
  const beside = names.some((name) => {
    const index = Number(name);
    const isElement =
      Number.isSafeInteger(index) && index >= 0 && index < value.length && String(index) === name;
    return name !== 'length' && !(isElement && isWrittenAsIs(value, name));
  });
  // Of its length and an element of each index below it alone, as many names as it is long, and one.
  const sparse = names.length !== value.length + 1;
  const present = names.length - 1;
  const minimum =
    2 + Math.max(0, value.length - 1) + present + (value.length - present) * NULL_BYTES;
  return beside || (sparse && (!holes || minimum > MAX_CARRIED_BYTES));
}

/** How `jsonWithin` reads a value: what holds it, and whether it takes a hole of an array. */
interface Walk {
  readonly seen: Set<WeakKey>;
  /** Whether a hole of an array is taken, which JSON carries as `null` (`isCarriedJson`). */
  readonly holes: boolean;
  /**
   * Each object already read as JSON in this walk, by the deepest it was read at. An object the value
   * holds more than once — no cycle: shared — is read again only where it stands deeper, and fits a
   * shallower place as it fits that one, so a small graph of shared objects, as a structured clone
   * carries one, takes work of its objects and depths rather than of the JSON it writes.
   */
  readonly read: Map<WeakKey, number>;
}

/** An array's own data slots, without consulting its prototype for holes or traversal methods. */
function arrayJsonWithin(value: readonly unknown[], depth: number, walk: Walk): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (entry === undefined) {
      continue;
    }
    if (!('value' in entry)) {
      return false;
    }
    const item: unknown = entry.value;
    if (item === undefined && walk.holes) {
      continue;
    }
    if (!jsonWithin(item, depth + 1, walk)) {
      return false;
    }
  }
  return true;
}

function jsonWithin(value: unknown, depth: number, walk: Walk): boolean {
  if (typeof value === 'boolean' || typeof value === 'string' || value === null) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object') {
    return false;
  }
  if (
    depth >= MAX_DEPTH ||
    walk.seen.has(value) ||
    !(Array.isArray(value) || isPlainObject(value))
  ) {
    return false;
  }
  if ((walk.read.get(value) ?? -1) >= depth) {
    return true;
  }
  // An entry a symbol keys, which no JSON holds: copied without it, the value would be another.
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }
  if (Array.isArray(value) ? arrayWritesOtherwise(value, walk.holes) : writesOtherwise(value)) {
    return false;
  }
  walk.seen.add(value);
  const json = Array.isArray(value)
    ? arrayJsonWithin(value, depth, walk)
    : Object.values(value).every((item) => item === undefined || jsonWithin(item, depth + 1, walk));
  walk.seen.delete(value);
  if (json) {
    walk.read.set(value, depth);
  }
  return json;
}

/**
 * Whether `value` is JSON: text, a finite number, a boolean, `null`, an array of JSON — an element
 * at each index, no hole, which JSON would write otherwise, `null` — or a plain object of it — a
 * property holding `undefined` is one JSON leaves out — nested no deeper than 64 and with no cycle.
 */
export function isJson(value: unknown): value is Json {
  return jsonWithin(value, 0, { holes: false, read: new Map(), seen: new Set() });
}

/**
 * Whether `value` is JSON as JSON carries it, a hole of an array too, which it writes as `null`
 * (`carried`): what crosses to the authority — a request's props, a view's inputs, an operation's
 * arguments — which a Durable Object's RPC carries with its holes and HTTP as `null`, read alike;
 * and what an element's prop, an action's bound arguments or an operation's result hold, which
 * reach the page as JSON alone, as React carries them.
 */
export function isCarriedJson(value: unknown): value is Json {
  return jsonWithin(value, 0, { holes: true, read: new Map(), seen: new Set() });
}

function written(value: unknown, out: string[]): void {
  if (typeof value !== 'object' || value === null) {
    // `undefined` in an array, as JSON writes it.
    out.push(value === undefined ? 'null' : JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    out.push('[');
    const length = value.length;
    for (let index = 0; index < length; index += 1) {
      // Validation already checked own data slots; inherited traversal and indices are no values.
      const item: unknown = Object.getOwnPropertyDescriptor(value, String(index))?.value;
      out.push(index === 0 ? '' : ',');
      written(item, out);
    }
    out.push(']');
    return;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .toSorted((a, b) => (a < b ? -1 : Number(a > b)));
  out.push('{');
  for (const [index, key] of keys.entries()) {
    out.push(index === 0 ? '' : ',', JSON.stringify(key), ':');
    written(record[key], out);
  }
  out.push('}');
}

/** `value`, JSON, as the one text it is: each object's keys sorted, `undefined` left out. */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  written(value, out);
  return out.join('');
}

/** The SHA-256 of `value` as `canonicalJson` writes it, in hex. */
export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** A digest short enough to carry in a token many times over: a binding's path names one a step. */
export function shortDigest(value: unknown): string {
  return digest(value).slice(0, SHORT_DIGEST);
}

/**
 * What a binding's path names a key by — a component's, a list's item's — a digest of it: a token
 * carries the inputs of each site on the way already, which the key of an item is made of, and as
 * long a key again would take it past what the authority reads back.
 */
export function keyTag(key: string): string;
export function keyTag(key: string | null): string | null;
export function keyTag(key: string | null): string | null {
  return key === null ? null : shortDigest(['key', key]);
}

/** Validated own data, normalized without inherited serialization or iteration hooks. */
export function carried(value: Json): Json {
  let result = value;
  if (typeof value === 'number') {
    result = value + 0;
  } else if (typeof value === 'object' && value !== null) {
    result = Array.isArray(value)
      ? carriedArray(value as readonly Json[])
      : carriedObject(value as Readonly<Record<string, Json | undefined>>);
  }
  return result;
}

/** Missing own slots carry null without reading an inherited value or getter. */
function carriedArray(value: readonly Json[]): Json[] {
  const result: Json[] = [];
  const length = value.length;
  for (let index = 0; index < length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index))?.value as Json | undefined;
    result.push(item === undefined ? null : carried(item));
  }
  return result;
}

/** Own object data keeps its original key order, including a proto-named key. */
function carriedObject(value: Readonly<Record<string, Json | undefined>>): Record<string, Json> {
  const result: Record<string, Json> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: carried(item),
        writable: true,
      });
    }
  }
  return result;
}

/**
 * A copy of `value`, JSON, frozen through: what the application's code is handed of a value the
 * authority keeps or compares — a component's props — is never the value itself.
 */
export function frozenJson<T extends Json>(value: T): T {
  const copy = JSON.parse(canonicalJson(value)) as T;
  deepFreeze(copy);
  return copy;
}

function deepFreeze(value: unknown): void {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
}
