import { env } from 'cloudflare:workers';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalFollower } from '../../src/authority/external.ts';
import { database, definitionOf } from '../../src/server/schema.ts';
import { followDrizzle } from '../../src/sql/index.ts';
import { rendered } from './d1-drizzle-render.ts';

/**
 * A Drizzle schema's tables in D1, run in workerd: a render's statements note the rows they read by
 * the tables' keys, the triggers log each row a statement changed, and a change renders again what
 * read its rows — never fewer than changed what a render read.
 */

const projects = sqliteTable('projects', {
  id: text().primaryKey(),
  title: text().notNull(),
});
const tasks = sqliteTable(
  'tasks',
  {
    id: integer().primaryKey(),
    projectId: text('project_id').notNull(),
    title: text().notNull(),
    code: text().unique(),
  },
  (table) => [index('tasks_project').on(table.projectId)],
);
const schema = { projects, tasks };
const follow = followDrizzle(schema);
const tables = definitionOf(database(follow.tables)).tables;
const db = env.REACTIVE_D1;

/**
 * `db`, of a D1 that fails `EXPLAIN` the first `times` it is asked — every time, of no `times` — as
 * D1 in production may refuse it: a statement of a table no database holds in its place.
 */
function explaining(times = Infinity): D1Database {
  let failing = times;
  return new Proxy(db, {
    get: (target, key) => {
      if (key !== 'prepare') return Reflect.get(target, key) as unknown;
      return (statement: string) => {
        if (!/^EXPLAIN\b/u.test(statement) || failing <= 0) return target.prepare(statement);
        failing -= 1;
        return target.prepare('SELECT * FROM "refused EXPLAIN"');
      };
    },
  });
}

/** `db`, of a D1 that answers `EXPLAIN SELECT 1` and fails every plan's batch. */
function failingBatches(): D1Database {
  return new Proxy(db, {
    get: (target, key) => {
      if (key === 'batch') return () => Promise.reject(new Error('no batch of reads'));
      if (key === 'prepare') return (statement: string) => target.prepare(statement);
      return Reflect.get(target, key) as unknown;
    },
  });
}

/** What a render of `read` failed of, as Drizzle's error of the query holds it. */
async function refusal(read: () => Promise<unknown>): Promise<string> {
  try {
    await rendered(read);
  } catch (error) {
    return String(error instanceof Error ? error.cause : error);
  }
  return 'none';
}

/** A follower of the store's log, read to its head. */
async function following() {
  const follower = new ExternalFollower(follow.store(db), tables);
  await follower.changed();
  return follower;
}

