import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import { type DatabaseHost, hostOf, LOG } from '../authority/database-host.ts';
import { describeThrown, messageOf } from '../authority/errors.ts';
import { type ExternalStore, TAIL } from '../authority/external.ts';
import type { AnyDatabase } from '../server/schema.ts';
import { logOf, seededSql } from './capture.ts';
import { codeOf } from './client-plans.ts';
import { checkServer } from './compat.ts';
import type { Queryable } from './digest.ts';
import { ownInternals, type TablesOfFollow } from './follow-internals.ts';
import { type FollowedDatabase, hostedDb } from './followed.ts';
import {
  type DrizzleFollow,
  followDrizzle,
  type FollowDrizzleOptions,
  type OfSqlite,
} from './index.ts';
import { publishedD1 } from './sqlite/bound-d1.ts';
import type { D1Binding } from './sqlite/client.ts';
import { d1Hosted } from './sqlite/d1-host.ts';
import type { DrizzleD1Follow } from './sqlite/follow.ts';
import { inSqliteFile } from './sqlite/host.ts';
import { ownChanges } from './sqlite/own-changes.ts';

/**
 * An application's database in one call, of its Drizzle schema: `DATABASE_URL`'s server through a
 * `pg.Pool`, or of none PGlite in this process; of a schema of SQLite's tables, D1's, the D1 a
 * deployment publishes to its Function, or of none a file in D1's shape (`sqlite/host.ts`). What it
 * answers is what the application reads and writes with; the authority it is given to does all
 * else as it starts (`DatabaseHost`). A module of its own, as `./drizzle` is bundled for Workers,
 * which have neither; a Worker's `./db` is `../cloudflare/db.ts`.
 */

/** Where PGlite keeps a database between runs. */
const PGLITE_DIR = '.data/pglite';
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
/** SQLite's code of a lock another connection holds, and the step between it and its extended codes. */
const BUSY = 5;
const EXTENDED_STEP = 256;
/** What an operator runs of a log a role may not make. */
const OWNER_RUNS =
  'the statements of `followDrizzle(schema).captureSql()` as the role that owns the tables';

/** What `reactiveDb` takes beside the schema: `followDrizzle`'s options, and the D1 of several. */
export interface ReactiveDbOptions extends FollowDrizzleOptions {
  /** The binding of the application's D1, where a deployment has several: of one, that one. */
  readonly binding?: string;
}

/**
 * What `reactiveDb` answers: what reads and writes the tables, of PostgreSQL's Drizzle or of D1's as
 * the schema is, and what the authority is given — of each table, as `followedDb`'s database, the
 * row a condition names alone (`db.<table>.where(…)`).
 */
export interface ReactiveDb<S extends Readonly<Record<string, unknown>>> {
  readonly orm: OfSqlite<S> extends true ? DrizzleD1Database<S> : PgDatabase<PgQueryResultHKT, S>;
  readonly db: FollowedDatabase<
    TablesOfFollow<OfSqlite<S> extends true ? DrizzleD1Follow<S> : DrizzleFollow<S>>
  >;
}

/**
 * A connection of `pg`'s, or of PGlite's, as the host reads and writes the log through it, and the
 * store that reads the log, of the connection the host holds for it.
 */
type Connected<S> = Readonly<{
  orm: unknown;
  host: DatabaseHost;
  store: () => ExternalStore;
  schema?: S;
}>;

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
      await ownInternals(follow).storeOf(connection).changes(0, 1);
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

/**
 * Takes a directory's lock, which is held until the process ends or `release` is called. PGlite is
 * one process's: a second that opened the same directory would write over what the first keeps in
 * memory, so that neither could open it again. A lock of SQLite's, of a file beside the directory,
 * which the system lets go of as the process ends, however it ends. One of this process's own
 * earlier evaluation of the application's `db` module (a hot reload) holds it as well.
 */
