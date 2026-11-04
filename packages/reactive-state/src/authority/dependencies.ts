import { recordResource, resourceOf, type Value } from '../program.ts';
import { canonicalJson } from './canonical.ts';
import { comparableOf, type KeptValues, matches, type Where } from './query.ts';

/** One record a commit changed, as it was before the commit and after it: `null` where none was. */
export interface RowChange {
  readonly table: string;
  readonly id: string;
  readonly before: KeptValues | null;
  readonly after: KeptValues | null;
  /**
   * Of an external table's change, what its store's log does not tell of it: the record's fields
   * (`fields`), which renders again every query of the table, or which record it was (`table`),
   * which renders again whatever read the table at all. `before` and `after` are `null` then.
   */
  readonly unknown?: 'fields' | 'table' | undefined;
}

/** A record's fields a commit's row kept, before the commit or after it, with the record's id. */
interface Image {
  readonly id: string;
  readonly values: KeptValues;
}

/**
 * What a commit's rows changed, gathered once for every reader held to them (`changedOf`): the
 * tables of rows that tell not which record, or not its fields; the records, by resource; and the
 * fields each row kept of each table, by a field's value as a query first asks of it.
 */
class Changed {
  /** The fields each row kept, before and after, by its table: of each row that kept them. */
  readonly #images = new Map<string, Image[]>();
  /** Those of each table by a field's value — `id` by the record's — made as a query first asks. */
  readonly #byValue = new Map<string, Map<string, Map<Value, Image[]>>>();
  /** The tables a row changed, of every row. */
  readonly tables = new Set<string>();
  /** The tables a row changed of which it tells not which record (`unknown: 'table'`). */
  readonly unknownTables = new Set<string>();
  /** The tables a row changed of which it tells not which record, or not its fields. */
  readonly uncertainTables = new Set<string>();
  /** The records the rows changed, by resource: of each row that tells which. */
  readonly records = new Set<string>();

  constructor(rows: readonly RowChange[]) {
    for (const row of rows) {
      this.tables.add(row.table);
      if (row.unknown === 'table') {
        this.unknownTables.add(row.table);
      } else {
        this.records.add(recordResource(row.table, row.id));
      }
      if (row.unknown !== undefined) {
        this.uncertainTables.add(row.table);
        continue;
      }
      let images = this.#images.get(row.table);
      if (images === undefined) {
        images = [];
        this.#images.set(row.table, images);
      }
      if (row.before !== null) images.push({ id: row.id, values: row.before });
      if (row.after !== null) images.push({ id: row.id, values: row.after });
    }
  }

  /** The fields kept of `table`, `images`, by the value each holds of `field`: made as first asked. */
  #byValueOf(
    table: string,
    field: string,
    images: readonly Image[],
  ): ReadonlyMap<Value, readonly Image[]> {
    let byField = this.#byValue.get(table);
    if (byField === undefined) {
      byField = new Map();
      this.#byValue.set(table, byField);
    }
    let byValue = byField.get(field);
    if (byValue === undefined) {
      byValue = new Map();
      for (const image of images) {
        const value = field === 'id' ? image.id : comparableOf(image.values, field);
        const same = byValue.get(value);
        if (same === undefined) {
          byValue.set(value, [image]);
        } else {
          same.push(image);
        }
      }
      byField.set(field, byValue);
    }
    return byValue;
  }

  /**
   * The fields kept of `table` that `where` may match: those of the value it asks of one of its
   * fields — what `matches` holds equal is one key of a `Map` — or every one where it asks none.
   */
  candidates(table: string, where: Where): readonly Image[] {
    const images = this.#images.get(table);
    if (images === undefined) return [];
    const [field] = Object.keys(where);
    if (field === undefined) return images;
    const value = where[field];
    // No value: what `matches` holds equal to nothing a record holds.
    if (value === undefined) return [];
    return this.#byValueOf(table, field, images).get(value) ?? [];
  }
}

/** Whether `a` and `b` hold a member alike: each of the fewer looked up in the other. */
function meet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const [fewer, more] = a.size <= b.size ? [a, b] : [b, a];
  for (const each of fewer) {
    if (more.has(each)) return true;
  }
  return false;
}

/** What each commit's rows changed, of rows frozen as a commit holds them: gathered once. */
const CHANGED = new WeakMap<readonly RowChange[], Changed>();

