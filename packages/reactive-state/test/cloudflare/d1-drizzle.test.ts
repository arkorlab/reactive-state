import { env } from 'cloudflare:workers';
import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { alias, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalFollower } from '../../src/authority/external.ts';
import { database, definitionOf } from '../../src/server/schema.ts';
import { followDrizzle } from '../../src/sql/index.ts';
import { faultsOf, notedBy, rendered } from './d1-drizzle-render.ts';

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

/** The statements `db` is asked, and `db` as it asks them. */
function asking(): { readonly asked: string[]; readonly watched: D1Database } {
  const asked: string[] = [];
  const watched = new Proxy(db, {
    get: (target, key) => {
      if (key !== 'prepare') return Reflect.get(target, key) as unknown;
      return (statement: string) => {
        asked.push(statement);
        return target.prepare(statement);
      };
    },
  });
  return { asked, watched };
}

/** A stream's render of `read`, of a plan a page's render asked before it. */
async function streamed(read: () => Promise<unknown>) {
  await rendered(read);
  return rendered(read, { streamed: true });
}

/** Each read a stream's render of `read` notes, of a plan a page's render asked before it. */
async function notedInStream(read: () => Promise<unknown>) {
  await rendered(read);
  return notedBy(read, { streamed: true });
}

/** The candidates among `asked`. */
function candidatesIn(asked: readonly string[]): readonly string[] {
  return asked.filter((each) => each.includes('DISTINCT'));
}