async function lockOf(directory: string): Promise<() => void> {
  const { DatabaseSync } = await import('node:sqlite');
  const lock = new DatabaseSync(`${directory}.lock`);
  try {
    lock.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    lock.close();
    const code: unknown = error instanceof Error ? Reflect.get(error, 'errcode') : undefined;
    if (typeof code !== 'number' || code % EXTENDED_STEP !== BUSY) throw error;
    throw new Error(
      `PGlite's directory ${directory} is open already, by another process or by an earlier evaluation of this module, and it serves one at a time. End the other (a \`reactive dev\` still running?), or name another directory with \`PGLITE_DIR\`, or set \`DATABASE_URL\` to a server both reach.`,
      { cause: error },
    );
  }
  return () => {
    if (lock.isOpen) lock.close();
  };
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
  // A URL of PGlite's (`memory://`) is of no directory, and one open of it is of its own.
  const onDisk = !directory.includes('://');
  // PGlite makes its own directory, not the directories above it.
  if (onDisk) mkdirSync(path.dirname(directory), { recursive: true });
  const release = onDisk
    ? await lockOf(directory)
    : () => {
        // Of no directory, no lock.
      };
  let pg: InstanceType<typeof PGlite>;
  try {
    pg = await PGlite.create(directory);
  } catch (error) {
    release();
    throw error;
  }
  const orm = drizzle({ client: follow.client(pg), schema });
  return {
    host: {
      close: async () => {
        try {
          await pg.close();
        } finally {
          release();
        }
      },
      listen: async (told) => {
        await pg.listen(follow.channel, told);
      },
      migrate: (migrationsFolder) => migrator.migrate(orm, { migrationsFolder }),
      open: () => capture(pg, follow),
      prune: () => follow.prune(pg, Date.now() - LOG.keptMs),
      alone: (work) => work(),
      seed: (first) => seedOnce(pg, follow, first),
    },
    orm,
    store: () => ownInternals(follow).storeOf(pg),
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
  // `LISTEN` is its one query: a link that stalls after the connection was made, before the server
  // answers it, would hold the authority's start for as long as the socket takes to fail.
  const listening = new Client({
    connectionString,
    connectionTimeoutMillis,
    query_timeout: TAIL.readTimeoutMs,
  });
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
        await checkServer(queryable);
        await capture(queryable, follow);
      },
      prune: () => follow.prune(queryable, Date.now() - LOG.keptMs),
      seed: (first) => seedOnce(queryable, follow, first),
    },
    orm,
    store: () => ownInternals(follow).storeOf(reads),
  };
}

/**
 * A deployment's D1, as its runtime publishes it to the Function: what the application's Drizzle
 * reads and writes there. Its authority is the Durable Object, of a binding of its own
 * (`../cloudflare/db.ts`), so what a host of Node's runs before an authority starts, it refuses.
 */
async function onPublishedD1<S extends Readonly<Record<string, unknown>>>(
  binding: D1Binding,
  schema: S,
  follow: DrizzleD1Follow<S>,
): Promise<Connected<S>> {
  const { drizzle } = await import('drizzle-orm/d1');
  const refused = (): Promise<never> => {
    return Promise.reject(
      new Error("A deployment's D1 is migrated and seeded by its own deploy, not by its Function."),
    );
  };
  return {
    host: {
      ...d1Hosted(binding, follow, LOG.keptMs),
      alone: (work) => work(),
      close: () => Promise.resolve(),
      listen: () => Promise.resolve(),
      migrate: refused,
      seed: refused,
    },
    // A write answers its own changes, not the rows the log's triggers wrote beside them.
    orm: drizzle(follow.client(ownChanges(binding)) as never, { schema }),
    store: () => ownInternals(follow).storeOf(binding),
  };
}

/**
 * The application's tables of its Drizzle `schema`, to read and write with `orm`, and `db` for the
 * authority: the whole of the application's `@/db`.
 */
export async function reactiveDb<S extends Readonly<Record<string, unknown>>>(
  schema: S,
  options: ReactiveDbOptions = {},
): Promise<ReactiveDb<S>> {
  const { binding: name, ...followed } = options;
  const follow = followDrizzle(schema, followed) as unknown as
    | DrizzleFollow<S>
    | DrizzleD1Follow<S>;
  if (!('channel' in follow)) {
    const published = publishedD1(name);
    const connected =
      published === undefined
        ? await inSqliteFile(schema, follow, LOG.keptMs)
        : await onPublishedD1(published, schema, follow);
    const db = hostedDb(follow, connected.host, connected.store);
    return { db, orm: connected.orm } as unknown as ReactiveDb<S>;
  }
  const url = process.env['DATABASE_URL'];
  const connected =
    url === undefined ? await inProcess(schema, follow) : await onServer(url, schema, follow);
  const db = hostedDb(follow, connected.host, connected.store);
  return { db, orm: connected.orm } as unknown as ReactiveDb<S>;
}

/** Runs the application's migrations in `folder` on `db`, of `reactiveDb`, before its authority starts. */
export async function migrate(db: AnyDatabase, folder: string): Promise<void> {
  const host = hostOf(db);
  if (host === undefined) {
    throw new TypeError('migrate() takes the `db` of `reactiveDb`.');
  }
  await host.migrate(folder);
}
