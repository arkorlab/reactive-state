import { randomBytes } from 'node:crypto';

import type { Value } from '../program.ts';
import type { Entry } from '../server/context.ts';
import { checkValue, defaultOf, isRecordId, type Table, uniqueValue } from '../server/schema.ts';
import { HTTP_CONFLICT, HTTP_NOT_FOUND, HTTP_UNPROCESSABLE } from '../status.ts';
import type { RowChange } from './dependencies.ts';
import { refusal } from './errors.ts';
import { entryOf, type KeptValues } from './query.ts';
import type { RowSource, Tables } from './tables.ts';

/** The bytes of a record's id, as the authority gives one: 16 characters of base64url. */
const ID_BYTES = 12;

function generatedId(): string {
  return randomBytes(ID_BYTES).toString('base64url');
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValues(a: KeptValues, b: KeptValues): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * A server operation's transaction, as it runs: its writes kept here until it is over, and its
 * reads answered from the committed records with those writes laid over them — its own writes read
 * back, through the same predicate as every read. Each write is checked as it is made: what it
 * names against the declaration (a mistake of the code's is a fault), each value against its
 * field (422), the record it changes against those there are (404), and each `unique` group
 * against every record there will be (409). Nothing reaches SQLite until the engine commits what
 * it changed (`changes`), all at once.
 */
export class Transaction implements RowSource {
  readonly #tables: Tables;
  /** By table and id: a record's fields as they will be, or `null` for one deleted. */
  readonly #pending = new Map<string, Map<string, KeptValues | null>>();

  readonly rows = (table: string): ReadonlyMap<string, KeptValues> => {
    const committed = this.#tables.rows(table);
    const pending = this.#pending.get(table);
    if (pending === undefined) {
      return committed;
    }
    const rows = new Map(committed);
    for (const [id, values] of pending) {
      if (values === null) {
        rows.delete(id);
      } else {
        rows.set(id, values);
      }
    }
    return rows;
  };

  readonly get = (table: string, id: string): KeptValues | null => {
    const pending = this.#pending.get(table);
    return pending?.has(id) === true ? (pending.get(id) ?? null) : this.#tables.get(table, id);
  };

  constructor(tables: Tables) {
    this.#tables = tables;
  }

  #set(table: string, id: string, values: KeptValues | null): void {
    let pending = this.#pending.get(table);
    if (pending === undefined) {
      pending = new Map();
      this.#pending.set(table, pending);
    }
    pending.set(id, values);
  }

  /**
   * The fields a write gives, each one the table declares and a value its field may hold: a name
   * that is none of them — `id`, which is the authority's to give and never changes — is a fault,
   * and a value the field cannot hold a refusal (422). One given `undefined` is not given.
   */
  #fieldsOf(
    what: string,
    table: string,
    definition: Table,
    fields: unknown,
  ): Readonly<Record<string, Value>> {
    if (!isObject(fields)) {
      throw new TypeError(`${what}: the fields are an object of the table's fields`);
    }
    const given: Record<string, Value> = {};
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined) {
        continue;
      }
      const kind = Object.hasOwn(definition.fields, field) ? definition.fields[field] : undefined;
      if (kind === undefined) {
        throw new TypeError(
          `${what}: \`${field}\` is ${field === 'id' ? "a record's id, which the authority gives and never changes" : "none of the table's fields"}`,
        );
      }
      const wrong = checkValue(kind, value);
      if (wrong !== undefined) {
        throw refusal(HTTP_UNPROCESSABLE, 'INVALID_VALUE', `${table}.${field}: ${wrong}`);
      }
      given[field] = value as Value;
    }
    return given;
  }

  /** Refuses (409) a record that would hold what another holds of one of the table's groups. */
  #unique(table: string, definition: Table, id: string, values: KeptValues): void {
    checkUnique(this, definition.unique, { id, table, values });
  }

  /**
   * The table a write of `what` names, declared: a fault for an external one, whose records are its
   * store's, which the application's own code writes, and never the authority.
   */
  #written(what: string, table: string): Table {
    const definition = this.#tables.table(table);
    if (definition.external !== undefined) {
      throw new TypeError(
        `${what}: ${table} is read through the store \`${definition.external}\`, whose records the application's own code writes, never the authority`,
      );
    }
    return definition;
  }

  /** Whether the transaction wrote anything: one that did not commits nothing. */
  get written(): boolean {
    return this.#pending.size > 0;
  }

  insert(table: string, fields: unknown): Entry {
    const definition = this.#written(`db.${table}.insert`, table);
    const given = this.#fieldsOf(`db.${table}.insert`, table, definition, fields);
    const made: Record<string, Value> = {};
    for (const [field, kind] of Object.entries(definition.fields)) {
      // The fields given are its own: one named as an object's method is (`valueOf`) is not given.
      made[field] = Object.hasOwn(given, field)
        ? (given[field] ?? defaultOf(kind))
        : defaultOf(kind);
    }
    const values: KeptValues = Object.freeze(made);
    let id = generatedId();
    while (this.get(table, id) !== null) {
      id = generatedId();
    }
    this.#unique(table, definition, id, values);
    this.#set(table, id, values);
    return entryOf({ id, values });
  }

  update(table: string, id: unknown, patch: unknown): Entry {
    const definition = this.#written(`db.${table}.update`, table);
    const given = this.#fieldsOf(`db.${table}.update`, table, definition, patch);
    const current = isRecordId(id) ? this.get(table, id) : null;
    if (current === null || !isRecordId(id)) {
      throw refusal(HTTP_NOT_FOUND, 'NOT_FOUND', `There is no such record of ${table}.`);
    }
    const values = Object.freeze({ ...current, ...given });
    this.#unique(table, definition, id, values);
    this.#set(table, id, values);
    return entryOf({ id, values });
  }

  delete(table: string, id: unknown): void {
    this.#written(`db.${table}.delete`, table);
    if (!isRecordId(id) || this.get(table, id) === null) {
      throw refusal(HTTP_NOT_FOUND, 'NOT_FOUND', `There is no such record of ${table}.`);
    }
    this.#set(table, id, null);
  }

  /**
   * What the transaction changes, each record once, as it was committed and as it will be: a
   * record written back as it was, or made and deleted again, is no change.
   */
  changes(): readonly RowChange[] {
    const changes: RowChange[] = [];
    for (const [table, pending] of this.#pending) {
      for (const [id, after] of pending) {
        const before = this.#tables.get(table, id);
        if (before === null ? after !== null : after === null || !sameValues(before, after)) {
          changes.push({ after, before, id, table });
        }
      }
    }
    return changes;
  }

  /**
   * Checks every `unique` group of every table written, across all its records as they will be:
   * once more, as the transaction commits, whatever each write found as it was made.
   */
  check(): void {
    for (const table of this.#pending.keys()) {
      const definition = this.#tables.table(table);
      for (const group of definition.unique) {
        const held = new Set<string>();
        for (const values of this.rows(table).values()) {
          const value = uniqueValue(group, values);
          if (held.has(value)) {
            throw unique(table, group);
          }
          held.add(value);
        }
      }
    }
  }
}

/**
 * Refuses (409) `record`, as it would be, where another record of its table in `rows` holds the same
 * of one of `groups`.
 */
export function checkUnique(
  rows: RowSource,
  groups: readonly (readonly string[])[],
  record: { readonly table: string; readonly id: string; readonly values: KeptValues },
): void {
  const { id, table, values } = record;
  for (const group of groups) {
    const value = uniqueValue(group, values);
    for (const [other, held] of rows.rows(table)) {
      if (other !== id && uniqueValue(group, held) === value) {
        throw unique(table, group);
      }
    }
  }
}

function unique(table: string, group: readonly string[]): Error {
  return refusal(
    HTTP_CONFLICT,
    'UNIQUE_VIOLATION',
    `Another record of ${table} holds the same ${group.join(', ')}.`,
  );
}