describe('a Drizzle schema in D1', () => {
  beforeEach(async () => {
    await db.batch(
      [
        'DROP VIEW IF EXISTS chosen_tasks',
        'DROP TABLE IF EXISTS tasks',
        'DROP TABLE IF EXISTS projects',
        'DROP TABLE IF EXISTS _rs_changes',
        'DROP TABLE IF EXISTS _rs_meta',
        'CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL)',
        'CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, code TEXT UNIQUE)',
        'CREATE INDEX tasks_project ON tasks (project_id)',
        "CREATE VIEW chosen_tasks AS SELECT * FROM tasks WHERE project_id = 'p1'",
        "INSERT INTO projects VALUES ('p1', 'Launch'), ('p2', 'Ship')",
        "INSERT INTO tasks (id, project_id, title, code) VALUES (1, 'p1', 'one', 'a'), (2, 'p2', 'two', 'b')",
      ].map((statement) => db.prepare(statement)),
    );
    await db.batch(follow.captureSql().map((statement) => db.prepare(statement)));
  });

  it("renders a read of one project's tasks again for its rows alone", async () => {
    const orm = drizzle(follow.client(db), { schema });
    const dependencies = await rendered(() =>
      orm.select().from(tasks).where(eq(tasks.projectId, 'p1')),
    );
    const follower = await following();

    await orm.insert(tasks).values({ projectId: 'p2', title: 'other' });

    expect(dependencies.changedBy(await follower.changed())).toBe(false);

    await orm.update(tasks).set({ title: 'first' }).where(eq(tasks.id, 1));

    expect(dependencies.changedBy(await follower.changed())).toBe(true);

    await orm.insert(tasks).values({ projectId: 'p1', title: 'joined' });

    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('renders a read of tasks by their ids again for those rows alone', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const dependencies = await rendered(() => {
      return orm
        .select()
        .from(tasks)
        .where(inArray(tasks.id, [1, 3]));
    });
    const follower = await following();

    await orm.update(tasks).set({ title: 'second' }).where(eq(tasks.id, 2));

    expect(dependencies.changedBy(await follower.changed())).toBe(false);

    await orm.update(tasks).set({ title: 'first' }).where(eq(tasks.id, 1));

    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('renders a read again for a row a REPLACE deletes', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const dependencies = await rendered(() =>
      orm.select().from(tasks).where(eq(tasks.projectId, 'p1')),
    );
    const follower = await following();

    await db
      .prepare(
        "INSERT OR REPLACE INTO tasks (id, project_id, title, code) VALUES (9, 'p2', 'took', 'a')",
      )
      .run();

    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('renders a read again for a row a REPLACE deletes by its rowid', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const dependencies = await rendered(() =>
      orm.select().from(projects).where(eq(projects.id, 'p1')),
    );
    const follower = await following();

    await db
      .prepare("INSERT OR REPLACE INTO projects (rowid, id, title) VALUES (1, 'p9', 'took')")
      .run();

    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('renders a read again for a row a REPLACE deletes by an index the schema declares not', async () => {
    const labels = sqliteTable('labels', { id: text().primaryKey().unique(), name: text() });
    const own = followDrizzle({ labels });
    await db.batch(
      [
        'DROP TABLE IF EXISTS labels',
        // SQLite makes one index of the two constraints of one column, and the schema declares two.
        'CREATE TABLE labels (id TEXT PRIMARY KEY UNIQUE, name TEXT)',
        'CREATE UNIQUE INDEX labels_name ON labels (name)',
        "INSERT INTO labels VALUES ('a', 'first')",
        ...own.captureSql(),
      ].map((statement) => db.prepare(statement)),
    );
    const { results } = await db.prepare('PRAGMA index_list(labels)').all();

    expect(results).toHaveLength(2);

    const orm = drizzle(own.client(db), { schema: { labels } });
    const dependencies = await rendered(() => orm.select().from(labels).where(eq(labels.id, 'a')));
    const follower = new ExternalFollower(own.store(db), definitionOf(database(own.tables)).tables);
    await follower.changed();

    await db.prepare("INSERT OR REPLACE INTO labels VALUES ('z', 'first')").run();

    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('reads a join, and a view, of each table it reads whole', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const joined = await rendered(() => {
      return orm
        .select({ title: tasks.title, project: projects.title })
        .from(tasks)
        .innerJoin(projects, eq(tasks.projectId, projects.id))
        .where(eq(tasks.projectId, 'p1'));
    });
    const viewed = await rendered(() => orm.all(sql`SELECT * FROM chosen_tasks`));
    const follower = await following();

    await orm.update(projects).set({ title: 'Renamed' }).where(eq(projects.id, 'p2'));
    const renamed = await follower.changed();

    expect(joined.changedBy(renamed)).toBe(true);
    expect(viewed.changedBy(renamed)).toBe(false);

    await orm.insert(tasks).values({ projectId: 'p2', title: 'other' });

    expect(viewed.changedBy(await follower.changed())).toBe(true);
  });

  it('refuses a statement that writes in a render, before it runs', async () => {
    const orm = drizzle(follow.client(db), { schema });

    let refused: unknown;
    try {
      await rendered(() => orm.insert(tasks).values({ projectId: 'p1', title: 'written' }));
    } catch (error) {
      refused = error;
    }

    // Drizzle's error of the query, of the render's fault as its cause.
    expect(refused).toBeInstanceOf(Error);
    expect(String((refused as Error).cause)).toMatch(/writes nothing as it renders/u);

    const { results } = await db
      .prepare("SELECT count(*) AS n FROM tasks WHERE title = 'written'")
      .all<{ n: number }>();

    expect(results[0]?.n).toBe(0);
  });

  it('refuses a text of several statements in a render, before it runs', async () => {
    const orm = drizzle(follow.client(db), { schema });

    await expect(
      refusal(() => {
        return orm.all(
          sql.raw("SELECT 1; INSERT INTO tasks (project_id, title) VALUES ('p1', 'written')"),
        );
      }),
    ).resolves.toMatch(/one statement a text/u);

    const { results } = await db
      .prepare("SELECT count(*) AS n FROM tasks WHERE title = 'written'")
      .all<{ n: number }>();

    expect(results[0]?.n).toBe(0);
  });

  it('reads every followed table whole where D1 answers no EXPLAIN', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // The warning of a D1 that refuses `EXPLAIN`, kept out of the output.
    });
    // A follow of its own, whose plans no other test asked.
    const orm = drizzle(followDrizzle(schema).client(explaining()), { schema });
    const dependencies = await rendered(() =>
      orm.select().from(tasks).where(eq(tasks.projectId, 'p1')),
    );
    const follower = await following();

    await orm.update(projects).set({ title: 'Renamed' }).where(eq(projects.id, 'p2'));

    expect(dependencies.changedBy(await follower.changed())).toBe(true);
    expect(warned).toHaveBeenCalledTimes(1);
    await expect(
      refusal(() => orm.insert(tasks).values({ projectId: 'p1', title: 'written' })),
    ).resolves.toMatch(/writes nothing as it renders/u);

    warned.mockRestore();
  });

  it('asks D1 for plans again a while after it answered none, and reads by words meanwhile', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // The warning of a D1 that answers no `EXPLAIN`, kept out of the output.
    });
    // The plan's batch fails, and `EXPLAIN SELECT 1` after it: a D1 that failed twice running.
    const orm = drizzle(followDrizzle(schema).client(explaining(2)), { schema });
    const read = () => orm.select().from(tasks).where(eq(tasks.projectId, 'p1'));
    const unplanned = await rendered(read);
    const chosen = await rendered(() =>
      orm.all(sql`WITH chosen AS (SELECT id FROM tasks) SELECT * FROM chosen`),
    );
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    const planned = await rendered(read);
    clock.mockRestore();
    warned.mockRestore();
    const follower = await following();

    await orm.update(projects).set({ title: 'Renamed' }).where(eq(projects.id, 'p2'));
    const renamed = await follower.changed();

    expect(unplanned.changedBy(renamed)).toBe(true);
    expect(chosen.changedBy(renamed)).toBe(true);
    expect(planned.changedBy(renamed)).toBe(false);
  });

  it('warns once where plans fail and `EXPLAIN SELECT 1` answers, which no render shows', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // The warning under test, kept out of the output.
    });
    const orm = drizzle(followDrizzle(schema).client(failingBatches()), { schema });

    const tasksRead = await rendered(() =>
      orm.select().from(tasks).where(eq(tasks.projectId, 'p1')),
    );
    await rendered(() => orm.select().from(projects));
    const follower = await following();
    await orm.update(projects).set({ title: 'Renamed' }).where(eq(projects.id, 'p2'));

    expect(tasksRead.changedBy(await follower.changed())).toBe(true);
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned.mock.calls[0]?.[0]).toContain('plan of `select');
    expect(warned.mock.calls[0]?.[0]).toContain('no batch of reads');

    warned.mockRestore();
  });

  it('reads every table for a while for a plan D1 failed to answer once, then asks it again', async () => {
    const orm = drizzle(followDrizzle(schema).client(explaining(1)), { schema });
    const read = () => orm.select().from(tasks).where(eq(tasks.projectId, 'p1'));
    const unplanned = await rendered(read);
    // Asked not again for a while: its renders wait on no batch that failed.
    const kept = await rendered(read);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    const planned = await rendered(read);
    clock.mockRestore();
    const follower = await following();

    await orm.update(projects).set({ title: 'Renamed' }).where(eq(projects.id, 'p2'));
    const renamed = await follower.changed();

    expect(unplanned.changedBy(renamed)).toBe(true);
    expect(kept.changedBy(renamed)).toBe(true);
    expect(planned.changedBy(renamed)).toBe(false);
  });

  it('reads every table for a while for a WITH whose plan D1 failed to answer once', async () => {
    const orm = drizzle(followDrizzle(schema).client(explaining(1)), { schema });
    const chosen = await rendered(() =>
      orm.all(sql`WITH chosen AS (SELECT id FROM tasks) SELECT * FROM chosen`),
    );
    const follower = await following();

    await orm.update(projects).set({ title: 'Renamed' }).where(eq(projects.id, 'p2'));

    expect(chosen.changedBy(await follower.changed())).toBe(true);
  });

  it('notes what a SELECT read though it fails, and its code catches the failure', async () => {
    // The plans answer after the statement has failed.
    const slow = new Proxy(db, {
      get: (target, key) => {
        if (key !== 'batch') return Reflect.get(target, key) as unknown;
        return async (statements: D1PreparedStatement[]) => {
          await new Promise((resolve) => {
            setTimeout(resolve, 50);
          });
          return target.batch(statements);
        };
      },
    });
    const orm = drizzle(followDrizzle(schema).client(slow), { schema });
    const dependencies = await rendered(async () => {
      try {
        // Of an integer past 64 bits, as it runs.
        await orm.all(sql`SELECT abs(-9223372036854775807 - 1) AS v FROM "tasks"`);
      } catch {
        // The component's own fallback.
      }
    });
    const follower = await following();

    await orm.insert(tasks).values({ projectId: 'p1', title: 'joined' });

    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('asks one plan of a text whose statements run at once', async () => {
    let asked = 0;
    const counted = new Proxy(db, {
      get: (target, key) => {
        if (key !== 'prepare') return Reflect.get(target, key) as unknown;
        return (statement: string) => {
          if (statement.startsWith('EXPLAIN ')) asked += 1;
          return target.prepare(statement);
        };
      },
    });
    const orm = drizzle(followDrizzle(schema).client(counted), { schema });

    await rendered(() => {
      return Promise.all(
        [1, 2, 3, 4, 5].map((id) => orm.select().from(tasks).where(eq(tasks.id, id))),
      );
    });

    expect(asked).toBe(1);
  });

  it('reads the rows of a relational query by the alias it gives the table', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const dependencies = await rendered(() =>
      orm.query.tasks.findMany({ where: eq(tasks.projectId, 'p1') }),
    );
    const follower = await following();

    await orm.insert(tasks).values({ projectId: 'p2', title: 'other' });

    expect(dependencies.changedBy(await follower.changed())).toBe(false);

    await orm.insert(tasks).values({ projectId: 'p1', title: 'joined' });

    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('renders again whatever read a table its log tells of a change of the table alone', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const dependencies = await rendered(() =>
      orm.select().from(tasks).where(eq(tasks.projectId, 'p1')),
    );
    const follower = await following();
    // An entry a trigger wrote before `code` was a key of the table: of no `k_code`.
    await db
      .prepare(
        `INSERT INTO _rs_changes (tbl, id, before, after, at) VALUES ('tasks', 'row', NULL, '{"k_id":"7","k_project_id":"p2"}', 0)`,
      )
      .run();

    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('reads a log further behind than a turn reaches by the tables its entries changed', async () => {
    const store = follow.store(db);
    const { head } = await store.changes(0, 10);
    const statements = Array.from({ length: 110 }, (_, at) => {
      return db
        .prepare('INSERT INTO tasks (project_id, title) VALUES (?, ?)')
        .bind('p2', `t${String(at)}`);
    });
    await db.batch(statements);

    await expect(store.changes(head, 10)).resolves.toMatchObject({
      changes: [{ id: '', seq: head + 110, table: 'tasks' }],
      head: head + 110,
    });
  });
});
