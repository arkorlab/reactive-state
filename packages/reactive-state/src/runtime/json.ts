import type { Json } from '../program.ts';

/**
 * JSON as it crosses to the authority: what a page's update captured, what a server operation is
 * called with, the props a root is rendered with. A value is copied as JSON would carry it, and one
 * JSON would carry otherwise than it is — a function, a date, `NaN`, an `undefined` in an array or
 * a hole in one, a cycle — is refused here rather than changed on its way. An `undefined` property
 * is left out, as JSON leaves it out, `-0` is `0`, as JSON writes it, and every other key is the
 * copy's own, `__proto__` among them. Runtime-neutral: the browser's store and the application's server use it.
 * Two values are compared as the one text each is (`canonicalJson`).
 */

/** How deep a value may nest: one deeper is taken for a cycle, or for a value no page means. */
const MAX_DEPTH = 64;

function refuse(where: string, what: string): never {
  throw new TypeError(`${where} is ${what}, which JSON does not carry as it is.`);
}

/** What an object of a class is, as a message names it: `Date`, `Map`. */
function kindOf(value: Readonly<Record<string, unknown>>): string {
  const name: unknown = (value as { readonly constructor?: { readonly name?: unknown } })
    .constructor?.name;
  return typeof name === 'string' && name !== '' ? name : 'a class';
}

function copyObject(
  value: Readonly<Record<string, unknown>>,
  where: string,
  depth: number,
): Record<string, Json> {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    return refuse(where, `an instance of ${kindOf(value)}`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return refuse(where, 'an object with symbol keys');
  }
  // An entry it does not enumerate, which JSON leaves out, or one an accessor computes, which may
  // answer otherwise each time: copied, it would be another.
  if (Object.getOwnPropertyNames(value).some((name) => !isWrittenAsIs(value, name))) {
    return refuse(where, 'an object with an entry it does not enumerate, or an accessor computes');
  }
  // `JSON.rawJSON(…)`, which JSON writes as the text it holds, and a copy as an object of an entry.
  const { isRawJSON } = JSON as { readonly isRawJSON?: (value: unknown) => boolean };
  if (isRawJSON?.(value) === true) {
    return refuse(where, 'raw JSON text');
  }
  const copied: Record<string, Json> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      // Defined, not assigned: `__proto__` is a key like any other, never the copy's prototype.
      Object.defineProperty(copied, key, {
        configurable: true,
        enumerable: true,
        value: copy(item, `${where}.${key}`, depth + 1),
        writable: true,
      });
    }
  }
  return copied;
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
 * The entries React's development build defines, not enumerated, on what it deserializes of what the
 * server rendered — an array, the debug information of what rendered it — which no application
 * reads, and JSON leaves out.
 */
const DEBUG_ENTRIES: ReadonlySet<string> = new Set(['_debugInfo']);

/**
 * Whether the own entry `name` of `value`, an array, is one React's development build defines on an
 * array it deserializes (`DEBUG_ENTRIES`), as it defines it: of a list it writes, not enumerated, nor
 * configured — not one an accessor computes, nor one the application defines otherwise.
 */
function isDebugEntry(value: readonly unknown[], name: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return (
    DEBUG_ENTRIES.has(name) &&
    descriptor?.enumerable === false &&
    descriptor.configurable === false &&
    descriptor.writable === true &&
    Array.isArray(descriptor.value)
  );
}

/**
 * Whether an array holds an entry of a name of its own beside its elements and its length, which
 * JSON leaves out, writing its elements alone — `extra` of `Object.assign([1], { extra: 'x' })` —
 * or an element an accessor computes; but React's own (`isDebugEntry`).
 */
function namesBeside(value: readonly unknown[]): boolean {
  return Object.getOwnPropertyNames(value).some((name) => {
    const index = Number(name);
    const isElement =
      Number.isSafeInteger(index) && index >= 0 && index < value.length && String(index) === name;
    return (
      name !== 'length' && !(isElement && isWrittenAsIs(value, name)) && !isDebugEntry(value, name)
    );
  });
}

/**
 * @returns `value`, copied as JSON.
 */
function copy(value: unknown, where: string, depth: number): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    // `-0` as JSON writes it, `0`: a Durable Object's RPC would carry it as it is.
    return Number.isFinite(value) ? value + 0 : refuse(where, String(value));
  }
  if (value === undefined) {
    return refuse(where, 'undefined');
  }
  if (typeof value !== 'object') {
    return refuse(where, `a ${typeof value}`);
  }
  if (depth >= MAX_DEPTH) {
    return refuse(where, `nested more than ${String(MAX_DEPTH)} levels deep`);
  }
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return refuse(where, 'an array with symbol keys');
    }
    if (namesBeside(value as readonly unknown[])) {
      return refuse(where, 'an array with an entry of a name of its own');
    }
    // Missing own slots are refused, without consulting inherited values or an application iterator.
    const items = value as readonly unknown[];
    const length = items.length;
    const copied: Json[] = [];
    for (let index = 0; index < length; index += 1) {
      const item: unknown = Object.getOwnPropertyDescriptor(items, String(index))?.value;
      copied.push(copy(item, `${where}[${String(index)}]`, depth + 1));
    }
    return copied;
  }
  return copyObject(value as Readonly<Record<string, unknown>>, where, depth);
}

/** `value`, copied as JSON; a `TypeError` naming `where` for what JSON would not carry as it is. */
export function toJson(value: unknown, where = 'The value'): Json {
  return copy(value, where, 0);
}

/** A JSON object, copied; a `TypeError` for anything else. */
export function toJsonRecord(value: unknown, where = 'The value'): Readonly<Record<string, Json>> {
  const copied = toJson(value, where);
  if (typeof copied !== 'object' || copied === null || Array.isArray(copied)) {
    return refuse(where, 'not an object');
  }
  return copied as Readonly<Record<string, Json>>;
}

function written(value: Json, out: string[]): void {
  if (typeof value !== 'object' || value === null) {
    out.push(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    out.push('[');
    for (const [index, item] of (value as readonly Json[]).entries()) {
      out.push(index === 0 ? '' : ',');
      written(item, out);
    }
    out.push(']');
    return;
  }
  const record = value as Readonly<Record<string, Json | undefined>>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .toSorted((a, b) => (a < b ? -1 : Number(a > b)));
  out.push('{');
  for (const [index, key] of keys.entries()) {
    out.push(index === 0 ? '' : ',', JSON.stringify(key), ':');
    written(record[key] as Json, out);
  }
  out.push('}');
}

/**
 * `value` as the one text it is, each object's keys sorted, as the authority writes a value it
 * compares: two values that are the same JSON are the same text however their objects were built —
 * by a page's code, or by the RSC payload a frame came in. What a page compares the inputs of its
 * dynamic sites by, without the authority's digest, which the browser has no `node:crypto` for.
 */
export function canonicalJson(value: Json): string {
  const out: string[] = [];
  written(value, out);
  return out.join('');
}
