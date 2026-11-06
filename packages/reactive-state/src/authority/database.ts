import { randomBytes } from 'node:crypto';

import type { ChangeEvent } from '../program.ts';
import type { Materialization, PublicResult } from './materialize.ts';
import { integer, text } from './rows.ts';
import { META, MIGRATIONS, SCHEMA, SCHEMA_VERSION } from './schema.ts';
import type { SqlDriver } from './sql.ts';

/** The bytes of the key bindings are signed with. */
const SECRET_BYTES = 32;
/** Changes one read of the change log returns. */
const CHANGES_PAGE = 1000;

export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly expires: number;
  readonly active: boolean;
}

/** Whether an operation wrote a field (a page's setter) or ran a server operation. */
type OperationKind = 'field' | 'operation';

/**
 * An operation, as it is kept: whose it was, what it was — its fingerprint, which a resend under
 * its id must match — and what it answered (`outcome`, JSON), which a resend answers again.
 */
export interface OperationRow {
  readonly sessionId: string;
  readonly id: string;
  readonly kind: OperationKind;
  readonly fingerprint: string;
  readonly revision: number;
  readonly created: number;
  readonly outcome: string;
}

/** A record as it is kept: its id, and its fields as the JSON object they were written as. */
export interface KeptRecord {
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * A change as the log keeps it. Which of its resources a page without a session may show is the
 * declaration's to say, and the engine reads it from there as it answers (`published`).
 */
type LoggedChange = Omit<ChangeEvent, 'published'>;

/**
 * The first text past every one that starts with `prefix`, by SQLite's order of text: its last
 * character's next, which the receipts' key (`session_id, id`) is read up to as a range.
 */
function pastPrefix(prefix: string): string {
  const last = prefix.codePointAt(prefix.length - 1) ?? 0;
  return `${prefix.slice(0, -1)}${String.fromCodePoint(last + 1)}`;
}

function dataOf(table: string, id: string, json: string): Readonly<Record<string, unknown>> {
  const data: unknown = JSON.parse(json);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new TypeError(`The record ${table}/${id} is not kept as an object`);
  }
  return data as Readonly<Record<string, unknown>>;
}

/**
 * The authority's SQL, statement by statement, over whichever SQLite holds it (`SqlDriver`), and
 * nothing else: no queue and no rule of the protocol, which the engine keeps. Each method is one
 * statement, or one read of one, except those the engine runs inside a `transaction` with what
 * they belong with: `advance`, with the writes it numbers; `endSession` and `endExpiredSessions`,
 * which take a session's operations with it; `endKey` and `sweepAsserted`, which take asserted
 * sessions' receipts with what they end; and `acknowledge`, with the changes it lets go of.
 */
export class Database {
  readonly #sql: SqlDriver;
  /** Whether this open made the database's tables: one just made, not one opened before. */
  readonly made: boolean;

  constructor(sql: SqlDriver) {
    this.#sql = sql;
    this.made = this.#open();
  }

