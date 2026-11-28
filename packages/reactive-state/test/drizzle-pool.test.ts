import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { Client, Pool, type PoolClient, Query } from 'pg';
import { describe, expect, it, type MockInstance, onTestFinished, vi } from 'vitest';

import type { Json, ProgramUpdater, RenderScope } from '../src/program.ts';
import { database } from '../src/server/index.ts';
import { followDrizzle } from '../src/sql/index.ts';
import { COMPONENT, engineOf } from './support/drizzle.ts';
import { clientOf } from './support/frames.ts';

/**
 * `follow.client` of a `pg.Pool`, as production PostgreSQL gives it: real `pg` and Drizzle's
 * `node-postgres`, speaking PostgreSQL's protocol to a PGlite. A hand-written connection would say
 * nothing of `pg`'s own forms, as `pg` takes a statement of no values by the simple protocol, which
 * runs a text of several statements. The sessions a real server keeps apart are one here.
 */

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text().notNull() });
const schema = { tasks };
const DDL = `
  CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL);
  INSERT INTO tasks VALUES ('a', 'one'), ('b', 'two');
`;
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;
/** Connections of the pool, and those of the store and of what a test holds besides. */
const CONNECTIONS = { besides: 2, pool: 3 } as const;
const TITLE_SET = 'u_title';
/** PostgreSQL's oid of `character`, whose text compares of no trailing spaces. */
const BPCHAR = 1042;
const updaters: Readonly<Record<string, ProgramUpdater>> = {
  [TITLE_SET]: { keys: ['title'], kind: 'set' },
};

/** A PGlite of the tasks, its log made, served to a pool and to a client the store reads through. */
async function pooled() {
  const db = await PGlite.create();
  await db.exec(DDL);
  const server = new PGLiteSocketServer({
    db,
    host: '127.0.0.1',
    maxConnections: CONNECTIONS.pool + CONNECTIONS.besides,
    port: 0,
  });
  await server.start();
  const port = Number(server.getServerConn().split(':').at(-1));
  const config = { database: 'postgres', host: '127.0.0.1', port, ssl: false, user: 'postgres' };
  const pool = new Pool({ ...config, max: CONNECTIONS.pool });
  const store = new Client(config);
  await store.connect();
  const follow = followDrizzle(schema);
  for (const statement of follow.captureSql()) await store.query(statement);
  const tracked = follow.client(pool);
  onTestFinished(async () => {
    await pool.end();
    await store.end();
    await server.stop();
    await db.close();
  });
  return { config, follow, orm: drizzle({ client: tracked, schema }), pg: store, pool, tracked };
}

type Pooled = Awaited<ReturnType<typeof pooled>>;

/** A render of `read`, and whether a write renders it again. */
async function watching(setup: Pooled, read: () => unknown) {
  const evaluate = vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
    const rows = await read();
    return $.h('p', null, JSON.stringify(rows));
  });
  const { engine, render } = await engineOf(setup, evaluate);
  await render();
  return {
    engine,
    render,
    renders: async (write: () => Promise<unknown>): Promise<boolean> => {
      const before = evaluate.mock.calls.length;
      await write();
      await engine.poke();
      await render();
      return evaluate.mock.calls.length > before;
    },
  };
}

/** What a render of `read` answers, once. */
async function renderOf(setup: Pooled, read: () => unknown) {
  const { render } = await engineOf(setup, async (_props, $) =>
    $.h('p', null, JSON.stringify(await read())),
  );
  return render();
}

/** `method` of `client`, of a form its types take otherwise. */
function calling(
  client: Pool,
  method: 'connect' | 'emit' | 'end' | 'query',
  ...args: unknown[]
): unknown {
  return Reflect.apply(
    Reflect.get(client, method) as (...values: unknown[]) => unknown,
    client,
    args,
  );
}

/** The binding a render gives the title, as a page's setter sends it. */
function titleBinding(part: ReturnType<typeof clientOf>['part']) {
  const state = part.states['title'];
  if (state === undefined || !('field' in state) || state.binding === undefined) {
    throw new Error('The title is no state a setter writes.');
  }
  return state.binding;
}

/** The transaction status of the connection the pool gives next. */
async function statusOfNext({ pool }: Pooled) {
  const held = await pool.connect();
  const status = held.getTransactionStatus();
  held.release();
  return status;
}

/** How many tasks the database holds, read past what a render notes. */
async function tasksHeld({ pg }: Pooled) {
  const { rows } = await pg.query<{ held: number }>('SELECT count(*)::int AS held FROM tasks');
  return rows[0]?.held;
}

