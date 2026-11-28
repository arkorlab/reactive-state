import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { Json, RenderScope } from '../src/program.ts';
import { followDrizzle } from '../src/sql/index.ts';
import { engineOf } from './support/drizzle.ts';
import { databaseOf, poolOf, SERVER_TIMEOUT_MS, SERVER_URL } from './support/postgres.ts';

/**
 * A pool's plans are asked of one text and shared by every connection, so a setting one
 * connection's open transaction holds (`SET LOCAL search_path`) must reach no plan of theirs, nor
 * theirs that connection's: PGlite has one session, so what a transaction of another connection
 * does to the others is shown on a real PostgreSQL alone. The same text reads `public.tasks` under
 * the default search path and `other.tasks` under that transaction's.
 */

const tasks = pgTable('tasks', { id: text().primaryKey() });
const elsewhere = pgSchema('other').table('tasks', { id: text().primaryKey() });
const schema = { elsewhere, tasks };
const DDL = `
  CREATE TABLE tasks (id text PRIMARY KEY);
  INSERT INTO tasks VALUES ('a'), ('b');
  CREATE SCHEMA other;
  CREATE TABLE other.tasks (id text PRIMARY KEY);
  INSERT INTO other.tasks VALUES ('z');
`;
/** What a render's refusal says of a connection whose settings were changed. */
const REFUSED = /settings were changed/u;

/** A database of the tasks of both schemas, followed, and a pool of it through what follows them. */
async function pooled() {
  const { name, owner } = await databaseOf(DDL);
  const follow = followDrizzle(schema);
  for (const statement of follow.captureSql()) await owner.query(statement);
  const pool = poolOf(name, { max: 4 });
  const tracked = follow.client(pool);
  return { follow, orm: drizzle({ client: tracked, schema }), owner, pg: owner, tracked };
}

/** An engine whose render reads the ids of `tasks` through `connection`. */
async function rendering(
  setup: Awaited<ReturnType<typeof pooled>>,
  connection: Pick<Awaited<ReturnType<typeof pooled>>['tracked'], 'query'>,
) {
  const evaluate = vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
    const { rows } = await connection.query<{ id: string }>('SELECT id FROM tasks ORDER BY id');
    return $.h('p', null, rows.map((row) => row.id).join(','));
  });
  return engineOf(setup, evaluate);
}

/** A connection of the pool the application holds, given back as the test ends. */
async function held(setup: Awaited<ReturnType<typeof pooled>>) {
  const connection = await setup.tracked.connect();
  onTestFinished(() => {
    connection.release();
  });
  return connection;
}

/** Opens a transaction on `connection` that sets the search path for itself. */
async function localize(connection: Awaited<ReturnType<typeof held>>) {
  await connection.query('BEGIN');
  await connection.query('SET LOCAL search_path = other');
}

describe.skipIf(SERVER_URL === undefined)(
  'a pool whose connection holds a setting of its own',
  () => {
    it(
      'renders through another connection beside it, of the plan of the default search path',
      async () => {
        const setup = await pooled();
        const { render } = await rendering(setup, setup.tracked);
        await localize(await held(setup));

        await expect(render()).resolves.toContain('a,b');
      },
      SERVER_TIMEOUT_MS,
    );

    it(
      'refuses a render through it, which would read the other schema under the plan of this one',
      async () => {
        const setup = await pooled();
        const connection = await held(setup);
        // Each engine renders once, and all are made first: a new one moves the schema's generation.
        const ofHeld = await rendering(setup, connection);
        const ofPool = await rendering(setup, setup.tracked);

        await expect(ofPool.render()).resolves.toContain('a,b');

        await localize(connection);

        await expect(ofHeld.render()).rejects.toThrow(REFUSED);
      },
      SERVER_TIMEOUT_MS,
    );

    it(
      'keeps no plan asked under it for the renders of the pool after the transaction',
      async () => {
        const setup = await pooled();
        const connection = await held(setup);
        const ofHeld = await rendering(setup, connection);
        const ofPool = await rendering(setup, setup.tracked);
        await localize(connection);

        // Planned under the setting, the text would be kept as a read of `other.tasks`.
        await expect(ofHeld.render()).rejects.toThrow(REFUSED);

        await connection.query('COMMIT');

        await expect(ofPool.render()).resolves.toContain('a,b');

        await setup.owner.query("INSERT INTO tasks VALUES ('c')");
        await ofPool.engine.poke();

        await expect(ofPool.render()).resolves.toContain('a,b,c');
      },
      SERVER_TIMEOUT_MS,
    );

    it(
      'renders through the next transaction, which set nothing, as the one before it ended',
      async () => {
        const setup = await pooled();
        const connection = await held(setup);
        const ofHeld = await rendering(setup, connection);
        await localize(connection);
        await connection.query('COMMIT');
        await connection.query('BEGIN');

        await expect(ofHeld.render()).resolves.toContain('a,b');
      },
      SERVER_TIMEOUT_MS,
    );

    it(
      'renders through it after a text that ended the transaction before a statement of it failed',
      async () => {
        const setup = await pooled();
        const connection = await held(setup);
        const ofHeld = await rendering(setup, connection);
        await localize(connection);

        await expect(connection.query('COMMIT; SELECT 1 / 0')).rejects.toThrow(/division by zero/u);

        // `pg` tells a query's error before the server says it is ready: its state is the last
        // one's until then, and a statement answered after it is what waits for that.
        await connection.query('SELECT 1');

        await expect(ofHeld.render()).resolves.toContain('a,b');
      },
      SERVER_TIMEOUT_MS,
    );

    it(
      'refuses a render through it after a text that failed before it ended the transaction',
      async () => {
        const setup = await pooled();
        const connection = await held(setup);
        const ofHeld = await rendering(setup, connection);
        await localize(connection);
        await connection.query('SAVEPOINT sp');

        await expect(connection.query('SELECT 1 / 0; COMMIT')).rejects.toThrow(/division by zero/u);

        await connection.query('ROLLBACK TO SAVEPOINT sp');

        await expect(ofHeld.render()).rejects.toThrow(REFUSED);
      },
      SERVER_TIMEOUT_MS,
    );

    it(
      'renders through it once the transaction ended, as the setting ended with it',
      async () => {
        const setup = await pooled();
        const connection = await held(setup);
        const ofHeld = await rendering(setup, connection);
        await localize(connection);
        await connection.query('COMMIT');

        await expect(ofHeld.render()).resolves.toContain('a,b');
      },
      SERVER_TIMEOUT_MS,
    );
  },
);
