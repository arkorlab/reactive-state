import type { KeyKind } from './keys.ts';

/**
 * Whether a value a render's statement runs with is sent as the text `values.ts` reads it as. PGlite
 * writes each value by a serializer of the type PostgreSQL takes it as — its own, or one the
 * application gave the instance (`PGlite.create({ serializers })`) — and a condition of the value is
 * followed by the text PostgreSQL was sent: only where that is the value's own.
 */

/**
 * Whether `value`, of a key of `kind` whose type is of the oid `oid` (an enum's), is sent as the text
 * `values.ts` reads it as.
 */
export type Bound = (value: unknown, kind: KeyKind, oid?: number) => boolean;

/** No value sent as `values.ts` reads it: of a query whose options bind its values otherwise. */
export const NOTHING_BOUND: Bound = () => false;

/** The oids of PostgreSQL's own types a key's value may be taken as. */
const OID = {
  bool: 16,
  bpchar: 1042,
  char: 18,
  int2: 21,
  int4: 23,
  int8: 20,
  name: 19,
  text: 25,
  uuid: 2950,
  varchar: 1043,
} as const;
/** The types PGlite may take a value of a key of each kind as, by their oids. */
const TYPES: Readonly<Record<KeyKind, readonly number[]>> = {
  boolean: [OID.bool],
  integer: [OID.int8, OID.int2, OID.int4],
  text: [OID.text, OID.varchar, OID.name, OID.bpchar, OID.char],
  uuid: [OID.uuid],
};

/** The text PGlite's own serializers send `value` as, of a key of `kind`; nothing of another. */
function ownText(value: unknown, kind: KeyKind): string | undefined {
  if (kind === 'boolean') {
    if (typeof value !== 'boolean') return undefined;
    return value ? 't' : 'f';
  }
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
    ? String(value)
    : undefined;
}

/** Whether `serialize`, a serializer of PGlite's or the application's, sends `value` as `text`. */
function sends(serialize: unknown, value: unknown, text: string | undefined): boolean {
  if (typeof serialize !== 'function') return true;
  try {
    return text !== undefined && Reflect.apply(serialize, undefined, [value]) === text;
  } catch {
    return false;
  }
}

/**
 * Of `connection`, a PGlite, whether each value is sent as `values.ts` reads it: by each serializer
 * of a type a key's value may be taken as — PostgreSQL's of its kind, and the key's own type's (an
 * enum's) — writing the value as PGlite's own do. As they are as the value is bound: the
 * application gives an enum its serializer once the enum, and its oid, are made.
 */
export function boundOf(connection: unknown): Bound {
  return (value, kind, oid) => {
    const serializers: unknown =
      typeof connection === 'object' && connection !== null
        ? Reflect.get(connection, 'serializers')
        : undefined;
    if (typeof serializers !== 'object' || serializers === null) return true;
    const text = ownText(value, kind);
    const oids = oid === undefined ? TYPES[kind] : [...TYPES[kind], oid];
    return oids.every((each) => sends(Reflect.get(serializers, each), value, text));
  };
}
