import type { Json, Value } from '../program.ts';
import type { Entry } from '../server/context.ts';
import { checkValue, type DatabaseDefinition, isRecordId, type Table } from '../server/schema.ts';
import { frozenJson } from './canonical.ts';
import type { RowChange } from './dependencies.ts';
import {
  entryOf,
  type Found,
  type KeptValues,
  matches,
  type Order,
  ordered,
  type Values,
  type Where,
} from './query.ts';

/**
 * A database of the application's own, as the authority reads an external table's records from it
 * (`table(fields, { external })`) and follows its change log: the authority keeps none of its
 * records, and writes none. What a render read of one is noted as any read is (`Dependencies`), and
 * each change the store's log tells of is announced as a commit is, which renders again what read
 * the record — as Convex's queries are run again by its log. The store is the host's to give, by the
 * name the table declares; the application's components read the table as any other.
 *
 * A store answers the query the authority asks as the authority would: each field `where` names
 * equal to its value, in the order asked, text by its code points. The authority holds what it
 * answers to the same predicate and order, so that a record a store answered amiss is never shown;
 * one it left out is not found. A NULL or missing field is its declared default. Every other
 * field must satisfy the declaration: an invalid value is a store fault, not another default
 * that could disagree with the store's predicate, order or limit.
 */

/** A table of a store, as the authority asks it of one: its name in the declaration, and itself. */
export interface ExternalTable {
  readonly name: string;
  readonly table: Table;
}

/** A record of an external table, as its store answers it: its id, and the fields it holds. */
export interface ExternalRecord {
  readonly id: string;
  /** Each field the table declares, as the record holds it: JSON of a document. */
  readonly values: Readonly<Record<string, unknown>>;
}

/** What `find` is asked: what `where` names, in that order, and at most `limit` of them. */
export interface ExternalQuery {
  readonly where: Where;
  readonly orderBy: readonly Order[];
  readonly limit: number | undefined;
}

/**
 * One change of a store's log: the record it changed, by its table in the declaration, and what
 * the record held of its fields before and after — `null` where there was none — where the log
 * keeps them. A change that keeps neither renders again whatever read the table's records.
 */
export interface ExternalChange {
  readonly seq: number;
  readonly table: string;
  readonly id: string;
  readonly before?: Readonly<Record<string, unknown>> | null | undefined;
  readonly after?: Readonly<Record<string, unknown>> | null | undefined;
}

/** A page of a store's log, after a place in it. */
export interface ExternalChanges {
  /** The changes after the place asked of, in order, as many as were asked for at most. */
  readonly changes: readonly ExternalChange[];
  /** The last change the log holds: 0 while it holds none. */
  readonly head: number;
  /** The first change the log still holds — those before were let go of — or 0 while it holds none. */
  readonly floor: number;
  /** Which log it is: a place in another one — a database made again — is none in this one. */
  readonly epoch: string;
}

/** A database of the application's own, as the authority reads it and follows it. */
export interface ExternalStore {
  readonly get: (table: ExternalTable, id: string) => Promise<ExternalRecord | null>;
  readonly find: (table: ExternalTable, query: ExternalQuery) => Promise<readonly ExternalRecord[]>;
  readonly count: (table: ExternalTable, where: Where) => Promise<number>;
  /** The changes after `since`, at most `limit` of them. */
  readonly changes: (since: number, limit: number) => Promise<ExternalChanges>;
}

/** The stores an authority reads its external tables through, by the names the tables declare. */
export type ExternalStores = Readonly<Record<string, ExternalStore>>;

/**
 * The most changes a store's log is asked for at once, how many pages a turn reads at most, and how
 * long a read of a page may take where the authority is told no call timeout.
 */
export const TAIL = { pageSize: 200, pagesAtOnce: 10, readTimeoutMs: 5000 } as const;

/**
 * `pending`, or a failure once `ms` have gone by: a read of a store's log that never answers would
 * else hold every later one — and the host's alarm, and each `poke()` — behind it for good.
 */
