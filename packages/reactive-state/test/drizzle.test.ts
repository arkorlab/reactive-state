import { asc, eq, sql } from 'drizzle-orm';
import { pgSchema, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it, vi } from 'vitest';

import type { Json, RenderScope } from '../src/program.ts';
import { followDrizzle } from '../src/sql/index.ts';
import { keyDigest } from '../src/sql/reads.ts';
import { engineOf, openedWith } from './support/drizzle.ts';

/** The application's tables, which its Drizzle reads and writes and the authority follows. */
const projects = pgTable('projects', { id: text().primaryKey(), title: text().notNull() });
const tasks = pgTable('tasks', {
  id: text().primaryKey(),
  projectId: text('project_id').notNull(),
  title: text().notNull(),
});
const archive = pgSchema('archive');
const archived = archive.table('archived', { id: text().primaryKey() });
const schema = { archived, projects, tasks };
const BUILD = 'b_drizzle';
/** Long enough that only `poke()` reads the log in a test. */
const IDLE_POLL_MS = 60_000;
/** How many statements' plans a connection keeps (`client.ts`). */
const KEPT_PLANS = 1024;

/** An operation whose code runs, and writes nothing. */
async function noop(): Promise<void> {
  await Promise.resolve();
}

/** A statement of its own text for each `number`, which a connection keeps a plan of each of. */
function numbered(number: number): string {
  return `SELECT id FROM tasks WHERE ${String(number)} > 0`;
}

/** The statement a plan of `statement` is asked by. */
function explained(statement: string): string {
  return `EXPLAIN (GENERIC_PLAN, VERBOSE, FORMAT JSON) DECLARE "reactive_state_plan" NO SCROLL CURSOR FOR ${statement}`;
}

/** A PGlite of the application's tables and their change log, and its Drizzle. */
async function opened() {
  return openedWith(
    schema,
    `
    CREATE TABLE projects (id text PRIMARY KEY, title text NOT NULL);
    CREATE TABLE tasks (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects (id), title text NOT NULL);
    CREATE TABLE untracked (id text PRIMARY KEY);
    CREATE VIEW task_titles AS SELECT id, title FROM tasks;
    CREATE SCHEMA archive;
    CREATE TABLE archive.archived (id text PRIMARY KEY);
    INSERT INTO projects VALUES ('p1', 'Launch');
    INSERT INTO tasks VALUES ('t1', 'p1', 'Write docs');
  `,
  );
}

/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;

