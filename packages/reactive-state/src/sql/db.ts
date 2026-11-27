import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import { type DatabaseHost, hostDatabase, hostOf } from '../authority/database-host.ts';
import { describeThrown, messageOf } from '../authority/errors.ts';
import { TAIL } from '../authority/external.ts';
import { type AnyDatabase, type Database, database } from '../server/schema.ts';
import { logOf, seededSql } from './capture.ts';
import { codeOf } from './client-plans.ts';
import type { Queryable } from './digest.ts';
import { type DrizzleFollow, followDrizzle, type FollowDrizzleOptions } from './index.ts';

/**
 * An application's database in one call, of its Drizzle schema: `DATABASE_URL`'s server through a
 * `pg.Pool`, or of none PGlite in this process. What it answers is what the application reads and
 * writes with; the authority it is given to does all else as it starts (`DatabaseHost`). A module of
 * its own, as `./drizzle` is bundled for Workers, which have neither.
 */

/** Where PGlite keeps a database between runs. */
const PGLITE_DIR = '.data/pglite';
/** How long the change log keeps an entry: a follower further behind renders everything again. */
const LOG = { keptMs: 3_600_000 } as const;
/** The SQLSTATE of a role that may not do what it asked. */
const PRIVILEGE = '42501';
/**
 * The advisory lock a host's migrations and first records run under, one of a database: of two hosts
 * that start at once, the second finds them done.
 */
const ALONE_LOCK = 0x72_73_73_64;
/** How long a close waits for a server, whose lost link would hold it for good. */
const CLOSE_MS = 5000;
/** The most of what a server said that a start's refusal quotes. */
const QUOTED = 500;
/** What an operator runs of a log a role may not make. */
const OWNER_RUNS =
  'the statements of `followDrizzle(schema).captureSql()` as the role that owns the tables';

/** What `reactiveDb` answers: what reads and writes the tables, and what the authority is given. */
export interface ReactiveDb<S extends Readonly<Record<string, unknown>>> {
  readonly orm: PgDatabase<PgQueryResultHKT, S>;
  readonly db: Database<DrizzleFollow<S>['tables']>;
}

/** A connection of `pg`'s, or of PGlite's, as the host reads and writes the log through it. */
type Connected<S> = Readonly<{ orm: unknown; host: DatabaseHost; schema?: S }>;

/** The namespace of `follow`'s log. */
function namespaceOf<S>(follow: DrizzleFollow<S>): string {
  return follow.channel.replace(/_changes$/u, '');
}

/** What a connection's failure comes to: of no listener, `pg` throws it at the process. */
function failed(error: Error): void {
  // eslint-disable-next-line no-console
  console.error(`A connection of the database failed: ${describeThrown(error)}`);
}

/**
 * Makes the log through `connection`, and each table's triggers, as each start does. A role that may
 * not make the log, as a production role need not, goes on where it may read one an operator made,
 * and says so; else it says what to run. A table's statement leaves triggers that stand as they are,
 * so a role that may not make them fails of a table that has none, whose changes would reach no page.
 */
async function capture<S>(connection: Queryable, follow: DrizzleFollow<S>): Promise<void> {
  const [log = '', ...tables] = follow.captureSql();
  try {
    await connection.query(log, []);
  } catch (error) {
    if (codeOf(error) !== PRIVILEGE) throw error;
    try {
      await follow.store(connection).changes(0, 1);
    } catch (error_) {
      throw new Error(
        `This role may neither make the change log nor read it. Run ${OWNER_RUNS}, and grant this one \`USAGE\` of the schema \`${namespaceOf(follow)}\` and \`SELECT\` on its tables: ${messageOf(error_, QUOTED)}`,
        { cause: error_ },
      );
    }
    // eslint-disable-next-line no-console
    console.error(
      `This role may not make the change log, so it is read as it stands: run ${OWNER_RUNS} after each migration.`,
    );
  }
  try {
    for (const table of tables) await connection.query(table, []);
  } catch (error) {
    if (codeOf(error) !== PRIVILEGE) throw error;
    throw new Error(
      `A followed table lacks its triggers, so no change of it would reach a page, and this role may not make them. Run ${OWNER_RUNS}: ${messageOf(error, QUOTED)}`,
      { cause: error },
    );
  }
}