async function withinDeadline<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`An external store's change log did not answer within ${String(ms)} ms.`));
    }, ms);
  });
  try {
    return await Promise.race([pending, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The store each external table of `database` is read through, of `stores`: a fault where a table
 * names one the host gave none of, which no read of it could answer.
 */
export function storesOf(
  database: DatabaseDefinition,
  stores: ExternalStores = {},
): ReadonlyMap<string, ExternalStore> {
  const byTable = new Map<string, ExternalStore>();
  for (const [name, table] of database.tables) {
    if (table.external === undefined) {
      continue;
    }
    const store = Object.hasOwn(stores, table.external) ? stores[table.external] : undefined;
    if (store === undefined) {
      throw new TypeError(
        `The table ${name} is read through the store \`${table.external}\`, which the authority's host gave none of: give it as \`stores.${table.external}\`.`,
      );
    }
    byTable.set(name, store);
  }
  return byTable;
}

/**
 * A record a store answered, as the authority reads it against the declaration: each field what
 * the record holds of it, or its default for NULL and missing fields. Documents are copied and
 * frozen: the application's store keeps its own value, and cannot change a memoized rendering.
 */
function valuesOf(table: Table, held: Readonly<Record<string, unknown>>): Values {
  const values: Record<string, Json> = {};
  for (const [field, definition] of Object.entries(table.fields)) {
    const value = (Object.hasOwn(held, field) ? held[field] : undefined) ?? definition.default;
    const problem = checkValue(definition, value);
    if (problem !== undefined) {
      throw new TypeError(`The external field ${field} ${problem}.`);
    }
    values[field] = definition.type === 'json' ? frozenJson(value as Json) : (value as Value);
  }
  return Object.freeze(values);
}

/** What a store answered of a record, read against the declaration; nothing of an id none has. */
function foundOf(table: Table, record: ExternalRecord): Found | undefined {
  return isRecordId(record.id)
    ? { id: record.id, values: valuesOf(table, record.values) }
    : undefined;
}

/** `db.<table>.get(id)` of an external table: the record its store answers, or `null`. */
export async function externalGet(
  store: ExternalStore,
  table: ExternalTable,
  id: string,
): Promise<Entry | null> {
  const record = await store.get(table, id);
  const found = record === null ? undefined : foundOf(table.table, record);
  return found?.id === id ? entryOf(found) : null;
}

/**
 * `db.<table>.findMany(query)` of an external table: what its store answers, held to the query's
 * predicate and its order, text by its code points, as the store orders it.
 */
export async function externalFind(
  store: ExternalStore,
  table: ExternalTable,
  query: ExternalQuery,
  select: readonly string[] | undefined,
): Promise<readonly Entry[]> {
  const answered = await store.find(table, query);
  const found: Found[] = [];
  const seen = new Set<string>();
  for (const record of answered) {
    const each = foundOf(table.table, record);
    if (each !== undefined && !seen.has(each.id) && matches(query.where, each.id, each.values)) {
      seen.add(each.id);
      found.push(each);
    }
  }
  const sorted = ordered(found, query.orderBy, true);
  const kept = query.limit === undefined ? sorted : sorted.slice(0, query.limit);
  return Object.freeze(kept.map((record) => entryOf(record, select)));
}

/** `db.<table>.count(query)` of an external table: what its store counts, a whole number. */
export async function externalCount(
  store: ExternalStore,
  table: ExternalTable,
  where: Where,
): Promise<number> {
  const counted = await store.count(table, where);
  if (!Number.isSafeInteger(counted) || counted < 0) {
    throw new TypeError(`The store of ${table.name} counted ${String(counted)} records.`);
  }
  return counted;
}

/**
 * What a change kept of a record's fields, as a commit's rows hold them: the fields a query may ask
 * of alone — no document's — each read against the declaration; `undefined` where it kept nothing
 * or cannot satisfy the current declaration. Historical values may have been corrected, deleted,
 * or kept under an older declaration: their change invalidates conservatively instead of keeping
 * the cursor stuck behind them. Current records are still checked strictly by `valuesOf`.
 */
function imageOf(
  table: Table,
  image: Readonly<Record<string, unknown>> | null | undefined,
): KeptValues | null | undefined {
  if (image === null || image === undefined) {
    return image;
  }
  const values: Record<string, Value> = {};
  for (const [field, definition] of Object.entries(table.fields)) {
    if (definition.type === 'json') {
      continue;
    }
    const value = (Object.hasOwn(image, field) ? image[field] : undefined) ?? definition.default;
    if (checkValue(definition, value) !== undefined) return undefined;
    values[field] = value as Value;
  }
  return Object.freeze(values);
}

/**
 * One change of a store's log as a commit's row: the record's fields before and after where the log
 * kept both, else what is not known of it — its fields, or which record of the table it was.
 */
function rowOf(table: Table, name: string, change: ExternalChange): RowChange {
  if (!isRecordId(change.id)) {
    return { after: null, before: null, id: '', table: name, unknown: 'table' };
  }
  const before = imageOf(table, change.before);
  const after = imageOf(table, change.after);
  return before === undefined || after === undefined
    ? { after: null, before: null, id: change.id, table: name, unknown: 'fields' }
    : { after, before, id: change.id, table: name };
}

/** Every external table of a store, as changed in a way nothing tells of: a log begun anew. */
function everyRecordOf(tables: ReadonlyMap<string, Table>): readonly RowChange[] {
  return [...tables.keys()].map((name) => {
    return {
      after: null,
      before: null,
      id: '',
      table: name,
      unknown: 'table' as const,
    };
  });
}

/** Whether a log's number is a nonnegative safe integer. */
function logNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A page held to its contract before anything can move the follower's cursor. */
function checkedChanges(read: ExternalChanges, since: number): ExternalChanges {
  const changes: readonly ExternalChange[] = read.changes;
  if (
    !logNumber(read.head) ||
    !logNumber(read.floor) ||
    read.floor > read.head + 1 ||
    typeof read.epoch !== 'string' ||
    read.epoch === '' ||
    !Array.isArray(read.changes) ||
    read.changes.length > TAIL.pageSize
  ) {
    throw new TypeError('An external change log must give a valid head, floor, epoch and page.');
  }
  let previous = since;
  for (const change of changes) {
    if (
      !logNumber(change.seq) ||
      change.seq <= previous ||
      change.seq > read.head ||
      typeof change.table !== 'string' ||
      typeof change.id !== 'string'
    ) {
      throw new TypeError(
        'External changes must be ordered after the cursor and at or before head.',
      );
    }
    previous = change.seq;
  }
  return read;
}

/**
 * Where the authority is in one store's log, and what each page of it after that changed. Until it
 * first reads the log it knows nothing of what changed while it was not following, and takes every
 * record of the store's tables for changed, once: a view it kept from before — a route every
 * visitor shares — is rendered again.
 */
export class ExternalFollower {
  readonly #store: ExternalStore;
  /** The tables read through the store, by their names in the declaration. */
  readonly #tables: ReadonlyMap<string, Table>;
  #at: { readonly seq: number; readonly epoch: string } | undefined;
  /** How long a read of a page of the log may take before it is a failed one. */
  readonly #readTimeoutMs: number;

  constructor(
    store: ExternalStore,
    tables: ReadonlyMap<string, Table>,
    readTimeoutMs: number = TAIL.readTimeoutMs,
  ) {
    this.#store = store;
    this.#tables = tables;
    this.#readTimeoutMs = readTimeoutMs;
  }

  async #changed(): Promise<readonly RowChange[]> {
    const rows: RowChange[] = [];
    for (let page = 0; page < TAIL.pagesAtOnce; page += 1) {
      const at = this.#at;
      const since = at?.seq ?? Number.MAX_SAFE_INTEGER;
      const asked = this.#store.changes(since, TAIL.pageSize);
      const read = checkedChanges(await withinDeadline(asked, this.#readTimeoutMs), since);
      if (at === undefined) {
        this.#at = { epoch: read.epoch, seq: read.head };
        return everyRecordOf(this.#tables);
      }
      if (read.epoch !== at.epoch || read.head < at.seq || read.floor > at.seq + 1) {
        this.#at = { epoch: read.epoch, seq: read.head };
        return everyRecordOf(this.#tables);
      }
      let { seq } = at;
      for (const change of read.changes) {
        const table = this.#tables.get(change.table);
        if (table !== undefined && change.seq > seq) {
          rows.push(rowOf(table, change.table, change));
        }
        seq = Math.max(seq, change.seq);
      }
      this.#at = { epoch: read.epoch, seq };
      if (read.changes.length < TAIL.pageSize) {
        break;
      }
    }
    return rows;
  }

  /**
   * What the store's log says changed since the last read of it, as rows a commit announces: every
   * record of its tables where the log is another one than the last read's, or let go of changes
   * the authority had not read yet.
   */
  async changed(
    ingest?: (rows: readonly RowChange[]) => Promise<void>,
  ): Promise<readonly RowChange[]> {
    const before = this.#at;
    try {
      const rows = await this.#changed();
      if (rows.length === 0) return rows;
      await ingest?.(rows);
      return rows;
    } catch (error) {
      // A failed read, or a failed local commit, consumed no part of the remote log. Replaying a
      // commit that landed before a later failure only evicts too much; skipping it loses changes.
      this.#at = before;
      throw error;
    }
  }
}
