import { recordResource, resourceOf } from '../program.ts';
import type { DatabaseDefinition } from '../server/schema.ts';
import { HTTP_NOT_FOUND } from '../status.ts';
import type { Database } from './database.ts';
import { refusal } from './errors.ts';
import { type Materialization, materialize } from './materialize.ts';
import type { CommitEvent, Metrics, PublicSnapshot } from './model.ts';
import { declarationDigest } from './records.ts';
import type { Tables } from './tables.ts';

/**
 * A record's public fields as anyone may see them — what a page rendered without a session shows —
 * and the authority's own rendering of them, kept beside the data (`materializations`) until a
 * commit changes the record: each is kept with the version of the record it was rendered from, and
 * the version of every record a commit changed is the commit's revision. A rendering made under
 * another declaration showed other fields, and is not kept.
 */
/**
 * The resources of a session's end — a demo session's (`session:<id>`), and the key the application's
 * server asserted sessions under (`session-key:<key>`): no rendering of a record reads a version of
 * either, and one for each that ever ended would only grow.
 */
const SESSION_RESOURCES = ['session:', 'session-key:'] as const;

export class PublicViews {
  readonly #db: Database;
  readonly #tables: Tables;
  readonly #metrics: Metrics;
  /** The digest of the declaration, which each rendering is kept under. */
  readonly #declaration: string;
  readonly #cache: Map<string, Materialization>;
  /** The revision each record last changed at; one that never changed is at 0. */
  readonly #versions: Map<string, number>;
  /**
   * The tables read through a store: none public, so none rendered here, and no version of their
   * records kept — however many the store's log names.
   */
  readonly #external: ReadonlySet<string>;

  constructor(db: Database, tables: Tables, definition: DatabaseDefinition, metrics: Metrics) {
    this.#db = db;
    this.#tables = tables;
    this.#metrics = metrics;
    this.#external = new Set(
      [...definition.tables].flatMap(([name, declared]) =>
        declared.external === undefined ? [] : [name],
      ),
    );
    this.#declaration = declarationDigest(definition);
    this.#versions = new Map(db.versions());
    this.#cache = new Map(db.materializations(this.#declaration));
  }

  #materialized(table: string, id: string): Materialization & { readonly cache: 'HIT' | 'MISS' } {
    const resource = recordResource(table, id);
    const cached = this.#cache.get(resource);
    if (cached !== undefined && this.current(cached.dependencies)) {
      this.#metrics.cacheHits += 1;
      return { ...cached, cache: 'HIT' };
    }
    this.#metrics.queryEvaluations += 1;
    const values = this.#tables.get(table, id);
    if (values === null) {
      throw refusal(HTTP_NOT_FOUND, 'NOT_FOUND', 'There is no such record.');
    }
    const shown = Object.fromEntries(
      this.#tables.table(table).public.map((field) => [field, values[field] ?? false]),
    );
    const entry = materialize(table, id, shown, { [resource]: this.#versions.get(resource) ?? 0 });
    this.#metrics.artifactRenders += 1;
    this.#cache.set(resource, entry);
    this.#db.saveMaterialization(resource, this.#declaration, entry);
    return { ...entry, cache: 'MISS' };
  }

  /** How many renderings are kept. */
  get size(): number {
    return this.#cache.size;
  }

  /** What follows a commit: the versions of the records it changed, and their renderings let go. */
  committed(event: CommitEvent): void {
    for (const resource of event.changed) {
      const table = resourceOf(resource)?.table;
      if (
        SESSION_RESOURCES.every((prefix) => !resource.startsWith(prefix)) &&
        (table === undefined || !this.#external.has(table))
      ) {
        this.#versions.set(resource, event.revision);
      }
    }
    for (const [key, entry] of this.#cache) {
      if (event.changed.some((resource) => Object.hasOwn(entry.dependencies, resource))) {
        this.#cache.delete(key);
        this.#metrics.invalidations += 1;
      }
    }
  }

  /** Whether each record `dependencies` names is at the version it names. */
  current(dependencies: Readonly<Record<string, number>>): boolean {
    return Object.entries(dependencies).every(
      ([resource, version]) => (this.#versions.get(resource) ?? 0) === version,
    );
  }

  /**
   * A record's public fields, of a table that has some, rendered: from the cache while the record
   * is as it was read; a record there is not is not found.
   */
  snapshot(table: string, id: string): PublicSnapshot {
    const entry = this.#materialized(table, id);
    // Copies of what the cache keeps, which the cache goes on reading: what the caller does to
    // them is its own.
    return {
      cache: entry.cache,
      dependencies: Object.freeze({ ...entry.dependencies }),
      html: entry.html,
      id,
      resultVersion: entry.result.resultVersion,
      revision: this.#db.revision(),
      table,
      values: Object.freeze({ ...entry.result.values }),
    };
  }
}