/** What `seedOnce` reads of the note. */
interface Note {
  readonly noted: boolean;
  readonly may: boolean;
}

/** What `connection`'s database says of the seed, none where the role may read nothing of it. */
async function noteOf(connection: Queryable, namespace: string): Promise<Note | undefined> {
  const { seeded } = logOf(namespace);
  try {
    await connection.query(seededSql(namespace), []);
    const { rows } = await connection.query(
      `SELECT EXISTS (SELECT 1 FROM ${seeded}) AS "noted", pg_catalog.has_table_privilege($1::pg_catalog.text, 'INSERT') AS "may"`,
      [seeded],
    );
    return rows[0] as Note;
  } catch (error) {
    if (codeOf(error) !== PRIVILEGE) throw error;
    return undefined;
  }
}

/**
 * Runs `first` unless `connection`'s database says it ran, so that the application's first records
 * are plain inserts, as `database()`'s records are written once. The note is written once `first`
 * ended, so one that failed runs again; it is kept in the log's schema, which goes with the database
 * as the records do. A role that may not note it runs none, as what it wrote would be written again
 * at the next start, and says so.
 */
async function seedOnce<S>(
  connection: Queryable,
  follow: DrizzleFollow<S>,
  first: () => Promise<void>,
): Promise<void> {
  const namespace = namespaceOf(follow);
  const note = await noteOf(connection, namespace);
  if (note?.noted === true) return;
  if (note?.may !== true) {
    // eslint-disable-next-line no-console
    console.error(
      "This role may not note the application's first records, so its seed did not run: run `reactive dev` once as the role that owns the tables.",
    );
    return;
  }
  await first();
  await connection.query(`INSERT INTO ${logOf(namespace).seeded} DEFAULT VALUES`, []);
}

/** PGlite, of one connection: what the store reads through, and `LISTEN` holds, besides. */
async function inProcess<S extends Readonly<Record<string, unknown>>>(
  schema: S,
  follow: DrizzleFollow<S>,
): Promise<Connected<S>> {
  const [{ PGlite }, { drizzle }, migrator] = await Promise.all([
    import('@electric-sql/pglite'),
    import('drizzle-orm/pglite'),
    import('drizzle-orm/pglite/migrator'),
  ]);
  const directory = process.env['PGLITE_DIR'] ?? PGLITE_DIR;
  // PGlite makes its own directory, not the directories above it.
  if (!directory.includes('://')) mkdirSync(path.dirname(directory), { recursive: true });
  const pg = await PGlite.create(directory);
  const orm = drizzle({ client: follow.client(pg), schema });
  return {
    host: {
      close: () => pg.close(),
      listen: async (told) => {
        await pg.listen(follow.channel, told);
      },
      migrate: (migrationsFolder) => migrator.migrate(orm, { migrationsFolder }),
      open: async () => {
        await capture(pg, follow);
        return { [follow.storeName]: follow.store(pg) };
      },
      prune: () => follow.prune(pg, Date.now() - LOG.keptMs),
      alone: (work) => work(),
      seed: (first) => seedOnce(pg, follow, first),
    },
    orm,
  };
}

/**
 * Waits for `ending`, the end of a server's connections, at most `CLOSE_MS`: `pg` waits for each
 * connection it lent and for the server's answer, which a lost link holds back. What is left then
 * ends with the process.
 */