/** The tasks of `code`, each with its project's title. */
function byCode(orm: ReturnType<typeof drizzle<typeof schema>>, code: string) {
  return orm
    .select({ title: tasks.title, project: projects.title })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(tasks.code, code));
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
        'DROP VIEW IF EXISTS found_tasks',
        'DROP VIEW IF EXISTS chosen_tasks',
        'DROP TABLE IF EXISTS found',
        'DROP TABLE IF EXISTS unfollowed',
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

  it('reads a join by the rows its parameter reaches, and a view of each table whole', async () => {
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

    expect(joined.changedBy(renamed)).toBe(false);
    expect(viewed.changedBy(renamed)).toBe(false);

    await orm.update(projects).set({ title: 'Mine' }).where(eq(projects.id, 'p1'));

    expect(joined.changedBy(await follower.changed())).toBe(true);

    await orm.insert(tasks).values({ projectId: 'p2', title: 'other' });
    const added = await follower.changed();

    expect(joined.changedBy(added)).toBe(false);
    expect(viewed.changedBy(added)).toBe(true);
  });

  describe("an event stream's render of a join", () => {
    it('names the rows of a table no parameter reaches, by the values of its driver', async () => {
      const orm = drizzle(follow.client(db), { schema });
      const read = await streamed(() => byCode(orm, 'a'));
      const follower = await following();

      await orm.update(projects).set({ title: 'Renamed' }).where(eq(projects.id, 'p2'));

      expect(read.changedBy(await follower.changed())).toBe(false);

      await orm.update(projects).set({ title: 'Mine' }).where(eq(projects.id, 'p1'));

      expect(read.changedBy(await follower.changed())).toBe(true);
    });

    it('renders again for a row its driver comes to hold', async () => {
      const orm = drizzle(follow.client(db), { schema });
      const read = await streamed(() => byCode(orm, 'a'));
      const follower = await following();

      await orm.update(tasks).set({ projectId: 'p2' }).where(eq(tasks.code, 'a'));

      expect(read.changedBy(await follower.changed())).toBe(true);
    });

    it("asks no candidate of a page's render, which reads the table whole", async () => {
      const { asked, watched } = asking();
      const orm = drizzle(follow.client(watched), { schema });
      const read = await rendered(() => byCode(orm, 'a'));
      const follower = await following();

      expect(candidatesIn(asked)).toStrictEqual([]);

      await orm.update(projects).set({ title: 'Renamed' }).where(eq(projects.id, 'p2'));

      expect(read.changedBy(await follower.changed())).toBe(true);
    });

    it("asks a candidate once of a statement, beside its plan's statements", async () => {
      const { asked, watched } = asking();
      const orm = drizzle(follow.client(watched), { schema });
      await streamed(() => byCode(orm, 'a'));

      expect(candidatesIn(asked)).toStrictEqual([
        'SELECT DISTINCT "project_id" AS "value" FROM "tasks" WHERE "code" IN (?) LIMIT 33',
      ]);
    });

    it('names no row of a table of a driver that holds none', async () => {
      const orm = drizzle(follow.client(db), { schema });
      const noted = await notedInStream(() => byCode(orm, 'none'));

      expect(noted.filter(({ table }) => table === 'projects')).toStrictEqual([]);
    });

    it('reads a table whole past the records a read names', async () => {
      const projectIds = Array.from({ length: 33 }, (_, at) => `many${String(at)}`);
      await db.batch(
        projectIds.flatMap((id, at) => {
          return [
            db.prepare('INSERT INTO projects VALUES (?, ?)').bind(id, id),
            db
              .prepare('INSERT INTO tasks (id, project_id, title, code) VALUES (?, ?, ?, ?)')
              .bind(at + 100, id, 'many', id),
          ];
        }),
      );
      const orm = drizzle(follow.client(db), { schema });
      const noted = await notedInStream(() => {
        return orm
          .select({ title: tasks.title })
          .from(tasks)
          .innerJoin(projects, eq(tasks.projectId, projects.id))
          .where(inArray(tasks.code, projectIds));
      });

      expect(noted.filter(({ table }) => table === 'projects')).toStrictEqual([
        { table: 'projects', where: {} },
      ]);
    });

    it('reads a table whole where its candidate fails, and asks none for a while', async () => {
      const candidates: string[] = [];
      const failing = new Proxy(db, {
        get: (target, key) => {
          if (key !== 'batch') return Reflect.get(target, key) as unknown;
          return (statements: readonly D1PreparedStatement[]) => {
            if (statements.length > 1) return target.batch([...statements]);
            candidates.push('asked');
            return Promise.reject(new Error('no candidates'));
          };
        },
      });
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
        // Held to below.
      });
      const orm = drizzle(followDrizzle(schema).client(failing), { schema });
      const noted = await notedInStream(() => byCode(orm, 'a'));
      await notedBy(() => byCode(orm, 'a'), { streamed: true });

      expect(noted.filter(({ table }) => table === 'projects')).toStrictEqual([
        { table: 'projects', where: {} },
      ]);
      expect(candidates).toHaveLength(1);
      expect(warned).toHaveBeenCalledTimes(1);
      expect(warned.mock.calls[0]?.[0]).toContain('candidate');

      warned.mockRestore();
    });

    it.each([
      ['no answer', []],
      ['an answer of no rows field', [{}]],
      ['rows that are no list', [{ results: null }]],
    ])('reads a table whole of a batch of %s', async (_name, answer) => {
      const odd = new Proxy(db, {
        get: (target, key) => {
          if (key !== 'batch') return Reflect.get(target, key) as unknown;
          return (statements: readonly D1PreparedStatement[]) =>
            statements.length > 1 ? target.batch([...statements]) : Promise.resolve(answer);
        },
      });
      const orm = drizzle(followDrizzle(schema).client(odd), { schema });
      const noted = await notedInStream(() => byCode(orm, 'a'));

      expect(noted.filter(({ table }) => table === 'projects')).toStrictEqual([
        { table: 'projects', where: {} },
      ]);
    });

    it('asks no candidate beside a plan it asks, which the render waits for', async () => {
      const { asked, watched } = asking();
      const orm = drizzle(followDrizzle(schema).client(watched), { schema });
      const first = await notedBy(() => byCode(orm, 'a'), { streamed: true });

      expect(candidatesIn(asked)).toStrictEqual([]);
      expect(first.filter(({ table }) => table === 'projects')).toStrictEqual([
        { table: 'projects', where: {} },
      ]);

      const second = await notedBy(() => byCode(orm, 'a'), { streamed: true });

      expect(candidatesIn(asked)).toHaveLength(1);
      expect(second.filter(({ table }) => table === 'projects')).toStrictEqual([
        { table: 'projects', where: { k_id: 'p1' } },
      ]);
    });

    // A batch of a statement that writes nothing by its words runs beside its plan, a `WITH … SELECT`
    // too; any other, a `WITH` with a comment in it among them, runs after its reads are noted.
    it('asks no candidate of a batch that waits for its reads', async () => {
      const { asked, watched } = asking();
      const client = followDrizzle(schema).client(watched);
      const { sql: joined } = byCode(drizzle(client, { schema }), 'a').toSQL();
      const both = () => {
        return client.batch([
          client.prepare(joined).bind('a'),
          client.prepare('/* waits */ WITH x AS (SELECT 1 AS n) SELECT n FROM x'),
        ]);
      };
      await rendered(both);
      await rendered(both, { streamed: true });

      expect(candidatesIn(asked)).toStrictEqual([]);
    });

    it("leaves a statement's own failure to the code that catches it", async () => {
      const client = follow.client(db);
      const orm = drizzle(client, { schema });
      const { sql: asked } = byCode(orm, 'a').toSQL();
      await rendered(() => client.prepare(asked).bind('a').all());
      const faults = await faultsOf(() => client.prepare(asked).bind().all(), { streamed: true });

      expect(faults).toStrictEqual([]);
    });
  });

  it('reads whole a table a join reaches by what no parameter names', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const joined = await rendered(() => {
      return orm
        .select({ title: tasks.title, project: projects.title })
        .from(tasks)
        .innerJoin(projects, eq(tasks.projectId, projects.id))
        .where(eq(tasks.title, 'chosen'));
    });
    const follower = await following();

    await orm.update(projects).set({ title: 'Renamed' }).where(eq(projects.id, 'p2'));

    expect(joined.changedBy(await follower.changed())).toBe(true);
  });

  it('reads a subquery by the rows of its own condition', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const chosen = orm.select({ id: projects.id }).from(projects).where(eq(projects.id, 'p1'));
    const read = await rendered(() =>
      orm.select({ id: tasks.id }).from(tasks).where(inArray(tasks.projectId, chosen)),
    );
    const follower = await following();

    await orm.update(projects).set({ title: 'Renamed' }).where(eq(projects.id, 'p2'));

    expect(read.changedBy(await follower.changed())).toBe(false);

    await orm.update(projects).set({ title: 'Mine' }).where(eq(projects.id, 'p1'));

    expect(read.changedBy(await follower.changed())).toBe(true);
  });

  it('reads a statement over `json_each` of the tables it names', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const read = await rendered(() => {
      return orm.all(
        sql`select "id" from "tasks" where "tasks"."project_id" = ${'p1'}
          and "tasks"."id" in (select "value" from json_each(${'[1]'}))`,
      );
    });
    const follower = await following();

    await orm.update(projects).set({ title: 'Renamed' }).where(eq(projects.id, 'p2'));

    expect(read.changedBy(await follower.changed())).toBe(false);
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

  it('reads every followed table of a virtual table of a text not read plainly', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const read = await rendered(() =>
      orm.all(sql`SELECT id FROM tasks WHERE id IN (SELECT value FROM json_each(${'[1]'}))`),
    );
    const follower = await following();

    await orm.update(projects).set({ title: 'Renamed' }).where(eq(projects.id, 'p2'));

    expect(read.changedBy(await follower.changed())).toBe(true);
  });

  // SQLite leaves the `json_each` out, so the one `VOpen` is the other virtual table's.
  it.each([
    ['named', sql`select * from "found" where 1 or exists (select 1 from json_each('[]'))`],
    [
      'in a view',
      sql`select * from "found_tasks" where 1 or exists (select 1 from json_each('[]'))`,
    ],
    [
      'of `DISTINCT`',
      sql`select distinct "f"."title" from "found" "f"
        left join json_each(${'[]'}) "j" on "j"."value" = "f"."title"`,
    ],
  ])('reads every followed table of a virtual table %s beside a function', async (_name, asked) => {
    await db.batch([
      db.prepare('CREATE VIRTUAL TABLE found USING fts5(title)'),
      db.prepare('CREATE VIEW found_tasks AS SELECT title FROM found'),
    ]);
    const orm = drizzle(follow.client(db), { schema });
    const read = await rendered(() => orm.all(asked));
    const follower = await following();

    await orm.update(projects).set({ title: 'Renamed' }).where(eq(projects.id, 'p2'));

    expect(read.changedBy(await follower.changed())).toBe(true);
  });

  it('refuses a statement of `json_each` and a table the follow does not hold', async () => {
    await db.prepare('CREATE TABLE unfollowed (id INTEGER PRIMARY KEY)').run();
    const orm = drizzle(follow.client(db), { schema });

    await expect(
      refusal(() => {
        return orm.all(sql`select "id" from "unfollowed"
          where "unfollowed"."id" in (select "value" from json_each(${'[1]'}))`);
      }),
    ).resolves.toMatch(/does not follow/u);
  });

  it('notes a table a statement stands in twice once, of the rows both name', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const noted = await notedBy(() => {
      return orm.all(sql`select "a"."id" from "tasks" "a"
        inner join "tasks" "b" on "b"."project_id" = "a"."project_id"
        where "a"."project_id" = ${'p1'}`);
    });

    expect(noted.filter(({ table }) => table === 'tasks')).toHaveLength(1);
  });

  it('notes a table whole, once, where one of its sources is', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const noted = await notedBy(() => {
      return orm.all(sql`select "a"."id" from "tasks" "a"
        inner join "tasks" "b" on "b"."title" = "a"."title"
        where "a"."project_id" = ${'p1'}`);
    });

    expect(noted.filter(({ table }) => table === 'tasks')).toStrictEqual([
      { table: 'tasks', where: {} },
    ]);
  });

  it.each([
    ['of one value', 'p1', [{ k_project_id: 'p1' }]],
    ['of a value that names no row', null, [{}]],
  ])("notes a table's sources %s once", async (_name, other, wheres) => {
    const orm = drizzle(follow.client(db), { schema });
    const noted = await notedBy(() => {
      return orm.all(sql`select "a"."id" from "tasks" "a"
        inner join "tasks" "b" on "b"."project_id" = ${other}
        where "a"."project_id" = ${'p1'}`);
    });

    expect(noted.filter(({ table }) => table === 'tasks').map(({ where }) => where)).toStrictEqual(
      wheres,
    );
  });

  it('reads a table whole past the records its sources may name together', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const [a, b] = [alias(tasks, 'a'), alias(tasks, 'b')];
    const ids = Array.from({ length: 20 }, (_, at) => at);
    const noted = await notedBy(() => {
      return orm
        .select({ id: a.id })
        .from(a)
        .innerJoin(
          b,
          inArray(
            b.id,
            ids.map((id) => id + ids.length),
          ),
        )
        .where(inArray(a.id, ids));
    });

    expect(noted.filter(({ table }) => table === 'tasks')).toStrictEqual([
      { table: 'tasks', where: {} },
    ]);
  });

  it('reads whole the tables of a join of a view, by no term of its text', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const read = await rendered(() => {
      return orm.all(sql`select "c"."id" from "chosen_tasks" "c"
        inner join "projects" on "projects"."id" = "c"."project_id" where "c"."id" = ${1}`);
    });
    const follower = await following();

    await orm.insert(tasks).values({ projectId: 'p1', title: 'other' });

    expect(read.changedBy(await follower.changed())).toBe(true);
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
