import { type AddressInfo, connect, createServer, type Socket } from 'node:net';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { Client, Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { hostOf } from '../src/authority/database-host.ts';
import { startAuthority } from '../src/authority/index.ts';
import { reactiveDb } from '../src/sql/db.ts';
import { followDrizzle } from '../src/sql/index.ts';

/**
 * `reactiveDb`, of which an application writes one line: PGlite of no server, or a server's pool of
 * `DATABASE_URL`, and an authority that opens all the rest itself as it is given the database.
 */

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text().notNull() });
const schema = { tasks };
const DDL = 'CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL)';
const BUILD = 'b_reactive_db';
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;

/** What an application's process has of the database's address: none, unless a test says. */
const environment = { database: process.env['DATABASE_URL'], pglite: process.env['PGLITE_DIR'] };

/** A PGlite of the tasks, served to `pg`, its address in `DATABASE_URL`. */
async function served() {
  const pg = await PGlite.create();
  await pg.exec(DDL);
  const server = new PGLiteSocketServer({ db: pg, host: '127.0.0.1', maxConnections: 6, port: 0 });
  await server.start();
  const port = server.getServerConn().split(':').at(-1) ?? '';
  process.env['DATABASE_URL'] = `postgres://postgres@127.0.0.1:${port}/postgres`;
  onTestFinished(async () => {
    await server.stop();
    await pg.close();
  });
  return pg;
}

/**
 * A link to `served`'s PGlite, which `DATABASE_URL` now names. Once it froze, what was connected
 * hears nothing, as over a network that was lost, and says nothing of it; a connection made after
 * it reaches the PGlite. Once it stalled, past the `count` it still answers, a connection is taken
 * and never answered, as by a server stuck in its startup.
 */
async function linked() {
  const address = new URL(process.env['DATABASE_URL'] ?? '');
  const { hostname, port } = address;
  const pairs: (readonly [Socket, Socket])[] = [];
  const stalled: Socket[] = [];
  let answered = Infinity;
  const proxy = createServer((near) => {
    near.on('error', vi.fn());
    if (pairs.length >= answered) {
      stalled.push(near);
      return;
    }
    const far = connect(Number(port), hostname);
    far.on('error', vi.fn());
    near.pipe(far);
    far.pipe(near);
    pairs.push([near, far]);
  });
  await new Promise<void>((resolve) => {
    proxy.listen(0, '127.0.0.1', resolve);
  });
  address.port = String((proxy.address() as AddressInfo).port);
  process.env['DATABASE_URL'] = address.href;
  onTestFinished(() => {
    for (const socket of pairs.flat()) socket.destroy();
    for (const socket of stalled) socket.destroy();
    proxy.close();
  });
  return {
    connections: () => pairs.length,
    freeze: () => {
      for (const socket of pairs.flat()) socket.unpipe().pause();
    },
    stall: (count = 0) => {
      answered = pairs.length + count;
    },
    thaw: () => {
      answered = Infinity;
      for (const [near, far] of pairs) {
        near.pipe(far);
        far.pipe(near);
      }
    },
  };
}

/** An authority of `db` alone, closed as the test ends. */
async function authorityOf(db: Awaited<ReturnType<typeof reactiveDb<typeof schema>>>['db']) {
  const authority = await startAuthority({ buildId: BUILD, database: db, programs: [] });
  onTestFinished(() => authority.close());
  return authority;
}

/**
 * A database as a role of `USAGE` and `SELECT` on the log reads it, which `seeding` ran the seed of
 * first, where it is given.
 */
