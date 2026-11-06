import { recordResource } from '../program.ts';
import type { Database } from './database.ts';
import { describeThrown } from './errors.ts';
import type { Memo } from './memo.ts';
import type { Commit, CommitEvent, CommitListener, Metrics } from './model.ts';
import type { PublicViews } from './public.ts';
import type { Sessions } from './sessions.ts';
import type { SharedViews } from './shared-views.ts';
import type { Tables } from './tables.ts';

/** One commit's transaction, then every dependent cache and listener: external records are never kept. */
interface CommitState {
  readonly db: Database;
  readonly sessions: Sessions;
  readonly clock: () => number;
  readonly shared: SharedViews;
  readonly metrics: Metrics;
  readonly tables: Tables;
  readonly publicViews: PublicViews;
  readonly memo: Memo;
  readonly listeners: ReadonlySet<CommitListener>;
}

export class Committer {
  readonly #state: CommitState;

  constructor(state: CommitState) {
    this.#state = state;
  }

  /** What follows a commit, outside its transaction: the records kept, the caches, the announcement. */
  #committed(event: CommitEvent, dirty: readonly string[]): void {
    this.#state.tables.apply(event.rows);
    this.#state.publicViews.committed(event);
    this.#state.metrics.memoEvictions += this.#state.memo.evict(event.rows);
    this.#state.shared.committed(dirty);
    // The commit is made whatever a listener does: one that throws changes neither its answer nor
    // what the others hear of it.
    for (const listener of this.#state.listeners) {
      try {
        listener(event);
      } catch (error) {
        // The authority's own log wherever it runs — stderr in Node, the object's log in workerd —
        // through the one writer both have.
        // eslint-disable-next-line no-console
        console.error(`A commit listener failed: ${describeThrown(error)}`);
      }
    }
  }

  /**
   * Commits records, with what lands beside them, in one transaction: each record whole — what it
   * keeps that the declaration no longer names kept as it was — the revision, the change log and,
   * through `with`, the operation's own record. What follows the commit outside SQLite follows it
   * at once, before anything else reads.
   */
  commit({ external, kind, resources = [], rows: given, with: alongside }: Commit): CommitEvent {
    // The rows as every reader of the commit is held to them, which `changedBy` gathers once.
    const rows = Object.freeze([...given]);
    // A change of an external table's log that tells not which record it was names none; a record
    // two rows name is named once.
    const records = [
      ...new Set(
        rows.flatMap((row) => (row.unknown === 'table' ? [] : [recordResource(row.table, row.id)])),
      ),
    ];
    const changed = [...records, ...resources];
    let dirty: readonly string[] = [];
    const revision = this.#state.db.transaction(() => {
      this.#state.sessions.sweep();
      const kept = external === true ? [] : rows;
      for (const { after, id, table } of kept) {
        if (after === null) {
          this.#state.db.deleteRecord(table, id);
        } else {
          this.#state.db.putRecord(table, id, { ...this.#state.db.record(table, id), ...after });
        }
      }
      // A version is a public record's rendering's, which no external table has: its records'
      // ids are named in the change log, and kept nowhere else.
      const versioned = external === true ? [] : records;
      const numbered = this.#state.db.advance(changed, kind, this.#state.clock(), versioned);
      alongside?.(numbered);
      // The shared views the commit changes are dirty from the commit on: no answer of it, nor of
      // anything after it, outruns the mark.
      dirty = this.#state.shared.dirtyBy(rows);
      return numbered;
    });
    // Fence every committed mutation before any cache or announcement can fail.
    this.#state.metrics.commits += 1;
    const event: CommitEvent = { changed, kind, revision, rows };
    this.#committed(event, dirty);
    return event;
  }
}