async function ended(ending: Promise<unknown>): Promise<void> {
  const { promise: late, resolve } = Promise.withResolvers<'late'>();
  const timer = setTimeout(resolve, CLOSE_MS, 'late');
  try {
    if ((await Promise.race([ending, late])) === 'late') {
      // eslint-disable-next-line no-console
      console.error(
        `A connection of the database was still open ${String(CLOSE_MS)} ms after the authority closed: its link was lost, or a query of it runs on.`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A server: the pool is the application's, and two connections are the host's. The store's is a pool
 * of one, whose reads the follower waits for as long as `TAIL.readTimeoutMs`: past it, the connection
 * is let go of and the next read makes another, as one a lost link holds would answer no read again,
 * and one a server never answers would hold the pool's one place. What may take longer runs on the
 * pool: making the log waits on a table's writers. `LISTEN` holds its own, whose loss leaves the
 * authority to its interval. None is opened until the authority starts.
 */
async function onServer<S extends Readonly<Record<string, unknown>>>(
  url: string,
  schema: S,
  follow: DrizzleFollow<S>,
): Promise<Connected<S>> {
  const [{ Client, Pool }, { drizzle }, migrator] = await Promise.all([
    import('pg'),
    import('drizzle-orm/node-postgres'),
    import('drizzle-orm/node-postgres/migrator'),
  ]);
  const connectionString = url;
  const pool = new Pool({ connectionString });
  const connectionTimeoutMillis = TAIL.readTimeoutMs;
  const store = new Pool({
    connectionString,
    connectionTimeoutMillis,
    max: 1,
    query_timeout: TAIL.readTimeoutMs,
  });
  const listening = new Client({ connectionString, connectionTimeoutMillis });
  pool.on('error', failed);
  store.on('error', failed);
  listening.on('error', failed);
  const orm = drizzle({ client: follow.client(pool), schema });
  const reads = store as unknown as Queryable;
  const queryable = pool as unknown as Queryable;
  let listened = false;
  return {
    host: {
      alone: async (work) => {
        const held = await pool.connect();
        held.on('error', failed);
        try {
          await held.query(`SELECT pg_catalog.pg_advisory_lock(${String(ALONE_LOCK)})`);
          await work();
        } finally {
          // Its session's end lets go of the lock.
          held.release(true);
        }
      },
      close: () =>
        ended(Promise.all([pool.end(), store.end(), ...(listened ? [listening.end()] : [])])),
      listen: async (told) => {
        listened = true;
        listening.on('notification', told);
        await listening.connect();
        await listening.query(`LISTEN ${follow.channel}`);
      },
      migrate: (migrationsFolder) => migrator.migrate(orm, { migrationsFolder }),
      open: async () => {
        await capture(queryable, follow);
        return { [follow.storeName]: follow.store(reads) };
      },
      prune: () => follow.prune(queryable, Date.now() - LOG.keptMs),
      seed: (first) => seedOnce(queryable, follow, first),
    },
    orm,
  };
}

/**
 * The application's tables of its Drizzle `schema`, to read and write with `orm`, and `db` for the
 * authority: the whole of the application's `@/db`.
 */
export async function reactiveDb<S extends Readonly<Record<string, unknown>>>(
  schema: S,
  options: FollowDrizzleOptions = {},
): Promise<ReactiveDb<S>> {
  const follow = followDrizzle(schema, options) as unknown as DrizzleFollow<S>;
  if (!('channel' in follow)) {
    throw new TypeError(
      "reactiveDb(): a schema of SQLite's tables is D1's, which a Worker's binding opens: follow it with `followDrizzle`.",
    );
  }
  const url = process.env['DATABASE_URL'];
  const connected =
    url === undefined ? await inProcess(schema, follow) : await onServer(url, schema, follow);
  const db = database<DrizzleFollow<S>['tables']>(follow.tables);
  hostDatabase(db, connected.host);
  return { db, orm: connected.orm as ReactiveDb<S>['orm'] };
}

/** Runs the application's migrations in `folder` on `db`, of `reactiveDb`, before its authority starts. */
export async function migrate(db: AnyDatabase, folder: string): Promise<void> {
  const host = hostOf(db);
  if (host === undefined) {
    throw new TypeError('migrate() takes the `db` of `reactiveDb`.');
  }
  await host.migrate(folder);
}
