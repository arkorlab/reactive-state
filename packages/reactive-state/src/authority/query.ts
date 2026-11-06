import type { Json, Value } from '../program.ts';
import type { Entry } from '../server/context.ts';
import { checkValue, type FieldDefinition, isRecordId, type Table } from '../server/schema.ts';

/**
 * A query of `findMany` and `count`, as the authority reads what the application's code handed it,
 * and the one predicate every record is held to — by a read, by a transaction's reads of what it
 * has yet to commit, and by a commit, to tell what it changed of what a render read. Records are
 * filtered here, never in SQL: a Durable Object's SQLite and Node's answer the same, whatever
 * either makes of JSON. An external table's store filters its own records (`external.ts`), as this
 * predicate says, and orders their text by code point, as SQLite does (`ordered`).
 */

/**
 * A record's fields, as the authority reads them against the declaration: every field there — a
 * document (`json()`) of an external table's as JSON, which no query asks of or orders by.
 */
export type Values = Readonly<Record<string, Json>>;

/** A record of a table the authority keeps: no document, which such a table declares none of. */
export type KeptValues = Readonly<Record<string, Value>>;

/** What a record holds of a field a query names: never a document, which none names (`comparable`). */
export function comparableOf(values: Values, field: string): Value {
  const value = values[field] ?? false;
  return typeof value === 'object' ? false : value;
}

/** What a query asks of a record, checked: each field — `id` among them — equal to its value. */
export type Where = Readonly<Record<string, Value>>;

export interface Order {
  readonly field: string;
  readonly descending: boolean;
}

export interface Query {
  /** `null` for a query no record could answer: a value its field cannot hold, an id none has. */
  readonly where: Where | null;
  /** The fields answered, `id` among them where it is named; every field and `id` where none is. */
  readonly select: readonly string[] | undefined;
  readonly orderBy: readonly Order[];
  /** The most records answered, the first in that order; every one where it is `undefined`. */
  readonly limit: number | undefined;
}

/** A field a query may ask of and order by: any but a document (`json()`). */
type Comparable = Exclude<FieldDefinition, { readonly type: 'json' }>;

/** A mistake in the application's code — a fault, which nothing it does with it makes a refusal. */
function fault(what: string, why: string): never {
  throw new TypeError(`${what}: ${why}`);
}

/**
 * Whether `value` is an object as a query is written of — `{ … }`, or one of no prototype — whose
 * own entries say all it does. A `Date`, a `Map`, an array or an object of a class is none: what
 * it says may be its prototype's, its getters' among them, and read by its entries it would ask
 * of nothing, every record.
 */
function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** What JavaScript calls the type of the values a field holds. */
function typeOf(definition: Comparable): 'boolean' | 'number' | 'string' {
  switch (definition.type) {
    case 'text': {
      return 'string';
    }
    case 'boolean': {
      return 'boolean';
    }
    case 'integer': {
      return 'number';
    }
  }
}

/** The field `name` of the table, or a fault for one it does not declare. */
function declared(what: string, table: Table, name: string): FieldDefinition {
  const definition = Object.hasOwn(table.fields, name) ? table.fields[name] : undefined;
  return definition ?? fault(what, `\`${name}\` is none of the table's fields`);
}

/** The field `name` of the table, which a query asks of or orders by: a fault for a document. */
function comparable(what: string, table: Table, name: string): Comparable {
  const definition = declared(what, table, name);
  return definition.type === 'json'
    ? fault(what, `\`${name}\` is a document, which no query asks of or orders by`)
    : definition;
}

/**
 * The conditions of `where`: each a declared field or `id`, given a value of the type it holds. A
 * condition of `undefined` is none. A value of that type the field cannot hold — text longer than
 * it, an id no record could have, as a page's URL may well give — names no record, and the query
 * none at all (`null`): an empty answer, never a fault.
 */
function whereOf(what: string, table: Table, where: unknown): Where | null {
  if (!isObject(where)) {
    return fault(what, '`where` is an object of fields, each with the value it holds');
  }
  const conditions: Record<string, Value> = {};
  let possible = true;
  for (const [name, value] of Object.entries(where)) {
    if (value === undefined) {
      continue;
    }
    if (name === 'id') {
      if (typeof value !== 'string') {
        return fault(what, '`id` holds text');
      }
      possible &&= isRecordId(value);
      conditions[name] = value;
      continue;
    }
    const definition = comparable(what, table, name);
    if (typeof value !== typeOf(definition)) {
      return fault(
        what,
        `\`${name}\` holds ${definition.type}, and is compared with a value of it`,
      );
    }
    possible &&= checkValue(definition, value) === undefined;
    conditions[name] = value as Value;
  }
  return possible ? conditions : null;
}

