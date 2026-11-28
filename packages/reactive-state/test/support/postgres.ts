import { Client, Pool, type PoolConfig } from 'pg';
import { onTestFinished } from 'vitest';

/**
 * The server `test/postgres-*.test.ts` run on, as a URL of a superuser, which makes and drops a
 * database a test and roles that sign in with no password: PGlite has one session, so what many
 * sessions do to the log and the pool is shown on a real PostgreSQL alone. Without it those tests
 * are skipped.
 */
export const SERVER_URL = process.env['REACTIVE_POSTGRES_URL'];

/** What a test of a real server may wait: a write behind a lock, and what a loaded machine adds. */
export const SERVER_TIMEOUT_MS = 60_000;

/** What a connection does of an error of its own: the end of a test kills what is left open. */
function ignored(): void {
  // No event of it is the test's.
}

/** The connection string of `database` on the server, of `user` where another is given. */
function urlOf(database: string, user?: string): string {
  const url = new URL(SERVER_URL ?? '');
  url.pathname = `/${database}`;
  if (user !== undefined) url.username = user;
  return url.href;
}

/** A connection to `database`, closed as the test ends. */
export async function clientOf(database: string): Promise<Client> {
  const client = new Client({ connectionString: urlOf(database) });
  await client.connect();
  client.on('error', ignored);
  onTestFinished(async () => {
    await client.end();
  });
  return client;
}

/** A pool of `database`, closed as the test ends: a connection string's user is before `options`'. */
export function poolOf(database: string, { user, ...options }: PoolConfig = {}): Pool {
  const pool = new Pool({ connectionString: urlOf(database, user), ...options });
  pool.on('error', ignored);
  onTestFinished(async () => {
    await pool.end();
  });
  return pool;
}

/** A database of its own, whose tables `ddl` makes, dropped as the test ends. */
export async function databaseOf(ddl: string): Promise<{ name: string; owner: Client }> {
  const name = `reactive_${String(process.pid)}_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: urlOf('postgres') });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  onTestFinished(async () => {
    const dropping = new Client({ connectionString: urlOf('postgres') });
    try {
      await dropping.connect();
      await dropping.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await dropping.end();
    }
  });
  const owner = await clientOf(name);
  await owner.query(ddl);
  return { name, owner };
}