async function asReader(seeding?: () => Promise<void>) {
  const { db, orm } = await reactiveDb(schema);
  await orm.execute(sql.raw(DDL));
  for (const statement of followDrizzle(schema).captureSql()) {
    await orm.execute(sql.raw(statement));
  }
  if (seeding !== undefined) {
    try {
      await hostOf(db)?.seed(seeding);
    } catch {
      // A seed that failed leaves what notes it, and no note.
    }
  }
  await orm.execute(sql.raw('CREATE ROLE reader'));
  await orm.execute(sql.raw('GRANT USAGE ON SCHEMA reactive_state TO reader'));
  await orm.execute(sql.raw('GRANT SELECT ON ALL TABLES IN SCHEMA reactive_state TO reader'));
  await orm.execute(sql.raw('REVOKE CREATE ON DATABASE postgres FROM PUBLIC'));
  await orm.execute(sql.raw('SET ROLE reader'));
  return { db, orm };
}

describe('reactiveDb', () => {
  beforeEach(() => {
    delete process.env['DATABASE_URL'];
    process.env['PGLITE_DIR'] = 'memory://';
  });

  afterEach(() => {
    if (environment.database === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = environment.database;
    if (environment.pglite === undefined) delete process.env['PGLITE_DIR'];
    else process.env['PGLITE_DIR'] = environment.pglite;
  });

  it(
    'is PGlite of no address, whose log the authority makes and is told of',
    async () => {
      const { db, orm } = await reactiveDb(schema);
      await orm.execute(sql.raw(DDL));
      const authority = await authorityOf(db);
      const poke = vi.spyOn(authority.engine, 'poke');

      await orm.insert(tasks).values({ id: 'a', title: 'one' });

      await vi.waitFor(() => {
        expect(poke).toHaveBeenCalledTimes(1);
      });

      await expect(
        orm.execute(sql`SELECT count(*)::int AS entries FROM reactive_state.changes`),
      ).resolves.toMatchObject({ rows: [{ entries: 1 }] });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is a server's pool of `DATABASE_URL`, whose log the authority makes and listens to",
    async () => {
      const pg = await served();
      const listened = vi.spyOn(Client.prototype, 'query');
      const { db, orm } = await reactiveDb(schema);
      await authorityOf(db);

      await orm.insert(tasks).values({ id: 'a', title: 'one' });

      expect(Reflect.get(orm, '$client')).toBeInstanceOf(Pool);
      // A notification of this PGlite goes to the session that wrote: `postgres-log.test.ts` hears it.
      expect(listened).toHaveBeenCalledWith('LISTEN reactive_state_changes');

      await expect(
        pg.query('SELECT count(*)::int AS entries FROM reactive_state.changes'),
      ).resolves.toMatchObject({ rows: [{ entries: 1 }] });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ends every connection of the database with the authority, once however often it is closed',
    async () => {
      await served();
      const { db, orm } = await reactiveDb(schema);
      const authority = await startAuthority({ buildId: BUILD, database: db, programs: [] });
      await orm.insert(tasks).values({ id: 'a', title: 'one' });

      await authority.close();
      await authority.close();

      expect((Reflect.get(orm, '$client') as Pool).ended).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ends every connection of the database where the authority does not start',
    async () => {
      await served();
      const taken = await reactiveDb(schema);
      const running = await authorityOf(taken.db);
      const { db, orm } = await reactiveDb(schema);
      const { port } = new URL(running.url);

      await expect(
        startAuthority({ buildId: BUILD, database: db, port: Number(port), programs: [] }),
      ).rejects.toThrow(/EADDRINUSE/u);

      expect((Reflect.get(orm, '$client') as Pool).ended).toBe(true);

      await expect(startAuthority({ buildId: BUILD, database: db, programs: [] })).rejects.toThrow(
        'make another with `reactiveDb`',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'serves one authority, as its close ends the connections: a second start leaves the first be',
    async () => {
      const { db, orm } = await reactiveDb(schema);
      await orm.execute(sql.raw(DDL));
      await authorityOf(db);

      await expect(startAuthority({ buildId: BUILD, database: db, programs: [] })).rejects.toThrow(
        'make another with `reactiveDb`',
      );

      await expect(orm.insert(tasks).values({ id: 'a', title: 'one' })).resolves.toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'lets go of a connection of the store that answers no more, and reads through another',
    async () => {
      await served();
      const link = await linked();
      const { db } = await reactiveDb(schema);
      const authority = await authorityOf(db);
      await authority.engine.poke();
      const before = link.connections();

      link.freeze();

      await expect(authority.engine.poke()).rejects.toThrow(/did not answer|read timeout/u);

      await authority.engine.poke();
      link.thaw();

      expect(link.connections()).toBe(before + 1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'gives up on a connection of the store the server never answers, for one that may',
    async () => {
      await served();
      const link = await linked();
      const { db } = await reactiveDb(schema);
      const authority = await authorityOf(db);
      link.stall();

      await expect(authority.engine.poke()).rejects.toThrow(/did not answer|timeout/u);

      link.thaw();

      await expect(authority.engine.poke()).resolves.toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not start for good on a connection of `LISTEN` the server never answers',
    async () => {
      await served();
      const link = await linked();
      const { db } = await reactiveDb(schema);
      link.stall(1);

      await expect(startAuthority({ buildId: BUILD, database: db, programs: [] })).rejects.toThrow(
        /timeout/u,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'closes though the link to the server was lost, and says so',
    async () => {
      await served();
      const link = await linked();
      const { db, orm } = await reactiveDb(schema);
      const authority = await startAuthority({ buildId: BUILD, database: db, programs: [] });
      await orm.insert(tasks).values({ id: 'a', title: 'one' });
      const said = vi.spyOn(console, 'error').mockImplementation(vi.fn());

      link.freeze();
      await authority.close();

      expect(said).toHaveBeenCalledWith(expect.stringContaining('still open'));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "takes a store an authority is given over the database's own",
    async () => {
      const { db, orm } = await reactiveDb(schema);
      await orm.execute(sql.raw(DDL));
      const read = { changes: [], epoch: 'e', floor: 0, head: 0 };
      const given = {
        changes: vi.fn().mockResolvedValue(read),
        count: vi.fn(),
        find: vi.fn(),
        get: vi.fn(),
      };

      const authority = await startAuthority({
        buildId: BUILD,
        database: db,
        programs: [],
        stores: { sql: given },
      });
      onTestFinished(() => authority.close());
      await authority.engine.poke();

      expect(given.changes).toHaveBeenCalledWith(expect.any(Number), expect.any(Number));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'goes on where the role may not make the log but may read it, and says so',
    async () => {
      const { db, orm } = await reactiveDb(schema);
      await orm.execute(sql.raw(DDL));
      for (const statement of followDrizzle(schema).captureSql()) {
        await orm.execute(sql.raw(statement));
      }
      await orm.execute(sql.raw('CREATE ROLE reader'));
      await orm.execute(sql.raw('GRANT USAGE ON SCHEMA reactive_state TO reader'));
      await orm.execute(sql.raw('GRANT SELECT ON ALL TABLES IN SCHEMA reactive_state TO reader'));
      await orm.execute(sql.raw('SET ROLE reader'));
      const said = vi.spyOn(console, 'error').mockImplementation(vi.fn());

      await expect(authorityOf(db)).resolves.toBeDefined();

      expect(said).toHaveBeenCalledWith(
        expect.stringContaining('followDrizzle(schema).captureSql()'),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops at any other failure of making the log, though it could read one',
    async () => {
      const { db, orm } = await reactiveDb(schema);
      await orm.execute(sql.raw(DDL));
      for (const statement of followDrizzle(schema).captureSql()) {
        await orm.execute(sql.raw(statement));
      }
      await orm.execute(sql.raw('SET default_transaction_read_only = on'));

      await expect(startAuthority({ buildId: BUILD, database: db, programs: [] })).rejects.toThrow(
        /read-only transaction/u,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops where a table lost its triggers and the role that reads the log may not make them',
    async () => {
      const { db, orm } = await reactiveDb(schema);
      await orm.execute(sql.raw(DDL));
      for (const statement of followDrizzle(schema).captureSql()) {
        await orm.execute(sql.raw(statement));
      }
      await orm.execute(sql.raw('DROP TRIGGER reactive_state_insert ON tasks'));
      await orm.execute(sql.raw('CREATE ROLE reader'));
      await orm.execute(sql.raw('GRANT USAGE ON SCHEMA reactive_state TO reader'));
      await orm.execute(sql.raw('GRANT SELECT ON ALL TABLES IN SCHEMA reactive_state TO reader'));
      await orm.execute(sql.raw('SET ROLE reader'));
      vi.spyOn(console, 'error').mockImplementation(vi.fn());

      const start = startAuthority({ buildId: BUILD, database: db, programs: [] });

      await expect(start).rejects.toThrow('no change of it would reach a page');
      await expect(start).rejects.toThrow('permission denied for table tasks');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops at a table it may not make triggers of, though it made the log and owns the next',
    async () => {
      const first = pgTable('first_t', { id: text().primaryKey() });
      const second = pgTable('second_t', { id: text().primaryKey() });
      const { db, orm } = await reactiveDb({ first, second });
      await orm.execute(sql.raw('CREATE TABLE first_t (id text PRIMARY KEY)'));
      await orm.execute(sql.raw('CREATE ROLE maker'));
      await orm.execute(sql.raw('GRANT CREATE ON DATABASE postgres TO maker'));
      await orm.execute(sql.raw('GRANT ALL ON SCHEMA public TO maker'));
      await orm.execute(sql.raw('SET ROLE maker'));
      await orm.execute(sql.raw('CREATE TABLE second_t (id text PRIMARY KEY)'));

      await expect(startAuthority({ buildId: BUILD, database: db, programs: [] })).rejects.toThrow(
        /permission denied for table first_t/u,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'says what to run where the role may neither make the log nor read it',
    async () => {
      const { db, orm } = await reactiveDb(schema);
      await orm.execute(sql.raw(DDL));
      await orm.execute(sql.raw('CREATE ROLE reader'));
      await orm.execute(sql.raw('REVOKE CREATE ON DATABASE postgres FROM PUBLIC'));
      await orm.execute(sql.raw('SET ROLE reader'));

      await expect(startAuthority({ buildId: BUILD, database: db, programs: [] })).rejects.toThrow(
        'Run the statements of `followDrizzle(schema).captureSql()` as the role that owns the tables, and grant',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves the seed where the role may not make its note, and says so',
    async () => {
      const { db, orm } = await asReader();
      const said = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      const first = vi.fn<() => Promise<void>>();

      await hostOf(db)?.seed(first);
      await orm.execute(sql.raw('RESET ROLE'));

      expect(first).not.toHaveBeenCalled();
      expect(said).toHaveBeenCalledWith(expect.stringContaining('may not note'));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs no seed it could not note, which would run again over what it wrote',
    async () => {
      const made = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('Not yet.'));
      const { db, orm } = await asReader(made);
      const said = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      const first = vi.fn<() => Promise<void>>();

      await hostOf(db)?.seed(first);
      await orm.execute(sql.raw('RESET ROLE'));

      expect(first).not.toHaveBeenCalled();
      expect(said).toHaveBeenCalledWith(expect.stringContaining('may not note'));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reads the note of a seed that ran, whatever the role may write, and says nothing',
    async () => {
      const { db, orm } = await asReader(vi.fn<() => Promise<void>>());
      const said = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      const first = vi.fn<() => Promise<void>>();

      await hostOf(db)?.seed(first);
      await orm.execute(sql.raw('RESET ROLE'));

      expect(first).not.toHaveBeenCalled();
      expect(said).not.toHaveBeenCalledWith(expect.stringContaining('may not note'));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is found by another copy of the package, as the authority may be of one',
    async () => {
      await served();
      const { db } = await reactiveDb(schema);

      vi.resetModules();
      const another = await import('../src/authority/database-host.ts');

      expect(another.hostOf(db)).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps a client of the host out of what it opens until the authority starts',
    async () => {
      await served();
      const connected = vi.spyOn(Client.prototype, 'connect');

      await reactiveDb(schema);

      expect(connected).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );
});
