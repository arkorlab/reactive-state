import type { Entry, TableRead } from '../server/context.ts';
import { type DatabaseDefinition, isRecordId, type Table } from '../server/schema.ts';
import type { Database } from './database.ts';
import type { Dependencies, RowChange } from './dependencies.ts';
import {
  externalCount,
  externalFind,
  externalGet,
  type ExternalStore,
  type ExternalTable,
} from './external.ts';
import {
  entryOf,
  type Found,
  type KeptValues,
  matches,
  ordered,
  queryOf,
  type Where,
} from './query.ts';
import { valuesOf } from './records.ts';

/** What reads are answered from: the committed records, or a transaction's view of them. */
export interface RowSource {
  /** Every record of the table, by id, its fields as the declaration reads them. */
  readonly rows: (table: string) => ReadonlyMap<string, KeptValues>;
  /** One record's fields, or `null` for none. */
  readonly get: (table: string, id: string) => KeptValues | null;
}

/**
 * The committed records of each declared table, as the declaration reads them, kept in memory from
 * the first read of the table on: the authority is its database's one writer, and every commit
 * hands what it changed here (`apply`) once SQLite has it, so what is kept is what SQLite holds.
 * An external table's records are none of these: each read of one asks its store (`store`).
 */
export class Tables implements RowSource {
  readonly #db: Database;
  readonly #definition: DatabaseDefinition;
  readonly #stores: ReadonlyMap<string, ExternalStore>;
  readonly #loaded = new Map<string, Map<string, KeptValues>>();

  readonly rows = (table: string): ReadonlyMap<string, KeptValues> => {
    let rows = this.#loaded.get(table);
    if (rows === undefined) {
      const definition = this.table(table);
      rows = new Map(
        this.#db
          .records(table)
          .map(({ data, id }) => [id, Object.freeze(valuesOf(definition, data))]),
      );
      this.#loaded.set(table, rows);
    }
    return rows;
  };

  readonly get = (table: string, id: string): KeptValues | null => this.rows(table).get(id) ?? null;

  constructor(
    db: Database,
    definition: DatabaseDefinition,
    stores: ReadonlyMap<string, ExternalStore> = new Map(),
  ) {
    this.#db = db;
    this.#definition = definition;
    this.#stores = stores;
  }

  /** The store an external table is read through, by its name: none of a table the authority keeps. */
  store(table: string): ExternalStore | undefined {
    return this.#stores.get(table);
  }

  /** The declared table `name`; a fault for a table of another database than the authority's. */
  table(name: string): Table {
    const table = this.#definition.tables.get(name);
    if (table === undefined) {
      throw new Error(
        `${name} is no table of the database the authority was given: the application reads one database, and gives the authority that one.`,
      );
    }
    return table;
  }

  /** What a commit changed, once SQLite holds it. */
  apply(changes: readonly RowChange[]): void {
    for (const { after, id, table } of changes) {
      const rows = this.#loaded.get(table);
      if (after === null) {
        rows?.delete(id);
      } else {
        rows?.set(id, after);
      }
    }
  }
}

/** Where an evaluation's reads are answered from, and where they are noted, if anywhere. */
export interface Reader {
  readonly source: RowSource;
  readonly tables: Tables;
  /** What a render depends on; nothing for a write's reads, which nothing renders again. */
  readonly track: Dependencies | undefined;
}

/** `db.<table>.get(id)`: the record, or `null` — for an id no record could have too. */
export function getIn(
  reader: Reader,
  table: string,
  id: unknown,
): Entry | null | Promise<Entry | null> {
  if (!isRecordId(id)) {
    // A misspelled table is a fault even when the id could name no record.
    reader.tables.table(table);
    return null;
  }
  const declared = reader.tables.table(table);
  reader.track?.record(table, id);
  const store = reader.tables.store(table);
  if (store !== undefined) {
    return externalGet(store, { name: table, table: declared }, id);
  }
  const values = reader.source.get(table, id);
  return values === null ? null : entryOf({ id, values });
}

/**
 * What `read` names of its table's records, as a query of them: each field it names, a text field
 * of the table's declaration, of the text it gives. Where it names any other — a field the table
 * declares not, or of another kind — the table whole, which every change of it renders again.
 */
function whereOf(declared: Table, read: TableRead): Where {
  const where: Record<string, string> = {};
  for (const [field, value] of Object.entries(read.where)) {
    const definition = Object.hasOwn(declared.fields, field) ? declared.fields[field] : undefined;
    if (typeof value !== 'string' || definition?.type !== 'text') {
      return {};
    }
    where[field] = value;
  }
  return where;
}

/**
 * What a render read of external tables by SQL of the application's own: of each table, the records
 * its read names, so that a change its store's log tells of one of them — or of any, where it names
 * none — renders it again. A table the authority keeps is refused — the application reads one
 * through `db`, which notes what it read.
 */
export function readTablesIn(reader: Reader, reads: readonly TableRead[]): void {
  const wheres: [string, Where][] = [];
  for (const read of reads) {
    const declared = reader.tables.table(read.table);
    if (reader.tables.store(read.table) === undefined) {
      throw new Error(
        `${read.table} is a table the authority keeps: read it through \`db.${read.table}\`, not by SQL.`,
      );
    }
    wheres.push([read.table, whereOf(declared, read)]);
  }
  for (const [table, where] of wheres) {
    reader.track?.query(table, where);
  }
}

/** A query of `table`, checked, and the store it is asked of where the table is external. */
function asked(reader: Reader, table: string, query: unknown, kind: 'count' | 'findMany') {
  const declared = reader.tables.table(table);
  const checked = queryOf(`db.${table}.${kind}`, declared, query, kind);
  if (checked.where !== null) {
    reader.track?.query(table, checked.where);
  }
  const external: ExternalTable = { name: table, table: declared };
  return { checked, external, store: reader.tables.store(table) };
}

/** The records of a table the authority keeps that `where` names. */
function foundIn(reader: Reader, table: string, where: Where): Found[] {
  const found: Found[] = [];
  for (const [id, values] of reader.source.rows(table)) {
    if (matches(where, id, values)) {
      found.push({ id, values });
    }
  }
  return found;
}

/** `db.<table>.findMany(query)`. */
export function findIn(
  reader: Reader,
  table: string,
  query: unknown,
): readonly Entry[] | Promise<readonly Entry[]> {
  const { checked, external, store } = asked(reader, table, query, 'findMany');
  const { limit, orderBy, select, where } = checked;
  if (where === null) {
    return Object.freeze([]);
  }
  if (store !== undefined) {
    return externalFind(store, external, { limit, orderBy, where }, select);
  }
  const sorted = ordered(foundIn(reader, table, where), orderBy);
  const kept = limit === undefined ? sorted : sorted.slice(0, limit);
  return Object.freeze(kept.map((record) => entryOf(record, select)));
}

/** `db.<table>.count(query)`. */
export function countIn(reader: Reader, table: string, query: unknown): number | Promise<number> {
  const { checked, external, store } = asked(reader, table, query, 'count');
  const { where } = checked;
  let counted: number | Promise<number> = 0;
  if (where !== null) {
    counted =
      store === undefined
        ? foundIn(reader, table, where).length
        : externalCount(store, external, where);
  }
  return counted;
}