/** What `rows` changed: of rows that may change yet, gathered anew each time. */
function changedOf(rows: readonly RowChange[]): Changed {
  if (!Object.isFrozen(rows)) return new Changed(rows);
  let changed = CHANGED.get(rows);
  if (changed === undefined) {
    changed = new Changed(rows);
    CHANGED.set(rows, changed);
  }
  return changed;
}

/** What an evaluation read, as a store keeps it (`Dependencies.toJSON`). */
export interface KeptDependencies {
  readonly records: readonly string[];
  readonly queries: readonly (readonly [string, readonly Where[]])[];
}

/**
 * What an evaluation read, as a commit is held to it: each record it read by its id — one it found
 * missing too — and each query it made, by its table and `where`. A commit changes what the
 * evaluation would read when it changed a record the evaluation read, or a record a query names
 * before the commit or after it: one that leaves the query's answer, one that joins it — an empty
 * answer's first — and one that changes in it.
 */
export class Dependencies {
  /** What `kept` says was read, as `toJSON` kept it. */
  static of(kept: KeptDependencies): Dependencies {
    const dependencies = new Dependencies();
    for (const record of kept.records) {
      dependencies.#records.add(record);
      const table = resourceOf(record)?.table;
      if (table !== undefined) {
        dependencies.#recordTables.add(table);
      }
    }
    for (const [table, queries] of kept.queries) {
      for (const where of queries) {
        dependencies.query(table, where);
      }
    }
    return dependencies;
  }

  readonly #records = new Set<string>();
  /** The tables a record was read of, by their names. */
  readonly #recordTables = new Set<string>();
  /** The queries of each table, by what they ask: one asked twice is held to a commit once. */
  readonly #queries = new Map<string, Map<string, Where>>();

  /**
   * Whether `changed` names a record read, or a table read by a record of a row that tells not
   * which record it was.
   */
  #recordsChangedBy(changed: Changed): boolean {
    return meet(this.#recordTables, changed.unknownTables) || meet(this.#records, changed.records);
  }

  /**
   * Whether `changed` changes a query's answer: one of a table of a row that tells not which record
   * or not its fields, or one a row's fields match, before or after.
   */
  #queriesChangedBy(changed: Changed): boolean {
    // The tables both name, of the fewer: a commit of one row is held to a table's queries alone.
    const tables =
      this.#queries.size <= changed.tables.size ? this.#queries.keys() : changed.tables;
    for (const table of tables) {
      const queries = this.#queries.get(table);
      if (queries === undefined || !changed.tables.has(table)) continue;
      if (changed.uncertainTables.has(table)) return true;
      for (const where of queries.values()) {
        const images = changed.candidates(table, where);
        if (images.some((image) => matches(where, image.id, image.values))) return true;
      }
    }
    return false;
  }

  record(table: string, id: string): void {
    this.#records.add(recordResource(table, id));
    this.#recordTables.add(table);
  }

  query(table: string, where: Where): void {
    let queries = this.#queries.get(table);
    if (queries === undefined) {
      queries = new Map();
      this.#queries.set(table, queries);
    }
    queries.set(canonicalJson(where), where);
  }

  /** Takes in what `other` depends on: a component's, what each component it renders read too. */
  merge(other: Dependencies): void {
    for (const record of other.#records) {
      this.#records.add(record);
    }
    for (const table of other.#recordTables) {
      this.#recordTables.add(table);
    }
    for (const [table, queries] of other.#queries) {
      for (const where of queries.values()) {
        this.query(table, where);
      }
    }
  }

  /** Whether nothing was read: no record and no query. */
  get empty(): boolean {
    return this.#records.size === 0 && this.#queries.size === 0;
  }

  /** Whether any record or query read a table in `tables`. */
  reads(tables: ReadonlySet<string>): boolean {
    for (const table of tables) {
      if (this.#recordTables.has(table) || this.#queries.has(table)) return true;
    }
    return false;
  }

  /** What was read, as JSON a store keeps: the records by resource, the queries by table. */
  toJSON(): KeptDependencies {
    return {
      queries: [...this.#queries].map(([table, queries]) => [table, [...queries.values()]]),
      records: [...this.#records],
    };
  }

  /**
   * Whether a commit of `rows` changed anything read: what was read would be read otherwise — a
   * record read, a table read by a record of a row that tells not which, a query of a table of a
   * row that tells not which or not its fields, or a query a row's fields match, before or after.
   */
  changedBy(rows: readonly RowChange[]): boolean {
    const changed = changedOf(rows);
    return this.#recordsChangedBy(changed) || this.#queriesChangedBy(changed);
  }
}