describe('follow.client of a pool', () => {
  it(
    'takes no connection of one session, whose transaction a concurrent render would read in',
    async () => {
      const setup = await pooled();
      const held = await setup.pool.connect();
      onTestFinished(() => {
        held.release();
      });

      expect(() => setup.follow.client(setup.pg)).toThrow('pg.Pool');
      expect(() => setup.follow.client(held)).toThrow('pg.Pool');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'follows what a render read of a table by its rows, as PGlite does',
    async () => {
      const setup = await pooled();
      const { orm } = setup;
      const { renders } = await watching(setup, () =>
        orm.select().from(tasks).where(eq(tasks.id, 'a')),
      );

      await expect(
        renders(() => orm.update(tasks).set({ title: 'other' }).where(eq(tasks.id, 'b'))),
      ).resolves.toBe(false);
      await expect(
        renders(() => orm.update(tasks).set({ title: 'new' }).where(eq(tasks.id, 'a'))),
      ).resolves.toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "runs no statement of a text of several, as `pg`'s simple protocol would",
    async () => {
      const setup = await pooled();

      await expect(
        renderOf(setup, () => setup.tracked.query('SELECT 1; DELETE FROM tasks')),
      ).rejects.toThrow(/a text of several statements/u);
      await expect(tasksHeld(setup)).resolves.toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['a connection reset', 'ECONNRESET'],
    ['a connection lost, of no code', undefined],
    ['a server of too many connections', '53300'],
    ['a server shutting down', '57P01'],
    ['a canceled statement', '57014'],
  ])(
    'plans no text that %s kept from its check, which runs a text of several',
    async (_what, code) => {
      const setup = await pooled();
      const refused = Object.assign(new Error('The check was not answered.'), { code });
      const render = renderOf(setup, async () => {
        const query = vi.spyOn(setup.pool, 'query') as MockInstance<() => Promise<unknown>>;
        query.mockRejectedValueOnce(refused);
        return setup.tracked.query('SELECT 1; DELETE FROM tasks');
      });

      await expect(render).rejects.toThrow('The check was not answered.');
      await expect(tasksHeld(setup)).resolves.toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'lets be what a plan of nulls is refused, of a text PostgreSQL took as one statement',
    async () => {
      const setup = await pooled();
      await setup.pg.query(`
        CREATE FUNCTION no_null(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
          BEGIN
            IF value IS NULL THEN RAISE EXCEPTION 'A value, please.'; END IF;
            RETURN value;
          END
        $$
      `);

      await expect(
        renderOf(setup, () => setup.tracked.query('SELECT no_null($1) FROM tasks', ['x'])),
      ).resolves.toContain('"x"');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'lets be what a plan of nulls is refused on a checked-out connection of no transaction',
    async () => {
      const setup = await pooled();
      await setup.pg.query(`
        CREATE FUNCTION no_null(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
          BEGIN
            IF value IS NULL THEN RAISE EXCEPTION 'A value, please.'; END IF;
            RETURN value;
          END
        $$
      `);

      await expect(
        renderOf(setup, async () => {
          const held = await setup.tracked.connect();
          try {
            return await held.query('SELECT no_null($1) FROM tasks', ['x']);
          } finally {
            held.release();
          }
        }),
      ).resolves.toContain('"x"');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs no statement of a text of several in a query object',
    async () => {
      const setup = await pooled();

      await expect(
        renderOf(setup, () => setup.tracked.query({ text: 'SELECT 1; DELETE FROM tasks' })),
      ).rejects.toThrow(/a text of several statements/u);
      await expect(tasksHeld(setup)).resolves.toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a write in a render, of Drizzle and of a query object',
    async () => {
      const setup = await pooled();

      await expect(
        renderOf(setup, () => setup.orm.update(tasks).set({ title: 'new' })),
      ).rejects.toThrow(/writes nothing/u);
      await expect(
        renderOf(setup, () => setup.tracked.query({ text: "DELETE FROM tasks WHERE id = 'a'" })),
      ).rejects.toThrow(/writes nothing/u);
      await expect(tasksHeld(setup)).resolves.toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'follows the rows of a query object, by the values it holds or those beside it',
    async () => {
      const setup = await pooled();
      const statement = 'SELECT title FROM tasks WHERE id = $1';
      const held = await watching(setup, () =>
        setup.tracked.query({ text: statement, values: ['a'] }),
      );

      await expect(
        held.renders(() => setup.pg.query("UPDATE tasks SET title = 'x' WHERE id = 'b'")),
      ).resolves.toBe(false);
      await expect(
        held.renders(() => setup.pg.query("UPDATE tasks SET title = 'x' WHERE id = 'a'")),
      ).resolves.toBe(true);

      const beside = await watching(setup, () =>
        // The values beside it are those `pg` runs it with.
        setup.tracked.query({ text: statement, values: ['b'] }, ['a']),
      );

      await expect(
        beside.renders(() => setup.pg.query("UPDATE tasks SET title = 'y' WHERE id = 'b'")),
      ).resolves.toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reads the text and values of a query object once, as it runs them',
    async () => {
      const setup = await pooled();
      let reads = 0;
      const shifting = {
        get text() {
          reads += 1;
          return reads === 1 ? 'SELECT id FROM tasks' : 'DELETE FROM tasks';
        },
      };

      await expect(renderOf(setup, () => setup.tracked.query(shifting))).resolves.toBeDefined();
      await expect(tasksHeld(setup)).resolves.toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it.each(['submit', 'callback'])(
    'refuses a `%s` a getter answers on a later read',
    async (member) => {
      const setup = await pooled();
      let reads = 0;
      const shifting = Object.defineProperty({ text: 'SELECT 1' }, member, {
        enumerable: true,
        get: () => {
          reads += 1;
          return reads === 1 ? undefined : vi.fn();
        },
      });

      await expect(
        renderOf(setup, () => calling(setup.tracked, 'query', shifting)),
      ).rejects.toThrow(/render/u);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "follows the whole table of a statement that binds its values by types of its own, as `pg`'s array of `types` does",
    async () => {
      const setup = await pooled();
      const types = Object.assign([BPCHAR], { getTypeParser: () => String });
      const read = 'SELECT title FROM tasks WHERE id = $1';
      const statement = { text: read, types, values: ['a '] };
      const { renders } = await watching(setup, () => calling(setup.tracked, 'query', statement));

      await expect(
        renders(() => setup.pg.query("UPDATE tasks SET title = 'x' WHERE id = 'a'")),
      ).resolves.toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "follows Drizzle's named statements",
    async () => {
      const setup = await pooled();
      const prepared = setup.orm
        .select()
        .from(tasks)
        .where(eq(tasks.id, sql.placeholder('id')))
        .prepare('one_task');
      const { renders } = await watching(setup, () => prepared.execute({ id: 'a' }));

      await expect(
        renders(() => setup.pg.query("UPDATE tasks SET title = 'x' WHERE id = 'b'")),
      ).resolves.toBe(false);
      await expect(
        renders(() => setup.pg.query("UPDATE tasks SET title = 'x' WHERE id = 'a'")),
      ).resolves.toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['a callback beside its text', 'query', 'SELECT 1', vi.fn()],
    ['a callback of its object', 'query', { callback: vi.fn(), text: 'SELECT 1' }],
    ['a submittable', 'query', new Query('SELECT 1')],
    ['a callback of a connection', 'connect', vi.fn()],
    ['the pool ended', 'end'],
    ['no text', 'query', { name: 'prepared' }],
  ])(
    'refuses %s in a render, whatever its code does with the refusal',
    async (_what, method, ...args) => {
      const setup = await pooled();

      await expect(
        renderOf(setup, async () => {
          try {
            await calling(setup.tracked, method as 'query', ...args);
          } catch {
            // The render's fault stands.
          }
        }),
      ).rejects.toThrow(/render/u);
      expect(setup.pool.ended).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs a callback and a submittable outside a render, as `pg` answers them',
    async () => {
      const setup = await pooled();
      const heard = vi.fn();

      expect(calling(setup.tracked, 'query', 'SELECT 1 AS one', heard)).toBeUndefined();

      await vi.waitFor(() => {
        expect(heard).toHaveBeenCalledTimes(1);
      });

      expect(heard.mock.calls[0]?.[1]).toMatchObject({ rows: [{ one: 1 }] });

      const held = await setup.tracked.connect();
      const query = new Query('SELECT 2 AS two');

      expect(held.query(query as never)).toBe(query);

      await new Promise((resolve) => {
        query.on('end', resolve);
      });
      held.release();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a transaction of a pool', () => {
  it(
    'reads in a render through the connection it holds, and gives it back',
    async () => {
      const setup = await pooled();
      const { orm, pool } = setup;
      const { renders } = await watching(setup, () =>
        orm.transaction((tx) => tx.select().from(tasks).where(eq(tasks.id, 'a'))),
      );

      expect(pool.idleCount).toBe(pool.totalCount);

      await expect(
        renders(() => orm.update(tasks).set({ title: 'other' }).where(eq(tasks.id, 'b'))),
      ).resolves.toBe(false);
      await expect(
        renders(() => orm.update(tasks).set({ title: 'new' }).where(eq(tasks.id, 'a'))),
      ).resolves.toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'opens with options in a render, and nests by savepoints',
    async () => {
      const setup = await pooled();
      const options = { accessMode: 'read only', isolationLevel: 'repeatable read' } as const;
      const inner = (tx: Parameters<Parameters<typeof setup.orm.transaction>[0]>[0]) =>
        tx.select().from(tasks);

      await expect(
        renderOf(setup, () => setup.orm.transaction((tx) => tx.transaction(inner), options)),
      ).resolves.toContain('one');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a write in a render, and gives the connection back',
    async () => {
      const setup = await pooled();
      const { orm, pool } = setup;

      await expect(
        renderOf(setup, () => orm.transaction((tx) => tx.delete(tasks))),
      ).rejects.toThrow(/writes nothing/u);
      await expect(tasksHeld(setup)).resolves.toBe(2);

      expect(pool.idleCount).toBe(pool.totalCount);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "says PostgreSQL's reason for a statement its plan was refused, which aborts the transaction",
    async () => {
      const setup = await pooled();

      await expect(
        renderOf(setup, () =>
          setup.orm.transaction((tx) => tx.execute(sql`SELECT 1 FROM missing`)),
        ),
      ).rejects.toThrow(/"missing" does not exist/u);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses what changes its context in a render',
    async () => {
      const setup = await pooled();

      await expect(
        renderOf(setup, () =>
          setup.orm.transaction((tx) => tx.execute(sql`SET LOCAL search_path = public`)),
        ),
      ).rejects.toThrow(/runs a query alone/u);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'moves no epoch outside a render, which would render everything again at each commit',
    async () => {
      const setup = await pooled();
      const { orm, pg, follow } = setup;
      const store = follow.store(pg);
      await store.changes(0, 10);
      const { epoch } = await store.changes(0, 10);

      await orm.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await tx.insert(tasks).values({ id: 'c', title: 'three' });
      });

      await expect(
        orm.transaction(async (tx) => {
          await tx.insert(tasks).values({ id: 'd', title: 'four' });
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');

      await expect(store.changes(0, 10)).resolves.toMatchObject({ epoch });
      await expect(tasksHeld(setup)).resolves.toBe(3);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'lets a checked-out connection run what its transaction needs by hand',
    async () => {
      const setup = await pooled();
      const held = await setup.tracked.connect();

      await held.query('BEGIN');
      await held.query("UPDATE tasks SET title = 'x' WHERE id = 'a'");
      await held.query('SELECT 1');
      await held.query('ROLLBACK');
      held.release();

      const { rows } = await setup.pg.query<{ title: string }>(
        "SELECT title FROM tasks WHERE id = 'a'",
      );

      expect(rows).toStrictEqual([{ title: 'one' }]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a render that settles beside a transaction of a pool', () => {
  it(
    'ends the transaction, and gives the connection back out of it',
    async () => {
      const setup = await pooled();
      const begun = Promise.withResolvers<undefined>();
      const settled = Promise.withResolvers<undefined>();
      const ended: Promise<unknown>[] = [];

      await expect(
        renderOf(setup, async () => {
          ended.push(
            setup.orm.transaction(async (tx) => {
              await tx.select().from(tasks);
              begun.resolve(undefined);
              await settled.promise;
            }),
          );
          await begun.promise;
          throw new Error('A sibling failed.');
        }),
      ).rejects.toThrow('A sibling failed.');

      settled.resolve(undefined);

      await expect(Promise.all(ended)).resolves.toBeDefined();
      await expect(statusOfNext(setup)).resolves.toBe('I');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rolls back a transaction whose statement came after it, and gives the connection back',
    async () => {
      const setup = await pooled();
      const begun = Promise.withResolvers<undefined>();
      const settled = Promise.withResolvers<undefined>();
      const ended: Promise<unknown>[] = [];

      await expect(
        renderOf(setup, async () => {
          ended.push(
            setup.orm.transaction(async (tx) => {
              begun.resolve(undefined);
              await settled.promise;
              return tx.select().from(tasks);
            }),
          );
          await begun.promise;
          throw new Error('A sibling failed.');
        }),
      ).rejects.toThrow('A sibling failed.');

      settled.resolve(undefined);

      await expect(Promise.all(ended)).rejects.toMatchObject({
        cause: { message: expect.stringContaining('after the evaluation') },
      });
      await expect(statusOfNext(setup)).resolves.toBe('I');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaks no connection of a transaction that opens after it',
    async () => {
      const setup = await pooled();
      const ended: Promise<unknown>[] = [];

      await expect(
        renderOf(setup, () => {
          ended.push(setup.orm.transaction(() => Promise.resolve()));
          throw new Error('A sibling failed.');
        }),
      ).rejects.toThrow('A sibling failed.');

      await expect(Promise.allSettled(ended)).resolves.toHaveLength(1);

      expect(setup.pool.idleCount).toBe(setup.pool.totalCount);
    },
    TEST_TIMEOUT_MS,
  );

  it.each(['in a render', 'outside one'])(
    'closes a connection given back in a transaction, %s',
    async (where) => {
      const setup = await pooled();
      const leave = async () => {
        const held = await setup.tracked.connect();
        await held.query('BEGIN');
        held.release();
      };

      await (where === 'in a render' ? renderOf(setup, leave) : leave());

      await expect(statusOfNext(setup)).resolves.toBe('I');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "closes a connection a callback's `done` gives back in a transaction",
    async () => {
      const setup = await pooled();
      const given = Promise.withResolvers<undefined>();

      calling(
        setup.tracked,
        'connect',
        async (_error: unknown, held: PoolClient, done: () => void) => {
          await held.query('BEGIN');
          done();
          given.resolve(undefined);
        },
      );
      await given.promise;

      await expect(statusOfNext(setup)).resolves.toBe('I');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves no listener of a connection a callback's `done` gives back",
    async () => {
      const setup = await pooled();
      const listeners = async () => {
        const held = await setup.pool.connect();
        const count = held.listenerCount('error');
        held.release();
        return count;
      };
      const before = await listeners();
      const borrow = () => {
        return new Promise<void>((resolve) => {
          calling(
            setup.tracked,
            'connect',
            (_error: unknown, _held: PoolClient, done: () => void) => {
              done();
              resolve();
            },
          );
        });
      };

      await borrow();
      await borrow();

      await expect(listeners()).resolves.toBe(before);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hears the error of a connection it holds, which a process would else die of',
    async () => {
      const setup = await pooled();
      const held = await setup.tracked.connect();

      expect(calling(held as unknown as Pool, 'emit', 'error', new Error('Lost.'))).toBe(true);

      held.release();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the session of a pool', () => {
  it.each([
    ['SET search_path = other'],
    ['set statement_timeout = 0'],
    ['RESET ALL'],
    ['DISCARD ALL'],
    ["SELECT set_config('search_path', 'other', false)"],
    [String.raw`SELECT U&"set\005fconfig"('search_path', 'other', false)`],
  ])(
    'refuses `%s` outside a render, as it would change one connection of many',
    async (statement) => {
      const setup = await pooled();

      await expect(setup.tracked.query(statement)).rejects.toThrow(/one connection/u);
      await expect(setup.tracked.query({ text: statement })).rejects.toThrow(/one connection/u);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs what a text only names of those, as a string or a statement of its own',
    async () => {
      const setup = await pooled();

      await expect(setup.tracked.query("SELECT 'SET search_path = other'")).resolves.toBeDefined();
      await expect(
        setup.tracked.query("UPDATE tasks SET title = 'reset all' WHERE id = 'a'"),
      ).resolves.toBeDefined();
      await expect(
        setup.tracked.query(String.raw`INSERT INTO tasks VALUES ('c', 'a\b')`),
      ).resolves.toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a state bound to a row, through a pool', () => {
  it(
    'reads the row and writes it, through the connections of the pool',
    async () => {
      const setup = await pooled();
      const db = database(setup.follow.tables);
      const { engine, rendered, session } = await engineOf(
        setup,
        (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
          const row = db.tasks.where(eq(tasks.id, 'a'));
          return $.client({ props: {}, slots: {}, states: { title: row.title } });
        },
        {},
        { updaters, writable: ['title'] },
      );
      const { part } = clientOf((await rendered()).tree, COMPONENT);

      await expect(
        engine.update(session, {
          binding: titleBinding(part),
          operationId: crypto.randomUUID(),
          updaterId: TITLE_SET,
          value: 'written',
        }),
      ).resolves.toBeDefined();

      const { rows } = await setup.pg.query<{ title: string }>(
        "SELECT title FROM tasks WHERE id = 'a'",
      );

      expect(rows).toStrictEqual([{ title: 'written' }]);
    },
    TEST_TIMEOUT_MS,
  );
});