function selectOf(what: string, table: Table, select: unknown): readonly string[] | undefined {
  if (select === undefined) {
    return undefined;
  }
  if (!isObject(select)) {
    return fault(what, '`select` is an object of fields, each `true`');
  }
  return Object.entries(select).map(([name, selected]) => {
    if (name !== 'id') {
      declared(what, table, name);
    }
    if (selected !== true) {
      fault(what, `\`select\` names \`${name}\` with \`true\` alone`);
    }
    return name;
  });
}

function orderOf(what: string, table: Table, orderBy: unknown): readonly Order[] {
  if (orderBy === undefined) {
    return [];
  }
  if (!Array.isArray(orderBy)) {
    return fault(what, '`orderBy` is a list of keys, each `{ field: "asc" | "desc" }`');
  }
  return orderBy.map((item: unknown) => {
    const entries = isObject(item) ? Object.entries(item) : [];
    const [[name, direction] = ['', undefined], ...rest] = entries;
    if (rest.length > 0 || (direction !== 'asc' && direction !== 'desc')) {
      return fault(what, 'each key of `orderBy` names one field, `"asc"` or `"desc"`');
    }
    if (name !== 'id') {
      comparable(what, table, name);
    }
    return { descending: direction === 'desc', field: name };
  });
}

/** The most records `findMany` answers: a whole number above none, or every one (`undefined`). */
function limitOf(what: string, limit: unknown): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0
    ? limit
    : fault(what, '`limit` is a whole number of records, one at least');
}

/**
 * A query of `findMany` (`{ where, select?, orderBy?, limit? }`) or of `count` (`{ where }`),
 * checked against the table: anything it names the table does not have, or any other option, is a
 * fault.
 */
export function queryOf(
  what: string,
  table: Table,
  query: unknown,
  kind: 'count' | 'findMany',
): Query {
  if (!isObject(query)) {
    return fault(what, 'the query is an object, `{ where }` at least');
  }
  const options = kind === 'count' ? ['where'] : ['where', 'select', 'orderBy', 'limit'];
  const other = Object.keys(query).find((option) => !options.includes(option));
  if (other !== undefined) {
    return fault(what, `\`${other}\` is no option of ${kind}: ${options.join(', ')}`);
  }
  return {
    limit: limitOf(what, query['limit']),
    orderBy: orderOf(what, table, query['orderBy']),
    select: selectOf(what, table, query['select']),
    where: whereOf(what, table, query['where']),
  };
}

/** Whether the record — `id`, holding `values` — is one `where` names. */
export function matches(where: Where, id: string, values: Values): boolean {
  return Object.entries(where).every(
    ([name, value]) => (name === 'id' ? id : comparableOf(values, name)) === value,
  );
}

/**
 * Two values of one field in order: text by its UTF-16 units — or by its code points, as an
 * external table's store orders it (SQLite's `BINARY`, of UTF-8) — numbers, `false` before `true`.
 */
function compare(a: Value, b: Value, codePoints: boolean): number {
  if (a === b) {
    return 0;
  }
  if (codePoints && typeof a === 'string' && typeof b === 'string') {
    return byCodePoint(a, b);
  }
  return a < b ? -1 : 1;
}

/** The last code point UTF-16 writes in one unit: one past it takes a surrogate pair. */
const UNITS = { lastSingle: 0xff_ff } as const;

/** Two texts by their code points: where UTF-16 puts a surrogate pair before `U+E000`–`U+FFFF`. */
function byCodePoint(a: string, b: string): number {
  let at = 0;
  while (at < a.length && at < b.length) {
    const x = a.codePointAt(at) ?? 0;
    const y = b.codePointAt(at) ?? 0;
    if (x !== y) {
      return x - y;
    }
    at += x > UNITS.lastSingle ? 2 : 1;
  }
  return a.length - b.length;
}

/** One record as a query reads it: its id, and its fields. */
export interface Found {
  readonly id: string;
  readonly values: Values;
}

/**
 * The records in the order asked for, each tie broken by the next key, the last one by `id`: text
 * by its code points where `codePoints` says, as an external table's store orders it.
 */
export function ordered(
  found: readonly Found[],
  orderBy: readonly Order[],
  codePoints = false,
): readonly Found[] {
  return found.toSorted((a, b) => {
    for (const { descending, field } of orderBy) {
      const order =
        field === 'id'
          ? compare(a.id, b.id, codePoints)
          : compare(comparableOf(a.values, field), comparableOf(b.values, field), codePoints);
      if (order !== 0) {
        return descending ? -order : order;
      }
    }
    return compare(a.id, b.id, codePoints);
  });
}

/** A record as the application reads it: `{ id, ...fields }`, or what `select` names of it. */
export function entryOf({ id, values }: Found, select?: readonly string[]): Entry {
  if (select === undefined) {
    return Object.freeze({ id, ...values });
  }
  return Object.freeze(
    Object.fromEntries(select.map((name) => [name, name === 'id' ? id : (values[name] ?? null)])),
  );
}
