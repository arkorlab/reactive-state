import type { Value } from '../program.ts';
import { checkValue, type DatabaseDefinition, isRecordId, type Table } from '../server/schema.ts';
import type { RowChange } from './dependencies.ts';
import { storesBroughtBy } from './followed-stores.ts';
import type { KeptValues } from './query.ts';

/**
 * A database of the application's own, as the authority follows its change log: the store a
 * follow of its Drizzle schema brings (`followDrizzle`, `followed-stores.ts`), by the name the
 * follow's tables declare. The authority keeps none of its records, reads none and writes none:
 * the application's SQL reads them, and a render notes what it read (`readTables`), as any read is
 * noted (`Dependencies`); each change the store's log tells of is announced as a commit is, which
 * renders again what read the record — as Convex's queries are run again by its log.
 */

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

/** A database of the application's own, as the authority follows it: its change log. */
export interface ExternalStore {
  /** The changes after `since`, at most `limit` of them. */
  readonly changes: (since: number, limit: number) => Promise<ExternalChanges>;
}

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
 * The store each external table of `database` is read through: the one a follow of the database
 * brings (`followed-stores.ts`), made once — a fault of a follow given no connection. A fault, too,
 * where a table names a store no follow brought, which no read of it could answer.
 */
export function storesOf(database: DatabaseDefinition): ReadonlyMap<string, ExternalStore> {
  const brought = storesBroughtBy(database);
  const made = new Map<string, ExternalStore>();
  const byTable = new Map<string, ExternalStore>();
  for (const [name, table] of database.tables) {
    if (table.external === undefined) {
      continue;
    }
    const store = made.get(table.external) ?? brought?.get(table.external)?.();
    if (store === undefined) {
      throw new TypeError(
        `The table ${name} is read through the store \`${table.external}\`, which no follow of the authority's database brought: give it the database of the follows, \`followedDb(follow)\`.`,
      );
    }
    made.set(table.external, store);
    byTable.set(name, store);
  }
  return byTable;
}

/**
 * What a change kept of a record's fields, as a commit's rows hold them: each field read against
 * the declaration; `undefined` where it kept nothing or cannot satisfy the current declaration.
 * Historical values may have been corrected, deleted, or kept under an older declaration: their
 * change invalidates conservatively instead of keeping the cursor stuck behind them.
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