  /**
   * Makes the tables of a database that has none, in one transaction: it lands whole, or the
   * database stays as it was. A database of another schema is refused: this authority would read
   * what it holds as something else — unless it is of one `MIGRATIONS` brings up to this
   * (`#migrate`).
   */
  #open(): boolean {
    this.#sql.run(META);
    this.#migrate();
    const schema = this.#meta('schema');
    if (schema === String(SCHEMA_VERSION)) {
      for (const statement of SCHEMA) {
        this.#sql.run(statement);
      }
      return false;
    }
    if (schema !== undefined) {
      throw new Error(
        `The authority's database is of schema ${schema}, and this authority reads schema ${String(SCHEMA_VERSION)}: open it with the authority that wrote it, or start from a new one.`,
      );
    }
    this.#sql.transaction(() => {
      for (const statement of SCHEMA) {
        this.#sql.run(statement);
      }
      this.#sql.run('INSERT INTO meta VALUES (?, ?)', 'schema', String(SCHEMA_VERSION));
    });
    return true;
  }

  /**
   * Brings a database of an earlier schema up to this one, where `MIGRATIONS` says how: in one
   * transaction, which lands whole, the new version with it, or leaves the database as it was.
   */
  #migrate(): void {
    const migration = MIGRATIONS.get(this.#meta('schema') ?? '');
    if (migration === undefined) {
      return;
    }
    this.#sql.transaction(() => {
      for (const statement of migration) {
        this.#sql.run(statement);
      }
      this.#sql.run("UPDATE meta SET value = ? WHERE key = 'schema'", String(SCHEMA_VERSION));
    });
  }

  #meta(key: string): string | undefined {
    const row = this.#sql.get('SELECT value FROM meta WHERE key = ?', key);
    return row === undefined ? undefined : text(row, 'value');
  }

  /** Runs `body` as one transaction: every statement in it lands, or none does. */
  transaction<T>(body: () => T): T {
    return this.#sql.transaction(body);
  }

  close(): void {
    this.#sql.close();
  }

  /** The key bindings are signed with, made on first open and kept with the data. */
  bindingSecret(): string {
    const kept = this.#meta('binding_secret');
    if (kept !== undefined) {
      return kept;
    }
    const made = randomBytes(SECRET_BYTES).toString('hex');
    this.#sql.run('INSERT INTO meta VALUES (?, ?)', 'binding_secret', made);
    return made;
  }

  revision(): number {
    return Number(this.#meta('revision') ?? 0);
  }

  versions(): ReadonlyMap<string, number> {
    const rows = this.#sql.all('SELECT * FROM versions');
    return new Map(rows.map((row) => [text(row, 'resource'), integer(row, 'version')]));
  }

  session(id: string): SessionRow | undefined {
    const row = this.#sql.get('SELECT * FROM sessions WHERE id = ?', id);
    return row === undefined
      ? undefined
      : {
          active: integer(row, 'active') === 1,
          expires: integer(row, 'expires'),
          id: text(row, 'id'),
          userId: text(row, 'user_id'),
        };
  }

  insertSession(id: string, userId: string, expires: number): void {
    this.#sql.run('INSERT INTO sessions VALUES (?, ?, ?, 1)', id, userId, expires);
  }

  /**
   * Ends a session: its row goes, and its operations with it — they answered only resends of its
   * own operations, which an ended session can no longer make.
   */
  endSession(id: string): void {
    this.#sql.run('DELETE FROM operations WHERE session_id = ?', id);
    this.#sql.run('DELETE FROM sessions WHERE id = ?', id);
  }

  /** Ends, as `endSession` does, every session that expired by `now`. */
  endExpiredSessions(now: number): void {
    this.#sql.run(
      'DELETE FROM operations WHERE session_id IN (SELECT id FROM sessions WHERE expires <= ?)',
      now,
    );
    this.#sql.run('DELETE FROM sessions WHERE expires <= ?', now);
  }

  /** Until when the key an application's server asserted sessions under stays ended, if it was. */
  endedUntil(key: string): number | undefined {
    const row = this.#sql.get('SELECT until FROM ended WHERE key = ?', key);
    return row === undefined ? undefined : integer(row, 'until');
  }

  /**
   * Ends a key the application's server asserted sessions under, until `until`, with the receipts
   * of every operation of a session under it (`prefix`, its sessions' ids' common start).
   */
  endKey(key: string, until: number, prefix: string): void {
    this.#sql.run(
      'INSERT INTO ended VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET until = max(until, excluded.until)',
      key,
      until,
    );
    this.#sql.run(
      'DELETE FROM operations WHERE session_id >= ? AND session_id < ?',
      prefix,
      pastPrefix(prefix),
    );
  }

  /**
   * Lets go of what no asserted session needs any more: the ended keys whose sessions have all
   * expired by `now`, and the receipts of asserted sessions' operations made before `before`, which
   * no resend presents again (`prefix`, every asserted session's id's start).
   */
  sweepAsserted(now: number, before: number, prefix: string): void {
    this.#sql.run('DELETE FROM ended WHERE until <= ?', now);
    this.#sql.run(
      'DELETE FROM operations WHERE session_id >= ? AND session_id < ? AND created < ?',
      prefix,
      pastPrefix(prefix),
      before,
    );
  }

  /**
   * Every record of a table, its fields as they are kept. What they hold is the engine's to read
   * against the declaration: one written before the declaration changed may hold no field, or
   * fields it no longer declares.
   */
  records(table: string): readonly KeptRecord[] {
    return this.#sql.all('SELECT id, data FROM records WHERE tbl = ?', table).map((row) => {
      const id = text(row, 'id');
      return { data: dataOf(table, id, text(row, 'data')), id };
    });
  }

  /** A record's fields as they are kept, or nothing for no record. */
  record(table: string, id: string): Readonly<Record<string, unknown>> | undefined {
    const row = this.#sql.get('SELECT data FROM records WHERE tbl = ? AND id = ?', table, id);
    return row === undefined ? undefined : dataOf(table, id, text(row, 'data'));
  }

  /** Writes a record whole, made or replaced. */
  putRecord(table: string, id: string, data: Readonly<Record<string, unknown>>): void {
    this.#sql.run(
      'INSERT INTO records VALUES (?, ?, ?) ON CONFLICT(tbl, id) DO UPDATE SET data = excluded.data',
      table,
      id,
      JSON.stringify(data),
    );
  }

  deleteRecord(table: string, id: string): void {
    this.#sql.run('DELETE FROM records WHERE tbl = ? AND id = ?', table, id);
  }

  /** Makes a record unless there is one already: whether it was made. */
  /**
   * Makes a record the declaration seeds, the first time the database is opened with it: one it was
   * seeded with before is never made again, so a seeded record deleted since stays deleted.
   */
  seedRecord(table: string, id: string, data: Readonly<Record<string, unknown>>): boolean {
    if (
      this.#sql.get('SELECT 1 AS seeded FROM seeded WHERE tbl = ? AND id = ?', table, id) !==
      undefined
    ) {
      return false;
    }
    this.#sql.run('INSERT INTO seeded VALUES (?, ?)', table, id);
    return this.insertRecord(table, id, data);
  }

  insertRecord(table: string, id: string, data: Readonly<Record<string, unknown>>): boolean {
    if (this.record(table, id) !== undefined) {
      return false;
    }
    this.#sql.run('INSERT INTO records VALUES (?, ?, ?)', table, id, JSON.stringify(data));
    return true;
  }

  /** The operation a session named `id`, as it was kept. */
  operation(sessionId: string, id: string): OperationRow | undefined {
    const row = this.#sql.get(
      'SELECT * FROM operations WHERE session_id = ? AND id = ?',
      sessionId,
      id,
    );
    return row === undefined
      ? undefined
      : {
          created: integer(row, 'created'),
          fingerprint: text(row, 'fingerprint'),
          id: text(row, 'id'),
          kind: text(row, 'kind') as OperationKind,
          outcome: text(row, 'outcome'),
          revision: integer(row, 'revision'),
          sessionId: text(row, 'session_id'),
        };
  }

  insertOperation(row: OperationRow): void {
    this.#sql.run(
      'INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?, ?)',
      row.sessionId,
      row.id,
      row.kind,
      row.fingerprint,
      row.revision,
      row.created,
      row.outcome,
    );
  }

  /** Keeps what an operation answered in the end, where it answered after its commit. */
  settleOperation(sessionId: string, id: string, outcome: string): void {
    this.#sql.run(
      'UPDATE operations SET outcome = ? WHERE session_id = ? AND id = ?',
      outcome,
      sessionId,
      id,
    );
  }

  /** The newest writes of a session to fields at or before `revision`, at most `limit` of them. */
  fieldOperations(sessionId: string, revision: number, limit: number): readonly string[] {
    return this.#sql
      .all(
        "SELECT id FROM operations WHERE session_id = ? AND kind = 'field' AND revision <= ? ORDER BY revision DESC LIMIT ?",
        sessionId,
        revision,
        limit,
      )
      .map((row) => text(row, 'id'));
  }

  operationCount(): number {
    const row = this.#sql.get('SELECT COUNT(*) AS n FROM operations');
    return row === undefined ? 0 : integer(row, 'n');
  }

  /**
   * Numbers a change: the revision, the version of each changed resource that is `versioned`, and
   * the change log.
   */
  advance(
    changed: readonly string[],
    kind: ChangeEvent['kind'],
    now: number,
    versioned: readonly string[] = changed,
  ): number {
    const revision = this.revision() + 1;
    this.#sql.run("UPDATE meta SET value = ? WHERE key = 'revision'", String(revision));
    for (const resource of versioned) {
      this.#sql.run(
        'INSERT INTO versions VALUES (?, ?) ON CONFLICT(resource) DO UPDATE SET version = excluded.version',
        resource,
        revision,
      );
    }
    this.#sql.run(
      'INSERT INTO changes VALUES (?, ?, ?, ?, ?)',
      revision,
      `event:${String(revision)}`,
      JSON.stringify(changed),
      kind,
      now,
    );
    return revision;
  }

  changes(since: number): readonly LoggedChange[] {
    return this.#sql
      .all(
        'SELECT * FROM changes WHERE revision > ? ORDER BY revision LIMIT ?',
        since,
        CHANGES_PAGE,
      )
      .map((row) => {
        return {
          changed: JSON.parse(text(row, 'changed')) as string[],
          created: integer(row, 'created'),
          eventId: text(row, 'event_id'),
          kind: text(row, 'kind') as ChangeEvent['kind'],
          revision: integer(row, 'revision'),
        };
      });
  }

  /**
   * Moves a consumer's cursor forward, never back, and lets go of the changes every consumer has
   * taken: the log keeps what one has yet to take. With no consumer, it keeps everything.
   */
  acknowledge(consumer: string, revision: number): void {
    this.#sql.run(
      'INSERT INTO deliveries VALUES (?, ?) ON CONFLICT(consumer) DO UPDATE SET revision = MAX(deliveries.revision, excluded.revision)',
      consumer,
      revision,
    );
    this.#sql.run('DELETE FROM changes WHERE revision <= (SELECT MIN(revision) FROM deliveries)');
  }

  /**
   * A consumer's cursor. A consumer it has not met is registered at the start as it asks, so that
   * the log keeps for it, from then on, what it has yet to take.
   */
  delivery(consumer: string): number {
    this.#sql.run('INSERT OR IGNORE INTO deliveries VALUES (?, 0)', consumer);
    const row = this.#sql.get('SELECT revision FROM deliveries WHERE consumer = ?', consumer);
    return row === undefined ? 0 : integer(row, 'revision');
  }

  /**
   * The materializations rendered under `declaration`, the digest of the database's declaration:
   * one rendered under another showed another declaration's fields, as it read them then.
   */
  materializations(declaration: string): ReadonlyMap<string, Materialization> {
    const rows = this.#sql.all('SELECT * FROM materializations WHERE declaration = ?', declaration);
    return new Map(
      rows.map((row) => {
        return [
          text(row, 'key'),
          {
            dependencies: JSON.parse(text(row, 'dependencies')) as Record<string, number>,
            html: text(row, 'html'),
            result: JSON.parse(text(row, 'result')) as PublicResult,
          },
        ];
      }),
    );
  }

  saveMaterialization(key: string, declaration: string, entry: Materialization): void {
    this.#sql.run(
      'INSERT OR REPLACE INTO materializations VALUES (?, ?, ?, ?, ?)',
      key,
      declaration,
      JSON.stringify(entry.dependencies),
      JSON.stringify(entry.result),
      entry.html,
    );
  }
}