describe('tables of a Drizzle schema in PostgreSQL', { timeout: TEST_TIMEOUT_MS }, () => {
  it('renders again what read a table its log says changed, and nothing else', async () => {
    const setup = await opened();
    const evaluate = vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
      const rows = await setup.orm
        .select({ project: projects.title, title: tasks.title })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .orderBy(asc(tasks.id));
      return $.h('p', null, rows.map((row) => `${row.project}: ${row.title}`).join(', '));
    });
    const { engine, render } = await engineOf(setup, evaluate);

    await expect(render()).resolves.toBe('Launch: Write docs');

    await setup.orm.insert(archived).values({ id: 'a1' });
    await engine.poke();
    await render();

    expect(evaluate).toHaveBeenCalledExactlyOnceWith({}, expect.anything());

    await setup.orm.update(projects).set({ title: 'Ship' }).where(eq(projects.id, 'p1'));
    await engine.poke();

    await expect(render()).resolves.toBe('Ship: Write docs');
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("answers an operation once the log has told of the operation's own writes", async () => {
    const setup = await opened();
    const rename = async (): Promise<void> => {
      await setup.orm.update(tasks).set({ title: 'Renamed' }).where(eq(tasks.id, 't1'));
    };
    const { operate, render } = await engineOf(
      setup,
      async (_props, $) => {
        const [task] = await setup.orm.select().from(tasks).where(eq(tasks.id, 't1'));
        return $.h('p', null, task?.title);
      },
      { 'actions/tasks': { rename } },
    );

    await expect(render()).resolves.toBe('Write docs');

    await operate('actions/tasks', 'rename');

    await expect(render()).resolves.toBe('Renamed');
  });

  it('follows the tables a view reads in its place', async () => {
    const setup = await opened();
    const { engine, render } = await engineOf(setup, async (_props, $) => {
      const answered = await setup.orm.execute<{ title: string }>(
        sql`SELECT title FROM task_titles WHERE id = ${'t1'}`,
      );
      return $.h('p', null, answered.rows.map((row) => row.title).join(','));
    });

    await expect(render()).resolves.toBe('Write docs');

    await setup.pg.query("UPDATE tasks SET title = 'Edited by hand' WHERE id = 't1'");
    await engine.poke();

    await expect(render()).resolves.toBe('Edited by hand');
  });

  it('logs each row a statement changed, a truncation, and nothing of one that changed none', async () => {
    const setup = await opened();
    const store = setup.follow.store(setup.pg);
    const { head } = await store.changes(0, 10);

    await setup.orm.update(tasks).set({ title: 'none' }).where(eq(tasks.id, 'missing'));
    await setup.orm.insert(tasks).values([
      { id: 't2', projectId: 'p1', title: 'two' },
      { id: 't3', projectId: 'p1', title: 'three' },
    ]);
    await setup.pg.query('TRUNCATE tasks');

    const read = await store.changes(head, 10);

    // Each row's key values — `id`, the primary key, alone — and the truncation, of the table alone.
    expect(read.changes).toStrictEqual([
      {
        after: { k_id: keyDigest('t2') },
        before: null,
        id: 'row',
        seq: head + 1,
        table: 'tasks',
      },
      {
        after: { k_id: keyDigest('t3') },
        before: null,
        id: 'row',
        seq: head + 2,
        table: 'tasks',
      },
      { id: '', seq: head + 3, table: 'tasks' },
    ]);
    expect(read.head).toBe(head + 3);
  });

  it('logs each row a move across partitions takes out, though the partition it goes to skips it', async () => {
    const parted = pgTable('parted', { id: text().primaryKey(), region: text().notNull() });
    const setup = await openedWith(
      { parted },
      `
      CREATE TABLE parted (id text, region text NOT NULL, PRIMARY KEY (id, region)) PARTITION BY LIST (region);
      CREATE TABLE parted_eu PARTITION OF parted FOR VALUES IN ('eu');
      CREATE TABLE parted_us PARTITION OF parted FOR VALUES IN ('us');
      CREATE FUNCTION skipped() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id IN ('b', 'd') THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER skipped BEFORE INSERT ON parted_us FOR EACH ROW EXECUTE FUNCTION skipped();
      INSERT INTO parted VALUES ('a', 'eu'), ('b', 'eu'), ('d', 'eu');
    `,
    );
    const store = setup.follow.store(setup.pg);
    const { head } = await store.changes(0, 10);

    // `a` moves; `b`, then `d` alone, are taken out and put nowhere.
    await setup.pg.query("UPDATE parted SET region = 'us' WHERE id IN ('a', 'b')");
    await setup.pg.query("UPDATE parted SET region = 'us' WHERE id = 'd'");
    const read = await store.changes(head, 10);

    expect(read.head).toBe(head + 4);
    expect(
      read.changes.map((change) => [change.before?.['k_id'], change.after?.['k_id']]),
    ).toStrictEqual(
      expect.arrayContaining([
        [keyDigest('a'), undefined],
        [keyDigest('b'), undefined],
        [undefined, keyDigest('a')],
        [keyDigest('d'), undefined],
      ]),
    );
  });

  it('reads the catalog and the digest of a table whose name holds a backslash, of strings of no standard', async () => {
    const odd = pgTable('odd\\', { id: text().primaryKey() });
    const setup = await openedWith(
      { odd },
      String.raw`CREATE TABLE "odd\" (id text PRIMARY KEY); INSERT INTO "odd\" VALUES ('a');`,
    );
    await setup.pg.exec('SET standard_conforming_strings = off');
    const evaluate = vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
      const rows = await setup.orm.execute(sql`SELECT id FROM ${odd} WHERE id = 'a'`);
      return $.h('p', null, JSON.stringify(rows.rows));
    });
    const { render } = await engineOf(setup, evaluate);

    await expect(render()).resolves.toContain('"a"');

    const { epoch } = await setup.follow.store(setup.pg).changes(0, 10);

    expect(epoch).not.toContain('unread');
  });

  it('keeps its log and head when its statements run again, and its head when pruned', async () => {
    const setup = await opened();
    const store = setup.follow.store(setup.pg);
    await setup.orm.insert(tasks).values({ id: 't2', projectId: 'p1', title: 'two' });
    const before = await store.changes(0, 10);
    for (const statement of setup.follow.captureSql()) {
      await setup.pg.query(statement);
    }

    const again = await store.changes(0, 10);

    // The statements change nothing of the schema a plan reads: the log, its entries, its head and
    // its epoch are kept.
    expect(again).toStrictEqual(before);

    await setup.follow.prune(setup.pg, Date.now() + IDLE_POLL_MS);

    await expect(store.changes(0, 10)).resolves.toStrictEqual({
      ...again,
      changes: [],
      floor: again.head + 1,
    });
  });

  it.each([
    {
      what: 'a write',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.orm.update(tasks).set({ title: 'x' }).where(eq(tasks.id, 't1')),
      refused: 'writes nothing',
    },
    {
      what: 'a read that locks its rows',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.orm.select().from(tasks).where(eq(tasks.id, 't1')).for('update'),
      refused: 'locks no rows',
    },
    {
      what: 'a read of a subquery that locks its rows',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.orm.execute(sql`SELECT id FROM (SELECT id FROM tasks FOR SHARE) locked`),
      refused: 'locks no rows',
    },
    {
      what: 'a read that selects into a table',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.orm.execute(sql.raw('SELECT id INTO copied FROM tasks')),
      refused: 'INTO is not allowed here',
    },
    {
      what: 'a statement by the raw protocol',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.pg.execProtocolRaw(new Uint8Array()),
      refused: 'never `execProtocolRaw`',
    },
    {
      what: 'a statement by a stream of the raw protocol',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.pg.execProtocolStream(new Uint8Array()),
      refused: 'never `execProtocolStream`',
    },
    {
      what: 'a read that selects into a table past a comment a carriage return ends',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.orm.execute(sql.raw('SELECT id -- note\rINTO copied FROM tasks')),
      refused: 'INTO is not allowed here',
    },
    {
      what: 'a read that selects into a table past an escape string continued',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.orm.execute(sql.raw("SELECT E'a'\n'\\'' AS v INTO copied FROM tasks")),
      refused: 'INTO is not allowed here',
    },
    {
      what: 'a channel listened on by text that writes',
      read: async (setup: Awaited<ReturnType<typeof opened>>) => {
        await setup.pg.listen("x; UPDATE tasks SET title = 'written'", () => {
          // A refused listen hears nothing.
        });
      },
      refused: 'never `listen`',
    },
    {
      what: 'a statement described off the connection’s turn',
      read: (setup: Awaited<ReturnType<typeof opened>>) => setup.pg.describeQuery('SELECT 1'),
      refused: 'never `describeQuery`',
    },
    {
      what: 'a read that selects into a table past an escape string continued past a comment',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.orm.execute(sql.raw("SELECT E'a' -- c\n'\\' x ' AS v INTO copied FROM tasks --'")),
      refused: 'INTO is not allowed here',
    },
    {
      what: 'a setting a transaction leaves the session',
      read: async (setup: Awaited<ReturnType<typeof opened>>) => {
        await setup.orm.transaction(async (tx) =>
          tx.execute(sql.raw("set transaction.who = 'render'")),
        );
      },
      refused: 'writes nothing',
    },
    {
      what: 'a savepoint and a statement more',
      read: async (setup: Awaited<ReturnType<typeof opened>>) => {
        await setup.orm.transaction(async (tx) =>
          tx.execute(sql.raw('savepoint sp1; SELECT id FROM tasks')),
        );
      },
      refused: 'writes nothing',
    },
    {
      what: 'a method the connection keys by a symbol',
      read: async (setup: Awaited<ReturnType<typeof opened>>) => {
        await setup.pg[Symbol.asyncDispose]();
      },
      refused: 'Symbol.asyncDispose',
    },
    {
      what: 'a read that selects into a table after a number of underscores',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.orm.execute(sql.raw('SELECT 1_000. INTO copied FROM tasks')),
      refused: 'INTO is not allowed here',
    },
    {
      what: 'a read that selects into a table past a string continued past a vertical tab',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.orm.execute(sql.raw("SELECT E'x'\v\n'\\'' INTO copied FROM tasks --'")),
      refused: 'INTO is not allowed here',
    },
    {
      what: 'a read that selects into a table after a label named as',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.orm.execute(sql.raw('SELECT 1 AS as INTO copied FROM tasks')),
      refused: 'INTO is not allowed here',
    },
    {
      what: 'a read that selects into a table after a column named as',
      read: (setup: Awaited<ReturnType<typeof opened>>) => {
        const statement = 'SELECT named.as INTO copied FROM (SELECT id AS as FROM tasks) AS named';
        return setup.orm.execute(sql.raw(statement));
      },
      refused: 'INTO is not allowed here',
    },
    {
      what: 'a read that selects into a table after a quoted label',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.orm.execute(sql.raw('SELECT 1 AS "n" INTO copied FROM tasks')),
      refused: 'INTO is not allowed here',
    },
    {
      what: 'a read that selects into a table after a quoted column',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.orm.execute(sql.raw('SELECT "tasks"."id" INTO copied FROM tasks')),
      refused: 'INTO is not allowed here',
    },
    {
      what: 'a read that selects into a table after a number ending in a point',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.orm.execute(sql.raw('SELECT 1. INTO copied FROM tasks')),
      refused: 'INTO is not allowed here',
    },
    {
      what: 'a read that selects into a table past a name of letters beyond ASCII',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.orm.execute(sql.raw('SELECT id AS ñ$a$ INTO copied FROM tasks -- $a$')),
      refused: 'INTO is not allowed here',
    },
    {
      what: 'a table nothing follows',
      read: (setup: Awaited<ReturnType<typeof opened>>) =>
        setup.orm.execute(sql`SELECT id FROM untracked`),
      refused: 'public.untracked',
    },
    {
      what: 'a statement by exec',
      read: (setup: Awaited<ReturnType<typeof opened>>) => setup.pg.exec('SELECT 1'),
      refused: 'never `exec`',
    },
  ])('fails a render that runs $what, though it catches the refusal', async ({ read, refused }) => {
    const setup = await opened();
    const client = setup.follow.client(setup.pg);
    const tracked = { ...setup, orm: drizzle({ client, schema }), pg: client };
    const { render } = await engineOf(tracked, async (_props, $) => {
      let answered = 'read';
      try {
        await read(tracked);
      } catch {
        answered = 'caught';
      }
      return $.h('p', null, answered);
    });

    await expect(render()).rejects.toThrow(refused);
  });

  it('runs no other statement of a text it plans', async () => {
    const setup = await opened();
    const { render } = await engineOf(setup, async (_props, $) => {
      let answered = 'read';
      try {
        await setup.orm.execute(sql.raw("SELECT 1; UPDATE tasks SET title = 'written'"));
      } catch {
        answered = 'caught';
      }
      return $.h('p', null, answered);
    });

    await expect(render()).rejects.toThrow('multiple commands');

    await expect(
      setup.pg.query("SELECT id FROM tasks WHERE title = 'written'"),
    ).resolves.toMatchObject({
      rows: [],
    });
  });

  it('follows what a statement reads whatever values its first render ran it with', async () => {
    const setup = await opened();
    const roles = ['viewer', 'owner'];
    const evaluate = vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
      const role = roles.shift() ?? 'owner';
      const rows = await setup.orm
        .select({ title: tasks.title })
        .from(tasks)
        .where(sql`${role} = 'owner'`);
      return $.h('p', null, rows.map((row) => row.title).join(','));
    });
    const { engine, render } = await engineOf(setup, evaluate);

    await expect(render()).resolves.toBe('');

    await setup.orm.update(tasks).set({ title: 'Edited' }).where(eq(tasks.id, 't1'));
    await engine.poke();

    await expect(render()).resolves.toBe('Edited');
  });

  it.each([
    ['as it runs alone', false],
    ['in a transaction', true],
  ])(
    'lets a component catch what its values make the database refuse, the first time it reads a text too, %s',
    async (_, inTransaction) => {
      const setup = await opened();
      const statement = sql`SELECT id FROM tasks WHERE length(id) = ${'abc'}::int`;
      const { render } = await engineOf(setup, async (_props, $) => {
        let answered = 'read';
        try {
          await (inTransaction
            ? setup.orm.transaction(async (tx) => tx.execute(statement))
            : setup.orm.execute(statement));
        } catch {
          answered = 'caught';
        }
        return $.h('p', null, answered);
      });

      await expect(render()).resolves.toBe('caught');
    },
  );

  it('answers each of the queries a render runs at once, those of texts it plans too', async () => {
    const setup = await opened();
    const offsets = Array.from({ length: 41 }, (_, index) => index);
    const titleOf = async (): Promise<string> => {
      const [task] = await setup.orm
        .select({ title: tasks.title })
        .from(tasks)
        .where(eq(tasks.id, 't1'));
      return task?.title ?? 'none';
    };
    const planned = async (offset: number): Promise<void> => {
      for (let turn = 0; turn < offset; turn += 1) {
        await Promise.resolve();
      }
      await setup.orm.execute(sql.raw(`SELECT ${String(offset)} AS n FROM tasks`));
    };
    const { render } = await engineOf(setup, async (_props, $) => {
      const titles: string[] = [];
      for (const offset of offsets) {
        const [title] = await Promise.all([titleOf(), planned(offset)]);
        titles.push(title);
      }
      return $.h('p', null, [...new Set(titles)].join(','));
    });

    await expect(render()).resolves.toBe('Write docs');
  });

  it('renders a read whose plan of null values the database refuses, as its values it takes', async () => {
    const setup = await opened();
    const { render } = await engineOf(setup, async (_props, $) => {
      const answered = await setup.orm.execute<{ n: number }>(
        sql`SELECT array_length(array_fill(0, ARRAY[${3}::int]), 1) AS n FROM tasks`,
      );
      return $.h('p', null, answered.rows.map((row) => String(row.n)).join(','));
    });

    await expect(render()).resolves.toBe('3');
  });

  it('fails a render whose plan of nulls PostgreSQL refuses in a transaction, saying why', async () => {
    const setup = await opened();
    const { render } = await engineOf(setup, async (_props, $) => {
      const answered = await setup.orm.transaction(async (tx) =>
        tx.execute(sql`SELECT array_length(array_fill(0, ARRAY[${3}::int]), 1) AS n FROM tasks`),
      );
      return $.h('p', null, String(answered.rows.length));
    });

    await expect(render()).rejects.toThrow('cannot be null');
  });

  it('follows what a render reads in a transaction of its own options, and one nested in it', async () => {
    const setup = await opened();
    const { engine, render } = await engineOf(setup, async (_props, $) => {
      const rows = await setup.orm.transaction(
        async (tx) => {
          return tx.transaction(async (inner) =>
            inner.select({ title: tasks.title }).from(tasks).where(eq(tasks.id, 't1')),
          );
        },
        { accessMode: 'read only', isolationLevel: 'repeatable read' },
      );
      return $.h('p', null, rows.map((row) => row.title).join(','));
    });

    await expect(render()).resolves.toBe('Write docs');

    await setup.orm.update(tasks).set({ title: 'Edited' }).where(eq(tasks.id, 't1'));
    await engine.poke();

    await expect(render()).resolves.toBe('Edited');
  });

  it('follows what a render reads in a transaction', async () => {
    const setup = await opened();
    const { engine, render } = await engineOf(setup, async (_props, $) => {
      const rows = await setup.orm.transaction(async (tx) =>
        tx.select({ title: tasks.title }).from(tasks).where(eq(tasks.id, 't1')),
      );
      return $.h('p', null, rows.map((row) => row.title).join(','));
    });

    await expect(render()).resolves.toBe('Write docs');

    await setup.orm.update(tasks).set({ title: 'Edited' }).where(eq(tasks.id, 't1'));
    await engine.poke();

    await expect(render()).resolves.toBe('Edited');
  });

  it('renders a read whose strings, names and comments say into', async () => {
    const setup = await opened();
    const read = [
      `SELECT 'into' AS "into" FROM tasks -- into`,
      'SELECT id /* into /* nested into */ into */ FROM tasks',
      'SELECT $q$ into $q$ AS t, $$into$$ AS u FROM tasks',
      'SELECT $ñ$ into $ñ$ AS t FROM tasks',
      'SELECT id AS into FROM tasks',
      'SELECT named.into FROM (SELECT id AS into FROM tasks) AS named',
      'SELECT "named".into FROM (SELECT id AS /* a label */ into FROM tasks) AS "named"',
      'SELECT 1.5 AS n, .5 AS m, 1e3 AS k FROM tasks',
      '/* the list */ SELECT id FROM tasks',
      String.raw`SELECT E'it\'s into' AS t FROM tasks`,
    ];
    const { render } = await engineOf(setup, async (_props, $) => {
      for (const statement of read) {
        await setup.orm.execute(sql.raw(statement));
      }
      return $.h('p', null, 'read');
    });

    await expect(render()).resolves.toBe('read');
  });

  it('reads the log after an operation whose code ran, not after one refused before it', async () => {
    const setup = await opened();
    const asked = vi.spyOn(setup.pg, 'query');
    const logReads = () =>
      asked.mock.calls.filter(([statement]) => statement.includes('json_agg')).length;
    const { engine, operate } = await engineOf(setup, (_props, $) => $.h('p', null, 'shown'), {
      'actions/tasks': { noop },
    });
    const before = logReads();

    await expect(
      engine.operate('no-such-session', {
        args: [],
        build: BUILD,
        module: 'actions/tasks',
        name: 'noop',
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });

    expect(logReads()).toBe(before);

    await operate('actions/tasks', 'noop');

    expect(logReads()).toBe(before + 1);
  });

  it('reads the log after an operation answered again by its id, as after the first', async () => {
    const setup = await opened();
    const asked = vi.spyOn(setup.pg, 'query');
    const logReads = () =>
      asked.mock.calls.filter(([statement]) => statement.includes('json_agg')).length;
    const { engine } = await engineOf(setup, (_props, $) => $.h('p', null, 'shown'), {
      'actions/tasks': { noop },
    });
    const session = (await engine.login('bob')).sessionId;
    const call = {
      args: [],
      build: BUILD,
      module: 'actions/tasks',
      name: 'noop',
      operationId: crypto.randomUUID(),
    };
    await engine.operate(session, call);
    const before = logReads();

    await expect(engine.operate(session, call)).resolves.toMatchObject({ deduplicated: true });

    expect(logReads()).toBe(before + 1);
  });

  it.each(['TeamLog', 'team-log'])(
    'refuses a namespace whose channel a host could listen on by no name it writes: %s',
    (namespace) => {
      expect(() => followDrizzle(schema, { namespace })).toThrow('unquoted');
    },
  );

  it('keeps a log of each namespace, by triggers and a channel of its own', async () => {
    const setup = await opened();
    const logs = [
      followDrizzle(schema, { namespace: 'log_one' }),
      followDrizzle(schema, { namespace: 'log_two' }),
    ];
    const statements = logs.flatMap((log) => log.captureSql());
    for (const statement of statements) {
      await setup.pg.query(statement);
    }
    const heads = await Promise.all(
      logs.map(async (log) => (await log.store(setup.pg).changes(0, 10)).head),
    );

    await setup.orm.insert(tasks).values({ id: 't2', projectId: 'p1', title: 'two' });

    for (const [index, log] of logs.entries()) {
      const head = heads[index] ?? 0;
      const read = await log.store(setup.pg).changes(head, 10);

      expect(read.changes).toStrictEqual([
        {
          after: { k_id: keyDigest('t2') },
          before: null,
          id: 'row',
          seq: head + 1,
          table: 'tasks',
        },
      ]);
    }

    expect(logs.map((log) => log.channel)).toStrictEqual(['log_one_changes', 'log_two_changes']);
    expect(setup.follow.channel).toBe('reactive_state_changes');
  });

  it('refuses a namespace whose triggers PostgreSQL would name alike', () => {
    expect(() => followDrizzle(schema, { namespace: 'n'.repeat(55) }).captureSql()).toThrow(
      'is not a PostgreSQL identifier',
    );
  });

  it.each([
    ['the default', undefined, 'reactive_state'],
    ['one that is given', { namespace: 'ledger' }, 'ledger'],
  ] as const)(
    'refuses a table of the schema the log is kept in, which no plan names: %s namespace',
    (_name, options, kept) => {
      const inLog = pgSchema(kept).table('entries', { id: text().primaryKey() });

      expect(() => followDrizzle({ entries: inLog }, options)).toThrow(
        `\`entries\` is a table of \`${kept}\`, the schema the change log is kept in`,
      );
    },
  );

  it('follows a table of the default log schema where the log is kept in another', () => {
    const inDefault = pgSchema('reactive_state').table('entries', { id: text().primaryKey() });

    expect(() => followDrizzle({ entries: inDefault }, { namespace: 'ledger' })).not.toThrow();
    expect(() => followDrizzle(schema)).not.toThrow();
  });

  it('runs what an operation started that settles after it, as it would have', async () => {
    const setup = await opened();
    let late: Promise<unknown> | undefined;
    const start = (): void => {
      late = (async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
        await setup.orm.insert(tasks).values({ id: 'late', projectId: 'p1', title: 'late' });
      })();
    };
    const { operate } = await engineOf(setup, (_props, $) => $.h('p', null, 'shown'), {
      'actions/tasks': { start },
    });

    await operate('actions/tasks', 'start');
    await late;

    await expect(setup.pg.query("SELECT id FROM tasks WHERE id = 'late'")).resolves.toMatchObject({
      rows: [{ id: 'late' }],
    });
  });

  it('reads the log after an operation that wrote and then failed', async () => {
    const setup = await opened();
    const fail = async (): Promise<void> => {
      await setup.orm.update(tasks).set({ title: 'Renamed' }).where(eq(tasks.id, 't1'));
      throw new Error('failed after writing');
    };
    const { operate, render } = await engineOf(
      setup,
      async (_props, $) => {
        const [task] = await setup.orm.select().from(tasks).where(eq(tasks.id, 't1'));
        return $.h('p', null, task?.title);
      },
      { 'actions/tasks': { fail } },
    );

    await expect(render()).resolves.toBe('Write docs');

    await expect(operate('actions/tasks', 'fail')).rejects.toThrow('failed after writing');

    await expect(render()).resolves.toBe('Renamed');
  });

  it('keeps the plans a render asks again, past as many statements as it keeps', async () => {
    const setup = await opened();
    const planned = vi.spyOn(setup.pg, 'exec');
    const run = async (number: number) => setup.orm.execute(sql.raw(numbered(number)));
    const { render } = await engineOf(setup, async (_props, $) => {
      await run(1);
      for (let number = 2; number <= KEPT_PLANS; number += 1) {
        await run(number);
      }
      await run(1);
      await run(KEPT_PLANS + 1);
      await run(1);
      return $.h('p', null, 'read');
    });

    await render();

    // The first plan is asked with the catalog's statement before it.
    const explains = planned.mock.calls.filter(([statement]) =>
      statement.endsWith(explained(numbered(1))),
    );

    expect(explains).toHaveLength(1);
  });

  it('asks a statement its plan once, and only in a render', async () => {
    const setup = await opened();
    const checked = vi.spyOn(setup.pg, 'query');
    const planned = vi.spyOn(setup.pg, 'exec');
    const evaluate = vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
      const rows = await setup.orm.select().from(tasks).where(eq(tasks.id, 't1'));
      return $.h('p', null, String(rows.length));
    });
    const { engine, render } = await engineOf(setup, evaluate);
    await setup.orm.select().from(tasks);
    const checks = () =>
      checked.mock.calls.filter(([statement]) => statement.startsWith('EXPLAIN '));

    expect(checks()).toHaveLength(0);
    expect(planned).not.toHaveBeenCalled();

    await render();
    await setup.orm.update(tasks).set({ title: 'again' }).where(eq(tasks.id, 't1'));
    await engine.poke();
    await render();

    expect(evaluate).toHaveBeenCalledTimes(2);

    expect(checks()).toHaveLength(1);
    expect(planned).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^SELECT current_setting\('server_version_num'\).*; EXPLAIN /u),
    );
  });
});
