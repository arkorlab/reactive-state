import { setTimeout as sleep } from 'node:timers/promises';

import { PGlite } from '@electric-sql/pglite';
import { and, eq, inArray, isNull, not, or, relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { CommitEvent } from '../src/authority/model.ts';
import type { Json, RenderScope } from '../src/program.ts';
import { followDrizzle } from '../src/sql/index.ts';
import { keyDigest } from '../src/sql/reads.ts';
import { engineOf, openedWith } from './support/drizzle.ts';

/**
 * A render of the application's Drizzle queries is rendered again for the rows its plan's
 * conditions name — a change of a row of another project renders it not — and for every change
 * where a condition is not one the authority follows: never for fewer changes than change what it
 * read.
 */

const status = pgEnum('status', ['open', 'closed']);
const projects = pgTable(
  'projects',
  {
    id: text().primaryKey(),
    orgId: uuid('org_id').notNull(),
    title: varchar({ length: 200 }).notNull(),
  },
  (table) => [index('projects_org').on(table.orgId)],
);
const tasks = pgTable(
  'tasks',
  {
    id: serial().primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    done: boolean().notNull().default(false),
    status: status().notNull().default('open'),
    big: bigint({ mode: 'bigint' }),
    visible: boolean().generatedAlwaysAs(sql`NOT done`),
  },
  (table) => [index('tasks_project').on(table.projectId), index('tasks_big').on(table.big)],
);
const members = pgTable(
  'members',
  {
    projectId: text('project_id').notNull(),
    userId: text('user_id').notNull(),
    role: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.userId] })],
);
const labels = pgTable('labels', { id: text().primaryKey(), name: text().notNull() });
const parents = pgTable(
  'parents',
  { id: text().notNull(), parentName: text('parent_name') },
  (table) => [uniqueIndex('parents_id').on(table.id)],
);
const children = pgTable(
  'children',
  { id: text().primaryKey(), parentId: text('parent_id'), projectId: text('project_id') },
  (table) => [index('children_project').on(table.projectId)],
);
const oddName = pgTable('odd.name', { id: text().primaryKey(), note: text() });
const flags = pgTable('flags', {
  id: text().primaryKey(),
  lit: boolean().default(false),
});
const projectTasks = relations(projects, ({ many }) => ({ tasks: many(tasks) }));
const taskProject = relations(tasks, ({ one }) => {
  return {
    project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  };
});
const schema = {
  children,
  flags,
  labels,
  members,
  oddName,
  parents,
  projectTasks,
  projects,
  status,
  taskProject,
  tasks,
};

const ORG = {
  one: '6f1f7d3e-0000-4000-8000-000000000001',
  two: '6f1f7d3e-0000-4000-8000-000000000002',
} as const;
/** The first whole number past those a JavaScript number holds each of, and the one before it. */
const BIG = { past: 9_007_199_254_740_993n, safe: 9_007_199_254_740_992n } as const;
/** Longer than the schema's digest is kept between two reads of it (`digest.ts`). */
const PAST_DIGEST_MS = 1100;
/** The oid of PostgreSQL's `bpchar`, a blank-padded text, as a query's options type a value. */
const BPCHAR = 1042;
/** The oid of PostgreSQL's `text`, whose serializer PGlite writes a text value by. */
const TEXT = 25;
/** The oid of PostgreSQL's `name`, a parameter of which a plan writes of no cast. */
const NAME = 19;
/** A collation of the session's temporary schema that finds two texts of one letter's case equal. */
const TEMPORARY_FOLDED =
  "CREATE COLLATION pg_temp.folded (provider = icu, locale = '@colStrength=secondary', deterministic = false)";
/** One more row than the log keeps an entry of each of, of one statement (`capture.ts`). */
const PAST_LOGGED_ROWS = 101;
/**
 * Statements of as many rows as the log keeps an entry of each of: more entries than a turn of the
 * authority's reads reaches (`TAIL`, 2000).
 */
const PAST_A_TURN = 21;

/** The database of `schema`, of its rows; of what `prelude` runs first, the log's made after. */
async function opened(prelude = '') {
  return openedWith(
    schema,
    `
    ${prelude}
    CREATE TYPE status AS ENUM ('open', 'closed');
    CREATE TABLE projects (id text PRIMARY KEY, org_id uuid NOT NULL, title varchar(200) NOT NULL);
    CREATE INDEX projects_org ON projects (org_id);
    CREATE TABLE tasks (id serial PRIMARY KEY, project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      title text NOT NULL, done boolean NOT NULL DEFAULT false, status status NOT NULL DEFAULT 'open', big bigint,
      visible boolean GENERATED ALWAYS AS (NOT done) STORED);
    CREATE INDEX tasks_project ON tasks (project_id);
    CREATE INDEX tasks_big ON tasks (big);
    CREATE TABLE members (project_id text NOT NULL, user_id text NOT NULL, role text NOT NULL, PRIMARY KEY (project_id, user_id));
    CREATE TABLE labels (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE flags (id text PRIMARY KEY, lit boolean DEFAULT false);
    CREATE TABLE parents (id text NOT NULL, parent_name text);
    CREATE UNIQUE INDEX parents_id ON parents (id);
    CREATE TABLE children (id text PRIMARY KEY, parent_id text, project_id text);
    CREATE INDEX children_project ON children (project_id);
    INSERT INTO parents VALUES ('a', 'first');
    INSERT INTO children VALUES ('c1', 'a', 'p1');
    INSERT INTO flags VALUES ('f1', true), ('f2', false);
    ALTER TABLE labels ENABLE ROW LEVEL SECURITY;
    CREATE VIEW chosen_tasks AS SELECT * FROM tasks WHERE project_id = 'p1';
    CREATE VIEW open_tasks AS SELECT * FROM tasks WHERE status = 'open';
    CREATE FUNCTION chosen() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'p1' $$;
    CREATE FUNCTION shown() RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$;
    CREATE TABLE untracked (id text);
    INSERT INTO projects VALUES ('p1', '${ORG.one}', 'Launch'), ('p2', '${ORG.two}', 'Ship'), ('p3', '${ORG.two}', 'Plan');
    INSERT INTO tasks (project_id, title, big) VALUES ('p1', 'one', ${String(BIG.past)}), ('p2', 'two', ${String(BIG.safe)});
    INSERT INTO members VALUES ('p1', 'alice', 'owner'), ('p2', 'alice', 'owner');
    INSERT INTO labels VALUES ('l1', 'a'), ('l2', 'b');
    CREATE TABLE "odd.name" (id text PRIMARY KEY, note text);
    INSERT INTO "odd.name" VALUES ('a', 'first'), ('b', 'second');
    CREATE FUNCTION add_length(s int, t text) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT s + length(t) $$;
    CREATE FUNCTION add_hundred(s int, t text) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT s + 100 $$;
    CREATE AGGREGATE total(text) (SFUNC = add_length, STYPE = int, INITCOND = '0');
    CREATE TEXT SEARCH CONFIGURATION public.words (COPY = pg_catalog.simple);
  `,
  );
}

type Setup = Awaited<ReturnType<typeof opened>>;
type Orm = Setup['orm'];

/**
 * A row's write that failed, before the log was read or anything rendered: the row's failure, by a
 * message of its own that no row expects of a render, whatever the write failed with (its `cause`).
 */
class WriteFailedError extends Error {
  constructor(cause: unknown) {
    super('The write a row makes before it renders again failed.', { cause });
    this.name = 'WriteFailedError';
  }
}

/**
 * A component that renders what `read` reads, rendered once; and whether a write renders it again,
 * once the log told of it. The write succeeds, or the row fails by it (`WriteFailedError`): what a
 * row expects a render to fail with is no write's failure.
 */
async function watching(
  read: (orm: Orm, setup: Setup) => Promise<unknown>,
  prepare?: (pg: Setup['pg']) => Promise<unknown>,
) {
  const setup = await opened();
  if (prepare !== undefined) await prepare(setup.pg);
  const evaluate = vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
    const rows = await read(setup.orm, setup);
    return $.h(
      'p',
      null,
      JSON.stringify(rows, (_key, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value,
      ),
    );
  });
  const { engine, render } = await engineOf(setup, evaluate);
  await render();
  return {
    orm: setup.orm,
    pg: setup.pg,
    render,
    renders: async (write: () => Promise<unknown>): Promise<boolean> => {
      const before = evaluate.mock.calls.length;
      try {
        await write();
      } catch (error) {
        throw new WriteFailedError(error);
      }
      await engine.poke();
      await render();
      return evaluate.mock.calls.length > before;
    },
  };
}

/** As a host whose role makes the event triggers that count the schema's changes. */
async function withEventTriggers({ pg }: Pick<Awaited<ReturnType<typeof watching>>, 'pg'>) {
  await expect(
    pg.query<{ made: string }>(
      "SELECT count(*)::text AS made FROM pg_event_trigger WHERE evtname IN ('reactive_state_ddl', 'reactive_state_drop') AND evtenabled = 'A'",
    ),
  ).resolves.toMatchObject({ rows: [{ made: '2' }] });
}

/**
 * As a host whose role may make no event trigger, where the schema's digest alone tells of a
 * change: the digest of a database that counts no command holds the file of each followed table's
 * rows, which renders everything once more, and then holds.
 */
async function withoutEventTriggers({
  pg,
  renders,
}: Pick<Awaited<ReturnType<typeof watching>>, 'pg' | 'renders'>) {
  await pg.query('DROP EVENT TRIGGER reactive_state_ddl');
  await pg.query('DROP EVENT TRIGGER reactive_state_drop');
  await renders(() => sleep(PAST_DIGEST_MS));

  await expect(renders(() => sleep(PAST_DIGEST_MS))).resolves.toBe(false);
}

/**
 * What makes a render read as the role `app`, of the rights a store reads its log by, once
 * `granted` ran as the superuser.
 */
function asApp(granted: string) {
  return (pg: Setup['pg']) => {
    return pg.exec(`
      CREATE ROLE app;
      GRANT USAGE ON SCHEMA reactive_state TO app;
      GRANT SELECT ON ALL TABLES IN SCHEMA reactive_state TO app;
      ${granted}
      SET ROLE app;
    `);
  };
}

/**
 * A view of the labels, `all_labels`, that the role `reporter` owns and `app` may read: its rows
 * are those its owner's rights and policies show, none of them until a policy names the owner.
 */
const OWNED_VIEW = `
  CREATE ROLE admins;
  CREATE ROLE reporter;
  GRANT SELECT ON labels TO reporter;
  CREATE POLICY seen ON labels FOR SELECT TO admins USING (true);
  CREATE VIEW all_labels AS SELECT id FROM labels;
  ALTER VIEW all_labels OWNER TO reporter;
  GRANT SELECT ON all_labels TO app;
`;

/** A view of the log's own schema, `reactive_state.chosen`, of the tasks of `project`. */
function logViewOf(project: string): string {
  return `CREATE OR REPLACE VIEW reactive_state.chosen AS SELECT * FROM tasks WHERE project_id = '${project}'`;
}

/**
 * A function of the application's in the log's schema, of a log function's name but other
 * arguments, `reactive_state.note(integer)`, that answers `answer`.
 */
function noteOf(answer: string): string {
  return `CREATE OR REPLACE FUNCTION reactive_state.note(n integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '${answer}' $$`;
}

/** A function of the session's temporary schema, `pg_temp.picked()`, that answers `project`. */
function pickedOf(project: string): string {
  return `CREATE OR REPLACE FUNCTION pg_temp.picked() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '${project}' $$`;
}

/** How many changes of the schema the log of `namespace` counted, as its text. */
async function countOf(pg: Setup['pg'], namespace = 'reactive_state') {
  const { rows } = await pg.query<{ n: string }>(`SELECT "${namespace}".ddl_count()::text AS n`);
  return rows[0]?.n;
}

/** The statements of the log `follow` makes, each run. */
async function installed(pg: Setup['pg'], follow: { captureSql: () => readonly string[] }) {
  for (const statement of follow.captureSql()) await pg.query(statement);
}

/**
 * A count whose insert fails of `condition`, wherever `when` holds, as a lock would: PGlite's one
 * session waits behind no lock, and no timeout of its fires.
 */
async function countRefused(pg: Setup['pg'], condition: string, when = 'true') {
  await pg.exec(`
    CREATE FUNCTION public.refused() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF ${when} THEN
        RAISE EXCEPTION 'refused' USING ERRCODE = '${condition}';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER refused BEFORE INSERT ON reactive_state.ddl FOR EACH ROW EXECUTE FUNCTION public.refused();
  `);
}

/** A count whose insert fails wherever a lock timeout stands, as a lock held past it would. */
async function countTimedOut(pg: Setup['pg']) {
  await countRefused(pg, 'lock_not_available', "current_setting('lock_timeout') <> '0'");
}

/** A read of the tasks of the first project, `p1`. */
async function launchTasks(orm: Orm) {
  return orm.select().from(tasks).where(eq(tasks.projectId, 'p1'));
}

/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;

describe(
  "reads of Drizzle tables followed by the rows their plans' conditions name",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    it('follows a constant of a schema-qualified enum by that enum alone', async () => {
      const { orm, renders } = await watching(
        (db) => db.execute(sql`SELECT title FROM tasks WHERE status = 'open'::app.status`),
        async (pg) => {
          await pg.query('CREATE SCHEMA app');
          await pg.query('ALTER TYPE public.status SET SCHEMA app');
          await pg.query("UPDATE tasks SET status = 'closed' WHERE project_id = 'p2'");
        },
      );

      await expect(
        renders(() => orm.update(tasks).set({ title: 'other' }).where(eq(tasks.projectId, 'p2'))),
      ).resolves.toBe(false);
      await expect(
        renders(() => orm.update(tasks).set({ title: 'changed' }).where(eq(tasks.projectId, 'p1'))),
      ).resolves.toBe(true);
      await expect(
        renders(() => orm.update(tasks).set({ status: 'open' }).where(eq(tasks.projectId, 'p2'))),
      ).resolves.toBe(true);
    });

    it('follows a constant of an enum whose schema and type need quoting', async () => {
      const { orm, renders } = await watching(
        (db) => {
          return db.execute(
            sql`SELECT title FROM tasks WHERE status = 'open'::"odd.schema"."Status""Name"`,
          );
        },
        async (pg) => {
          await pg.query('CREATE SCHEMA "odd.schema"');
          await pg.query('ALTER TYPE public.status RENAME TO "Status""Name"');
          await pg.query('ALTER TYPE "Status""Name" SET SCHEMA "odd.schema"');
          await pg.query("UPDATE tasks SET status = 'closed' WHERE project_id = 'p2'");
        },
      );

      await expect(
        renders(() => orm.update(tasks).set({ title: 'other' }).where(eq(tasks.projectId, 'p2'))),
      ).resolves.toBe(false);
      await expect(
        renders(() => orm.update(tasks).set({ status: 'closed' }).where(eq(tasks.projectId, 'p1'))),
      ).resolves.toBe(true);
    });

    it('renders a read of one project again for its rows, not for those of another', async () => {
      const { orm, renders } = await watching((db) => launchTasks(db));

      await expect(
        renders(() => orm.insert(tasks).values({ projectId: 'p2', title: 'other' })),
      ).resolves.toBe(false);
      await expect(
        renders(() => orm.insert(tasks).values({ projectId: 'p1', title: 'mine' })),
      ).resolves.toBe(true);
    });

    it('renders a read again for a row that leaves its condition, and for one that joins it', async () => {
      const { orm, renders } = await watching((db) => launchTasks(db));

      await expect(
        renders(() => orm.update(tasks).set({ projectId: 'p3' }).where(eq(tasks.title, 'one'))),
      ).resolves.toBe(true);
      await expect(
        renders(() => orm.update(tasks).set({ projectId: 'p1' }).where(eq(tasks.title, 'two'))),
      ).resolves.toBe(true);
      await expect(
        renders(() =>
          orm.update(tasks).set({ title: 'still three' }).where(eq(tasks.title, 'one')),
        ),
      ).resolves.toBe(false);
    });

    it('follows the conditions PostgreSQL derives across a join', async () => {
      const { orm, renders } = await watching((db) => {
        return db
          .select({ role: members.role, title: tasks.title })
          .from(tasks)
          .innerJoin(
            members,
            and(eq(members.projectId, tasks.projectId), eq(members.userId, 'alice')),
          )
          .where(eq(tasks.projectId, 'p1'));
      });

      await expect(
        renders(() =>
          orm.update(members).set({ role: 'viewer' }).where(eq(members.projectId, 'p2')),
        ),
      ).resolves.toBe(false);
      await expect(
        renders(() =>
          orm.insert(members).values({ projectId: 'p1', role: 'editor', userId: 'bob' }),
        ),
      ).resolves.toBe(false);
      await expect(
        renders(() =>
          orm.update(members).set({ role: 'viewer' }).where(eq(members.projectId, 'p1')),
        ),
      ).resolves.toBe(true);
    });

    it.each([
      [
        'a relational query',
        (db: Orm) =>
          db.query.projects.findMany({ where: eq(projects.id, 'p1'), with: { tasks: true } }),
      ],
      [
        'a subquery',
        (db: Orm) => {
          const none = db
            .select({ id: members.projectId })
            .from(members)
            .where(eq(members.role, 'none'));
          return db.select().from(tasks).where(inArray(tasks.projectId, none));
        },
      ],
      [
        'an OR',
        (db: Orm) => {
          return db
            .select()
            .from(tasks)
            .where(or(eq(tasks.projectId, 'p1'), eq(tasks.projectId, 'p3')));
        },
      ],
      [
        "a subquery's value",
        (db: Orm) => {
          return db
            .select()
            .from(tasks)
            .where(
              sql`${tasks.projectId} = (SELECT ${projects.id} FROM ${projects} WHERE ${projects.title} = ${'Launch'})`,
            );
        },
      ],
      [
        'a collation of its own',
        (db: Orm) => {
          return db
            .select()
            .from(tasks)
            .where(sql`${tasks.projectId} = ${'p1'} COLLATE "C"`);
        },
      ],
    ])('reads the table whole where its rows are named by %s', async (_what, read) => {
      const { orm, renders } = await watching(read);

      await expect(
        renders(() => orm.insert(tasks).values({ projectId: 'p2', title: 'other' })),
      ).resolves.toBe(true);
    });

    it('follows a list of values', async () => {
      const listed = await watching((db) => {
        return db
          .select()
          .from(tasks)
          .where(inArray(tasks.projectId, ['p1', 'p3']));
      });

      await expect(
        listed.renders(() => listed.orm.insert(tasks).values({ projectId: 'p2', title: 'other' })),
      ).resolves.toBe(false);
      await expect(
        listed.renders(() => listed.orm.insert(tasks).values({ projectId: 'p3', title: 'third' })),
      ).resolves.toBe(true);
    });

    it('leaves out a NULL of a list', async () => {
      const nulls = await watching((db) => {
        return db
          .select()
          .from(tasks)
          .where(sql`${tasks.projectId} = ANY (ARRAY[${'p1'}, ${null}])`);
      });

      await expect(
        nulls.renders(() => nulls.orm.insert(tasks).values({ projectId: 'p2', title: 'other' })),
      ).resolves.toBe(false);
      await expect(
        nulls.renders(() => nulls.orm.insert(tasks).values({ projectId: 'p1', title: 'mine' })),
      ).resolves.toBe(true);
    });

    it('names a UUID as PostgreSQL writes it, in lower case', async () => {
      const byOrg = await watching((db) =>
        db.select().from(projects).where(eq(projects.orgId, ORG.one.toUpperCase())),
      );

      await expect(
        byOrg.renders(() =>
          byOrg.orm.update(projects).set({ title: 'Shipped' }).where(eq(projects.id, 'p2')),
        ),
      ).resolves.toBe(false);
      await expect(
        byOrg.renders(() =>
          byOrg.orm.update(projects).set({ title: 'Launched' }).where(eq(projects.id, 'p1')),
        ),
      ).resolves.toBe(true);
    });

    it('names a whole number as PostgreSQL writes it, in decimal', async () => {
      const byId = await watching((db) => {
        return db
          .select()
          .from(tasks)
          .where(sql`${tasks.id} = ${'0001'}`);
      });

      await expect(
        byId.renders(() => byId.orm.update(tasks).set({ title: 'second' }).where(eq(tasks.id, 2))),
      ).resolves.toBe(false);
      await expect(
        byId.renders(() => byId.orm.update(tasks).set({ title: 'first' }).where(eq(tasks.id, 1))),
      ).resolves.toBe(true);
    });

    it('follows a whole number past those a JavaScript number holds', async () => {
      const { orm, renders } = await watching((db) =>
        db.select().from(tasks).where(eq(tasks.big, BIG.past)),
      );

      await expect(
        renders(() => orm.update(tasks).set({ title: 'two again' }).where(eq(tasks.big, BIG.safe))),
      ).resolves.toBe(false);
      await expect(
        renders(() => orm.update(tasks).set({ title: 'one again' }).where(eq(tasks.big, BIG.past))),
      ).resolves.toBe(true);
    });

    it('follows a boolean column alone and an enum', async () => {
      const { orm, renders } = await watching((db) => {
        return db
          .select()
          .from(tasks)
          .where(and(eq(tasks.projectId, 'p1'), not(tasks.done), eq(tasks.status, 'open')));
      });

      await expect(
        renders(() => orm.insert(tasks).values({ done: true, projectId: 'p1', title: 'done' })),
      ).resolves.toBe(false);
      await expect(
        renders(() =>
          orm.insert(tasks).values({ projectId: 'p1', status: 'closed', title: 'closed' }),
        ),
      ).resolves.toBe(false);
      await expect(
        renders(() => orm.update(tasks).set({ done: true }).where(eq(tasks.title, 'one'))),
      ).resolves.toBe(true);
    });

    it('reads a table whose rows a policy hides whole', async () => {
      const { orm, renders } = await watching((db) =>
        db.select().from(labels).where(eq(labels.id, 'l1')),
      );

      await expect(
        renders(() => orm.update(labels).set({ name: 'c' }).where(eq(labels.id, 'l2'))),
      ).resolves.toBe(true);
    });

    it('renders a read again for a statement that changed more rows than the log keeps of one, and a truncation', async () => {
      const many = await watching((db) => launchTasks(db));
      const rows = Array.from({ length: PAST_LOGGED_ROWS }, (_, at) => {
        return {
          projectId: 'p2',
          title: `t${String(at)}`,
        };
      });

      await expect(many.renders(() => many.orm.insert(tasks).values(rows))).resolves.toBe(true);
      await expect(many.renders(() => many.pg.query('TRUNCATE tasks'))).resolves.toBe(true);
    });

    it("renders a read again for the rows a cascade deletes, and not for another project's", async () => {
      const { orm, renders } = await watching((db) => launchTasks(db));

      await expect(renders(() => orm.delete(projects).where(eq(projects.id, 'p2')))).resolves.toBe(
        false,
      );
      await expect(renders(() => orm.delete(projects).where(eq(projects.id, 'p1')))).resolves.toBe(
        true,
      );
    });

    it('renders a read again for the rows an upsert changes', async () => {
      const { orm, renders } = await watching((db) => launchTasks(db));
      const upserted = (id: number, projectId: string) => {
        return orm
          .insert(tasks)
          .values({ id, projectId, title: 'upserted' })
          .onConflictDoUpdate({ set: { title: 'upserted' }, target: tasks.id });
      };

      await expect(renders(() => upserted(2, 'p2'))).resolves.toBe(false);
      await expect(renders(() => upserted(1, 'p1'))).resolves.toBe(true);
    });

    it('renders every read again once the schema changed, and follows its new conditions', async () => {
      const { orm, pg, renders } = await watching((db) =>
        db.execute(sql`SELECT id FROM chosen_tasks`),
      );

      await expect(
        renders(async () => {
          await pg.query(
            "CREATE OR REPLACE VIEW chosen_tasks AS SELECT * FROM tasks WHERE project_id = 'p2'",
          );
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
      await expect(
        renders(() => orm.insert(tasks).values({ projectId: 'p1', title: 'mine' })),
      ).resolves.toBe(false);
      await expect(
        renders(() => orm.insert(tasks).values({ projectId: 'p2', title: 'chosen' })),
      ).resolves.toBe(true);
    });

    it("logs the rows of a table whose columns are named as the log's own variables", async () => {
      const setup = await opened();
      await setup.pg.exec(
        'CREATE TABLE tallies (id text PRIMARY KEY, total integer NOT NULL, last text, changed boolean NOT NULL DEFAULT false)',
      );
      const tallies = pgTable('tallies', {
        changed: boolean().notNull().default(false),
        id: text().primaryKey(),
        last: text(),
        total: integer().notNull(),
      });
      const follow = followDrizzle({ tallies });
      for (const statement of follow.captureSql()) {
        await setup.pg.query(statement);
      }
      const store = follow.store(setup.pg);
      const { head } = await store.changes(0, 10);

      await setup.pg.query("INSERT INTO tallies VALUES ('a', 1, 'x', false)");
      await setup.pg.query("UPDATE tallies SET total = 2, changed = true WHERE id = 'a'");
      await setup.pg.query("DELETE FROM tallies WHERE id = 'a'");
      const read = await store.changes(head, 10);

      expect(read.changes.map((change) => [change.before, change.after])).toStrictEqual([
        [null, { k_changed: keyDigest('false'), k_id: keyDigest('a') }],
        [{ k_changed: keyDigest('false'), k_id: keyDigest('a') }, null],
        [null, { k_changed: keyDigest('true'), k_id: keyDigest('a') }],
        [{ k_changed: keyDigest('true'), k_id: keyDigest('a') }, null],
      ]);
    });

    it("renders every read again once an enum's label is renamed, and follows the new label", async () => {
      const { orm, pg, renders } = await watching((db) =>
        db.execute(sql`SELECT id FROM open_tasks`),
      );

      await expect(
        renders(async () => {
          await pg.query("ALTER TYPE status RENAME VALUE 'open' TO 'active'");
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
      await expect(
        renders(() => orm.update(tasks).set({ title: 'renamed' }).where(eq(tasks.title, 'one'))),
      ).resolves.toBe(true);
    });

    it('renders every read again once a function its plan folded is defined again', async () => {
      const { orm, pg, renders } = await watching((db) => {
        return db
          .select()
          .from(tasks)
          .where(sql`${tasks.projectId} = chosen()`);
      });

      await expect(
        renders(async () => {
          await pg.query(
            "CREATE OR REPLACE FUNCTION chosen() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'p2' $$",
          );
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
      await expect(
        renders(() => orm.insert(tasks).values({ projectId: 'p2', title: 'chosen' })),
      ).resolves.toBe(true);
    });

    it('asks a plan kept before a store first read the log again', async () => {
      const setup = await opened();
      const read = async () => setup.orm.execute(sql`SELECT id FROM chosen_tasks`);
      const first = await engineOf(setup, async (_props, $) =>
        $.h('p', null, JSON.stringify(await read())),
      );
      await first.render();
      await setup.pg.query(
        "CREATE OR REPLACE VIEW chosen_tasks AS SELECT * FROM tasks WHERE project_id = 'p2'",
      );
      // Another authority of the same client — a host started again — whose store has read nothing.
      const evaluate = vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) =>
        $.h('p', null, JSON.stringify(await read())),
      );
      const second = await engineOf(setup, evaluate);
      await second.render();
      await setup.orm.insert(tasks).values({ projectId: 'p2', title: 'chosen' });
      await second.engine.poke();
      await second.render();

      expect(evaluate).toHaveBeenCalledTimes(2);
    });

    it('renders nothing again for a truncation of a table nothing follows, nor its statistics', async () => {
      const { pg, renders } = await watching((db) => launchTasks(db));

      await expect(
        renders(async () => {
          await pg.query('TRUNCATE untracked');
          await pg.query('ANALYZE tasks');
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(false);
    });

    it('renders a read again for a schema changed and changed back at once', async () => {
      const { orm, pg, renders } = await watching((db) =>
        db.execute(sql`SELECT id FROM chosen_tasks`),
      );
      const chosen = async (projectId: string) => {
        return pg.query(
          `CREATE OR REPLACE VIEW chosen_tasks AS SELECT * FROM tasks WHERE project_id = '${projectId}'`,
        );
      };

      // Both before the store reads the log again: it never sees the schema as other than it was.
      await expect(
        renders(async () => {
          await chosen('p2');
          await chosen('p1');
        }),
      ).resolves.toBe(true);
      await expect(
        renders(() => orm.insert(tasks).values({ projectId: 'p1', title: 'mine' })),
      ).resolves.toBe(true);
    });

    it.each([
      [
        'a function it folded away',
        (db: Orm) => {
          return db
            .select()
            .from(tasks)
            .where(sql`shown()`);
        },
        'CREATE OR REPLACE FUNCTION shown() RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$',
        { projectId: 'p2', title: 'shown' },
      ],
      [
        'a NOT NULL that folded its condition away',
        (db: Orm) => db.select().from(tasks).where(isNull(tasks.title)),
        'ALTER TABLE tasks ALTER COLUMN title DROP NOT NULL',
        { projectId: 'p2', title: null },
      ],
    ])(
      'renders a read of no table again once the schema changes %s',
      async (_what, read, ddl, row) => {
        const { orm, pg, renders } = await watching(read);

        await expect(renders(() => pg.query(ddl))).resolves.toBe(true);
        await expect(
          renders(() => orm.insert(tasks).values(row as typeof tasks.$inferInsert)),
        ).resolves.toBe(true);
      },
    );

    it('logs the rows of a table whose key was dropped after its triggers were made, of the table alone', async () => {
      const setup = await opened();
      const store = setup.follow.store(setup.pg);
      const { head } = await store.changes(0, 10);
      // A migration the host ran no `captureSql()` after: the triggers still name the column.
      await setup.pg.query('DROP INDEX tasks_big');
      await setup.pg.query('ALTER TABLE tasks DROP COLUMN big CASCADE');

      await setup.pg.query("UPDATE tasks SET title = 'still logged' WHERE id = 1");
      const read = await store.changes(head, 10);

      expect(read.changes.map((change) => change.id)).toStrictEqual(['', '']);
    });

    it("reads every table whole where the application's `=` of text comes before PostgreSQL's", async () => {
      const setup = await opened();
      // Text equal whatever its case, which the search path resolves `=` of two texts to.
      await setup.pg.exec(`
        CREATE FUNCTION alike(a text, b text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN RETURN lower(a) OPERATOR(pg_catalog.=) lower(b); END $$;
        CREATE OPERATOR public.= (LEFTARG = text, RIGHTARG = text, FUNCTION = alike);
        SET search_path = public, pg_catalog;
        INSERT INTO projects VALUES ('P1', '${ORG.one}', 'Upper');
      `);
      const evaluate = vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
        const rows = await setup.orm
          .select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.projectId, 'p1'));
        return $.h('p', null, JSON.stringify(rows));
      });
      const { engine, render } = await engineOf(setup, evaluate);
      await render();
      await setup.orm.insert(tasks).values({ projectId: 'P1', title: 'upper' });
      await engine.poke();
      await render();

      expect(evaluate).toHaveBeenCalledTimes(2);
    });

    it('lets a role of no right to the log change the schema, and counts it', async () => {
      const setup = await opened();
      const count = async () => {
        return (
          await setup.pg.query<{ ddl: string }>(
            'SELECT count(*)::text AS ddl FROM reactive_state.ddl',
          )
        ).rows[0]?.ddl;
      };
      const before = await count();
      await setup.pg.exec(`
        CREATE ROLE builder;
        GRANT CREATE, USAGE ON SCHEMA public TO builder;
        SET ROLE builder;
        CREATE TABLE built (id text PRIMARY KEY);
        RESET ROLE;
      `);

      await expect(count()).resolves.not.toBe(before);
    });

    it('renders nothing again for a grant, a comment, a temporary table or an index', async () => {
      const { pg, renders } = await watching((db) => launchTasks(db));

      await expect(
        renders(async () => {
          await pg.exec(`
            GRANT SELECT ON tasks TO PUBLIC;
            REVOKE EXECUTE ON FUNCTION chosen() FROM PUBLIC;
            REVOKE USAGE ON TYPE status FROM PUBLIC;
            COMMENT ON TABLE tasks IS 'the tasks';
            CREATE TEMPORARY TABLE scratch (id text);
            CREATE TEMPORARY TABLE IF NOT EXISTS scratch (id text);
            DROP TABLE scratch;
            CREATE TEMPORARY TABLE tasks_project (id text);
            DROP TABLE tasks_project;
            DROP TABLE IF EXISTS missing;
            CREATE TABLE IF NOT EXISTS tasks (id serial);
            CREATE INDEX tasks_title ON tasks (title);
            REINDEX INDEX tasks_title;
          `);
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(false);
    });

    it("renders every read again once a generated key's expression changes, where no event trigger counts it", async () => {
      const { orm, pg, renders } = await watching((db) =>
        db.select({ id: tasks.id }).from(tasks).where(eq(tasks.visible, true)),
      );
      await withoutEventTriggers({ pg, renders });

      await expect(
        renders(async () => {
          await pg.query('ALTER TABLE tasks ALTER COLUMN visible SET EXPRESSION AS (done)');
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
      await expect(
        renders(() => orm.update(tasks).set({ done: true }).where(eq(tasks.title, 'one'))),
      ).resolves.toBe(true);
    });

    it('declares a table of the schema of each store, for two databases one authority follows', () => {
      const tables = [
        followDrizzle(schema, { store: 'a' }),
        followDrizzle(schema, { store: 'b' }),
        // Stores' names of 50 and 51 letters, which a table's name of the prefix cannot hold, and
        // one a table's name holds as it is, of the form a digest of 32 bits was written in.
        followDrizzle(schema, { store: 's'.repeat(50) }),
        followDrizzle(schema, { store: 's'.repeat(51) }),
        followDrizzle(schema, { store: 'x0123abcd' }),
      ]
        .flatMap((follow) => Object.keys(follow.tables))
        .filter((name) => name.startsWith('reactive_state_schema'));

      expect(new Set(tables).size).toBe(5);
      expect(tables).toStrictEqual([
        'reactive_state_schema_a',
        'reactive_state_schema_b',
        expect.stringMatching(/^reactive_state_schema__[\da-f]{16}$/u),
        expect.stringMatching(/^reactive_state_schema__[\da-f]{16}$/u),
        'reactive_state_schema_x0123abcd',
      ]);
    });

    it("renders every read again once a column's rows are rewritten of its own type, where no event trigger counts it", async () => {
      const { orm, pg, renders } = await watching((db) =>
        db.select({ id: flags.id }).from(flags).where(eq(flags.lit, true)),
      );
      await withoutEventTriggers({ pg, renders });

      await expect(
        renders(async () => {
          await pg.query('ALTER TABLE flags ALTER COLUMN lit TYPE boolean USING NOT lit');
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
      await expect(
        renders(() => orm.update(flags).set({ id: 'f3' }).where(eq(flags.id, 'f2'))),
      ).resolves.toBe(true);
    });

    it.each([
      ['an event trigger counts', withEventTriggers, 0],
      ['the digest alone tells', withoutEventTriggers, PAST_DIGEST_MS],
    ] as const)(
      'renders a read again once a unique index its plan relied on is dropped, where %s',
      async (_where, host, waitMs) => {
        // PostgreSQL removes the outer join of a table whose unique index says it adds no rows.
        const { orm, pg, renders } = await watching((db) => {
          return db
            .select({ id: children.id })
            .from(children)
            .leftJoin(parents, eq(parents.id, children.parentId))
            .where(eq(children.projectId, 'p1'));
        });
        await host({ pg, renders });

        await expect(
          renders(async () => {
            await pg.query('DROP INDEX parents_id');
            await sleep(waitMs);
          }),
        ).resolves.toBe(true);
        await expect(
          renders(() => orm.insert(parents).values({ id: 'a', parentName: 'again' })),
        ).resolves.toBe(true);
      },
    );

    it('fails a read once a temporary table inherits from its table, and renders it again once that is dropped', async () => {
      const { pg, renders } = await watching((db) => launchTasks(db));

      // Its plan reads the temporary table besides, which nothing follows: a fault of the render.
      await expect(
        renders(() => {
          return pg.exec(`
            CREATE TEMPORARY TABLE staging () INHERITS (tasks);
            INSERT INTO staging (project_id, title) VALUES ('p1', 'from the child');
          `);
        }),
      ).rejects.toThrow(/does not follow/u);
      await expect(renders(() => pg.query('DROP TABLE staging'))).resolves.toBe(true);
    });

    it('fails a read once a temporary table of its name stands before its table', async () => {
      const { pg, renders } = await watching((db) => launchTasks(db));

      await expect(
        renders(() => pg.query('CREATE TEMPORARY TABLE tasks (LIKE public.tasks INCLUDING ALL)')),
      ).rejects.toThrow(/does not follow/u);
      await expect(renders(() => pg.query('DROP TABLE pg_temp.tasks'))).resolves.toBe(true);
    });

    it.each([
      [
        'a temporary table inherits from its table',
        'CREATE TEMPORARY TABLE staging () INHERITS (tasks)',
      ],
      [
        'a temporary table of its name stands before it',
        'CREATE TEMPORARY TABLE tasks (LIKE public.tasks)',
      ],
    ])('fails a read once %s, where the digest alone tells', async (_what, made) => {
      const { pg, renders } = await watching((db) => launchTasks(db));
      await withoutEventTriggers({ pg, renders });

      await expect(
        renders(async () => {
          await pg.query(made);
          await sleep(PAST_DIGEST_MS);
        }),
      ).rejects.toThrow(/does not follow/u);
    });

    it.each([
      [
        'an aggregate defined again',
        (db: Orm) => {
          return db.execute(
            sql`SELECT total(${tasks.title}) AS t FROM ${tasks} WHERE ${tasks.projectId} = 'p1'`,
          );
        },
        "CREATE OR REPLACE AGGREGATE total(text) (SFUNC = add_hundred, STYPE = int, INITCOND = '0')",
      ],
      [
        "a text search configuration's mapping",
        (db: Orm) => {
          return db.execute(
            sql`SELECT ${tasks.id} FROM ${tasks} WHERE to_tsvector('public.words', ${tasks.title}) @@ to_tsquery('public.words', 'ones')`,
          );
        },
        'ALTER TEXT SEARCH CONFIGURATION public.words ALTER MAPPING FOR asciiword WITH english_stem',
      ],
      [
        "a view's options",
        (db: Orm) => db.execute(sql`SELECT id FROM chosen_tasks`),
        'ALTER VIEW chosen_tasks SET (security_invoker = true)',
      ],
    ])(
      'renders every read again once %s, where the digest alone tells',
      async (_what, read, changed) => {
        const { pg, renders } = await watching(read);
        await withoutEventTriggers({ pg, renders });

        await expect(
          renders(async () => {
            await pg.query(changed);
            await sleep(PAST_DIGEST_MS);
          }),
        ).resolves.toBe(true);
      },
    );

    it("renders a read again once a key's rows are rewritten in a replica's session", async () => {
      const { orm, pg, renders } = await watching((db) =>
        db.select({ id: flags.id }).from(flags).where(eq(flags.lit, true)),
      );

      await expect(
        renders(() => {
          return pg.exec(`
            SET session_replication_role = replica;
            ALTER TABLE flags ALTER COLUMN lit TYPE boolean USING NOT lit;
            RESET session_replication_role;
          `);
        }),
      ).resolves.toBe(true);
      await expect(
        renders(() => orm.update(flags).set({ id: 'f3' }).where(eq(flags.id, 'f2'))),
      ).resolves.toBe(true);
    });

    it('renders a read again once its role is granted one a policy names', async () => {
      const { pg, renders } = await watching(
        (db) => db.select({ id: labels.id }).from(labels),
        (setup) => {
          return setup.exec(`
            CREATE ROLE app;
            CREATE ROLE admins;
            GRANT USAGE ON SCHEMA reactive_state TO app;
            GRANT SELECT ON ALL TABLES IN SCHEMA reactive_state TO app;
            GRANT SELECT ON ALL TABLES IN SCHEMA public TO app;
            CREATE POLICY seen ON labels FOR SELECT TO admins USING (true);
            SET ROLE app;
          `);
        },
      );

      await expect(
        renders(async () => {
          await pg.exec('RESET ROLE; GRANT admins TO app; SET ROLE app;');
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
    });

    it('follows no text key where the database holds a collation that finds two texts equal', async () => {
      const { orm, renders } = await watching(
        (db) => {
          return db
            .select({ id: projects.id })
            .from(projects)
            .where(sql`${projects.id} COLLATE folded = ${'P1'}`);
        },
        (setup) => {
          return setup.query(
            "CREATE COLLATION folded (provider = icu, locale = '@colStrength=secondary', deterministic = false)",
          );
        },
      );

      await expect(
        renders(() => orm.update(projects).set({ title: 'Launched' }).where(eq(projects.id, 'p1'))),
      ).resolves.toBe(true);
    });

    it.each([
      ['', false],
      [', in a transaction', true],
    ])(
      'follows no condition of the values of a query whose options type them otherwise%s',
      async (_where, inTransaction) => {
        const statement = 'SELECT title FROM projects WHERE id = $1';
        const options = { paramTypes: [BPCHAR] };
        const { orm, renders } = await watching((_db, setup) => {
          const client = setup.follow.client(setup.pg);
          return inTransaction
            ? client.transaction((transaction) => transaction.query(statement, ['p1  '], options))
            : client.query(statement, ['p1  '], options);
        });

        await expect(
          renders(() =>
            orm.update(projects).set({ title: 'Launched' }).where(eq(projects.id, 'p1')),
          ),
        ).resolves.toBe(true);
      },
    );

    it('follows the rows of a table whose name holds a dot', async () => {
      const { orm, renders } = await watching((db) =>
        db.select({ note: oddName.note }).from(oddName).where(eq(oddName.id, 'a')),
      );

      await expect(
        renders(() => orm.update(oddName).set({ note: 'other' }).where(eq(oddName.id, 'b'))),
      ).resolves.toBe(false);
      await expect(
        renders(() => orm.update(oddName).set({ note: 'again' }).where(eq(oddName.id, 'a'))),
      ).resolves.toBe(true);
    });

    it("fails a read once a temporary sequence of its table's name stands before it", async () => {
      const { pg, renders } = await watching((db) => launchTasks(db));

      await expect(renders(() => pg.query('CREATE TEMPORARY SEQUENCE tasks'))).rejects.toThrow(
        /does not exist/u,
      );
    });

    it('renders a read again once a temporary function it names is defined again', async () => {
      const { pg, renders } = await watching(
        (db) => {
          return db
            .select({ id: tasks.id })
            .from(tasks)
            .where(sql`${tasks.projectId} = pg_temp.picked()`);
        },
        (setup) => setup.query(pickedOf('p1')),
      );

      await expect(renders(() => pg.query(pickedOf('p2')))).resolves.toBe(true);
    });

    it("renders a read again once a temporary type of a type's name it names stands before it", async () => {
      const { pg, renders } = await watching(
        (db) => db.execute(sql`SELECT count(*) AS n FROM tasks WHERE title = 'one'::short_text`),
        (setup) => setup.query('CREATE DOMAIN short_text AS text'),
      );

      await expect(
        renders(() => pg.query('CREATE DOMAIN pg_temp.short_text AS varchar(2)')),
      ).resolves.toBe(true);
    });

    it('renders a read again once a temporary collation is made or dropped, which a statement may name', async () => {
      const { pg, renders } = await watching((db) => launchTasks(db));

      await expect(renders(() => pg.query(TEMPORARY_FOLDED))).resolves.toBe(true);
      await expect(renders(() => pg.query('DROP COLLATION pg_temp.folded'))).resolves.toBe(true);
    });

    it.each([
      'CREATE TEXT SEARCH CONFIGURATION pg_temp.words (COPY = pg_catalog.simple)',
      'CREATE TEXT SEARCH DICTIONARY pg_temp.words (TEMPLATE = pg_catalog.simple)',
    ])(
      'renders a read again once a temporary text search object is made, altered or dropped: %s',
      async (made) => {
        const { pg, renders } = await watching((db) => launchTasks(db));
        const kind = made.includes('CONFIGURATION') ? 'CONFIGURATION' : 'DICTIONARY';
        const altered =
          kind === 'CONFIGURATION'
            ? 'ALTER TEXT SEARCH CONFIGURATION pg_temp.words DROP MAPPING FOR numword'
            : 'ALTER TEXT SEARCH DICTIONARY pg_temp.words (ACCEPT = false)';

        await expect(renders(() => pg.query(made))).resolves.toBe(true);
        await expect(renders(() => pg.query(altered))).resolves.toBe(true);
        await expect(
          renders(() => pg.query(`DROP TEXT SEARCH ${kind} pg_temp.words`)),
        ).resolves.toBe(true);
      },
    );

    it("renders no read again for a temporary table's copied constraints and statistics, nor its making and dropping", async () => {
      const { pg, renders } = await watching(
        (db) => launchTasks(db),
        (setup) => {
          return setup.exec(`
            CREATE STATISTICS tasks_paired ON project_id, title FROM tasks;
            ALTER TABLE tasks ADD CONSTRAINT titled CHECK (title <> '');
            COMMENT ON CONSTRAINT titled ON tasks IS 'a title';
          `);
        },
      );

      await expect(
        renders(() => pg.query('CREATE TEMP TABLE staging (LIKE tasks INCLUDING ALL)')),
      ).resolves.toBe(false);
      await expect(renders(() => pg.query('DROP TABLE pg_temp.staging'))).resolves.toBe(false);
    });

    it.each([
      [
        'CREATE DOMAIN pg_temp.code AS varchar(2)',
        "ALTER DOMAIN pg_temp.code ADD CHECK (VALUE <> '')",
        'DROP DOMAIN pg_temp.code',
      ],
      [
        "CREATE TYPE pg_temp.mood AS ENUM ('a', 'b')",
        "ALTER TYPE pg_temp.mood RENAME VALUE 'a' TO 'c'",
        'DROP TYPE pg_temp.mood',
      ],
      [
        'CREATE TYPE pg_temp.pair AS (x text, y text)',
        'ALTER TYPE pg_temp.pair RENAME ATTRIBUTE x TO z',
        'DROP TYPE pg_temp.pair',
      ],
    ])(
      'renders a read again once a temporary type is made, altered or dropped: %s',
      async (made, altered, dropped) => {
        const { pg, renders } = await watching((db) => launchTasks(db));

        await expect(renders(() => pg.query(made))).resolves.toBe(true);
        await expect(renders(() => pg.query(altered))).resolves.toBe(true);
        await expect(renders(() => pg.query(dropped))).resolves.toBe(true);
      },
    );

    it('renders no read again for a temporary table made after a temporary type', async () => {
      const { pg, renders } = await watching(
        (db) => launchTasks(db),
        (setup) => setup.query('CREATE DOMAIN pg_temp.code AS varchar(2)'),
      );

      await expect(renders(() => pg.query('CREATE TEMP TABLE staging (id text)'))).resolves.toBe(
        false,
      );
      await expect(
        renders(() => pg.query('ALTER TABLE pg_temp.staging RENAME COLUMN id TO key')),
      ).resolves.toBe(false);
      await expect(renders(() => pg.query('DROP TABLE pg_temp.staging'))).resolves.toBe(false);
    });

    it.each([
      "CREATE FUNCTION pg_temp.made() RETURNS pg_temp.duo LANGUAGE sql IMMUTABLE AS $$ SELECT 'p1', 'p2' $$",
      'CREATE DOMAIN pg_temp.paired AS pg_temp.duo',
      'CREATE TYPE pg_temp.wrap AS (s pg_temp.duo)',
      'CREATE DOMAIN pg_temp.paired AS pg_temp.duo[]',
      "CREATE FUNCTION pg_temp.made() RETURNS pg_temp.duo[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[ROW('p1', 'p2')::pg_temp.duo] $$",
    ])(
      'renders a read again once a temporary table an object is of is altered or dropped: %s',
      async (made) => {
        const { pg, renders } = await watching(
          (db) => launchTasks(db),
          async (setup) => {
            await setup.query('CREATE TEMP TABLE duo (x text, y text)');
            await setup.query(made);
          },
        );

        await expect(
          renders(() => pg.query('ALTER TABLE pg_temp.duo RENAME COLUMN x TO z')),
        ).resolves.toBe(true);
        await expect(renders(() => pg.query('DROP TABLE pg_temp.duo CASCADE'))).resolves.toBe(true);
      },
    );

    it('renders a read again once a temporary table is altered that a domain is of through its child', async () => {
      const { pg, renders } = await watching(
        (db) => launchTasks(db),
        async (setup) => {
          await setup.query('CREATE TEMP TABLE duo (x text, y text)');
          await setup.query('CREATE TEMP TABLE kid () INHERITS (duo)');
          await setup.query('CREATE DOMAIN pg_temp.paired AS pg_temp.kid');
        },
      );

      await expect(
        renders(() => pg.query('ALTER TABLE pg_temp.duo RENAME COLUMN x TO z')),
      ).resolves.toBe(true);
    });

    it('renders a read again once a temporary ancestor of a named row type is altered', async () => {
      const { pg, renders } = await watching(
        (db) => launchTasks(db),
        async (setup) => {
          await setup.query('CREATE TEMP TABLE ancestor (x text, y text)');
          await setup.query('CREATE TEMP TABLE middle () INHERITS (ancestor)');
          await setup.query('CREATE TEMP TABLE youngest () INHERITS (middle)');
          await setup.query('CREATE DOMAIN pg_temp.paired AS pg_temp.youngest[]');
        },
      );

      await expect(
        renders(() => pg.query('ALTER TABLE pg_temp.ancestor RENAME COLUMN x TO z')),
      ).resolves.toBe(true);
    });

    it('renders a read again once a temporary table a domain is of is altered, where the digest alone tells', async () => {
      const { pg, renders } = await watching(
        (db) => launchTasks(db),
        async (setup) => {
          await setup.query('CREATE TEMP TABLE duo (x text, y text)');
          await setup.query('CREATE DOMAIN pg_temp.paired AS pg_temp.duo[]');
        },
      );
      await withoutEventTriggers({ pg, renders });

      await expect(
        renders(async () => {
          await pg.query('ALTER TABLE pg_temp.duo RENAME COLUMN x TO z');
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
    });

    it('renders a read again once a temporary composite type is altered, where the digest alone tells', async () => {
      const { pg, renders } = await watching(
        (db) => launchTasks(db),
        (setup) => setup.query('CREATE TYPE pg_temp.pair AS (x text, y text)'),
      );
      await withoutEventTriggers({ pg, renders });

      await expect(
        renders(async () => {
          await pg.query('ALTER TYPE pg_temp.pair RENAME ATTRIBUTE x TO z');
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
    });

    it('renders a read again once a temporary text search configuration is altered, where the digest alone tells', async () => {
      const { pg, renders } = await watching(
        (db) => launchTasks(db),
        (setup) =>
          setup.query('CREATE TEXT SEARCH CONFIGURATION pg_temp.words (COPY = pg_catalog.simple)'),
      );
      await withoutEventTriggers({ pg, renders });

      await expect(
        renders(async () => {
          await pg.query('ALTER TEXT SEARCH CONFIGURATION pg_temp.words DROP MAPPING FOR numword');
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
    });

    it('renders a read again once a temporary collation is made, where the digest alone tells', async () => {
      const { pg, renders } = await watching((db) => launchTasks(db));
      await withoutEventTriggers({ pg, renders });

      await expect(
        renders(async () => {
          await pg.query(TEMPORARY_FOLDED);
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
    });

    it.each([
      ['extra_float_digits', '0'],
      ['bytea_output', 'escape'],
      ['DateStyle', "'SQL, DMY'"],
      ['TimeZone', "'Asia/Tokyo'"],
      ['IntervalStyle', 'sql_standard'],
      ['timezone_abbreviations', "'India'"],
      ['array_nulls', 'off'],
      ['transform_null_equals', 'on'],
    ])('renders a read again once its session sets %s', async (name, value) => {
      const { pg, renders } = await watching((db) => launchTasks(db));

      await expect(
        renders(async () => {
          await pg.query(`SET ${name} = ${value}`);
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
    });

    it("renders a read again once a key's rows are rewritten in a session that fires no event trigger", async () => {
      const { pg, renders } = await watching((db) =>
        db.select({ id: flags.id }).from(flags).where(eq(flags.lit, true)),
      );

      await expect(
        renders(async () => {
          await pg.exec(`
            SET event_triggers = off;
            ALTER TABLE flags ALTER COLUMN lit TYPE boolean USING NOT lit;
            RESET event_triggers;
          `);
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
    });

    it('renders a read again once its role inherits the rights of one a policy names', async () => {
      const { pg, renders } = await watching(
        (db) => db.select({ id: labels.id }).from(labels),
        asApp(`
          CREATE ROLE admins;
          GRANT SELECT ON labels TO app;
          CREATE POLICY seen ON labels FOR SELECT TO admins USING (true);
          GRANT admins TO app WITH INHERIT FALSE;
        `),
      );

      await expect(
        renders(async () => {
          await pg.exec('RESET ROLE; GRANT admins TO app WITH INHERIT TRUE; SET ROLE app;');
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
    });

    it.each([
      ['granted one a policy names', 'GRANT admins TO reporter'],
      ['let past every policy', 'ALTER ROLE reporter BYPASSRLS'],
    ])(
      'renders a read of a view again once its owner is %s, of the rows it sees now',
      async (_what, changed) => {
        const { pg, render, renders } = await watching(
          (db) => db.execute(sql`SELECT id FROM all_labels`),
          asApp(OWNED_VIEW),
        );

        await expect(render()).resolves.toContain('"rows":[]');

        await expect(
          renders(async () => {
            await pg.exec(`RESET ROLE; ${changed}; SET ROLE app;`);
            await sleep(PAST_DIGEST_MS);
          }),
        ).resolves.toBe(true);
        await expect(render()).resolves.toContain('"rows":[{"id":"l1"},{"id":"l2"}]');
      },
    );

    it('fails a read of a view once its owner is refused its table', async () => {
      const { pg, renders } = await watching(
        (db) => db.execute(sql`SELECT id FROM all_labels`),
        asApp(OWNED_VIEW),
      );

      await expect(
        renders(async () => {
          await pg.exec('RESET ROLE; REVOKE SELECT ON labels FROM reporter; SET ROLE app;');
          await sleep(PAST_DIGEST_MS);
        }),
      ).rejects.toThrow(/permission denied for table labels/u);
    });

    it('fails a read once its role is refused a column it reads', async () => {
      const { pg, renders } = await watching(
        (db) => db.select({ id: flags.id, lit: flags.lit }).from(flags),
        asApp('GRANT SELECT (id, lit) ON flags TO app;'),
      );

      await expect(
        renders(async () => {
          await pg.exec('RESET ROLE; REVOKE SELECT (lit) ON flags FROM app; SET ROLE app;');
          await sleep(PAST_DIGEST_MS);
        }),
      ).rejects.toThrow(/permission denied/u);
    });

    it("fails a read once its session refuses a policy's rows", async () => {
      const { pg, renders } = await watching(
        (db) => db.select({ id: labels.id }).from(labels),
        asApp('GRANT SELECT ON labels TO app;'),
      );

      await expect(
        renders(async () => {
          await pg.query('SET row_security = off');
          await sleep(PAST_DIGEST_MS);
        }),
      ).rejects.toThrow(/row-level security/u);
    });

    it('follows no condition of an enum key cast to text, which a collation may compare', async () => {
      const { orm, renders } = await watching(
        (db) => db.execute(sql`SELECT s FROM states WHERE s = ${'OPEN'}`),
        (setup) => {
          return setup.exec(`
            CREATE COLLATION folded (provider = icu, locale = '@colStrength=secondary', deterministic = false);
            CREATE VIEW states AS SELECT id COLLATE folded AS s FROM projects UNION ALL SELECT status::text FROM tasks;
          `);
        },
      );

      await expect(
        renders(() => orm.update(tasks).set({ status: 'closed' }).where(eq(tasks.title, 'one'))),
      ).resolves.toBe(true);
    });

    it("follows an enum key's rows by its labels, though the application casts it to text otherwise", async () => {
      const { orm, renders } = await watching(
        (db) => db.select({ id: tasks.id }).from(tasks).where(eq(tasks.status, 'open')),
        (setup) => {
          return setup.exec(`
            CREATE FUNCTION status_label(s status) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'label:' || format('%s', s) $$;
            CREATE CAST (status AS text) WITH FUNCTION status_label(status);
          `);
        },
      );

      await expect(
        renders(() => orm.update(tasks).set({ title: 'renamed' }).where(eq(tasks.title, 'two'))),
      ).resolves.toBe(true);
    });

    it('follows no condition of a value its connection sends as other text, of a name', async () => {
      const { orm, renders } = await watching(
        (_db, setup) => {
          // `$1` is a `name` here, which the plan writes of no cast.
          return setup.follow
            .client(setup.pg)
            .query('SELECT $1::name AS n, title FROM projects WHERE id = $1', ['P1']);
        },
        (setup) => {
          setup.serializers[NAME] = (value: unknown) => String(value).toLowerCase();
          return Promise.resolve();
        },
      );

      await expect(
        renders(() => orm.update(projects).set({ title: 'Launched' }).where(eq(projects.id, 'p1'))),
      ).resolves.toBe(true);
    });

    it('follows no condition of a value its connection sends as other text', async () => {
      const { orm, renders } = await watching(
        (db) => db.select({ id: projects.id }).from(projects).where(eq(projects.id, 'P1')),
        (setup) => {
          // As `PGlite.create({ serializers })` gives them: of every query of the instance.
          setup.serializers[TEXT] = (value: unknown) => String(value).toLowerCase();
          return Promise.resolve();
        },
      );

      await expect(
        renders(() => orm.update(projects).set({ title: 'Launched' }).where(eq(projects.id, 'p1'))),
      ).resolves.toBe(true);
    });

    it("follows no condition of a statement that names a table's columns otherwise", async () => {
      const { orm, renders } = await watching((_db, setup) => {
        // `p.id` is `org_id` here: the plan writes the name the statement gave it.
        return setup.follow
          .client(setup.pg)
          .query('SELECT p.title FROM projects AS p(code, id) WHERE p.id = $1', [ORG.one]);
      });

      await expect(
        renders(() => orm.update(projects).set({ title: 'Launched' }).where(eq(projects.id, 'p1'))),
      ).resolves.toBe(true);
    });

    it('renders a read again once a temporary view it read in place of its table is discarded', async () => {
      const { pg, renders } = await watching((db) => launchTasks(db));

      await expect(
        renders(() => {
          return pg.query(
            "CREATE TEMPORARY VIEW tasks AS SELECT * FROM public.tasks WHERE project_id = 'p2'",
          );
        }),
      ).resolves.toBe(true);
      // `DISCARD` fires no event trigger: the digest tells, as of the view the count told of.
      await expect(
        renders(async () => {
          await pg.query('DISCARD TEMP');
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
    });

    it("renders a read again once a temporary view's column is renamed, where the digest alone tells", async () => {
      const { pg, renders } = await watching(
        (db) => db.execute(sql`SELECT * FROM recent`),
        (setup) => setup.query('CREATE TEMPORARY VIEW recent AS SELECT * FROM tasks'),
      );
      await withoutEventTriggers({ pg, renders });

      await expect(
        renders(async () => {
          await pg.query('ALTER VIEW recent RENAME COLUMN title TO heading');
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
    });

    it("fails a read once a temporary table of a type's name it names stands before the type", async () => {
      const { pg, renders } = await watching((db) =>
        db.execute(sql`SELECT count(*) AS n FROM tasks WHERE status = 'open'::status`),
      );

      // Read again, of the table's row type: the read of the enum is not kept as it was.
      await expect(
        renders(() => pg.query('CREATE TEMPORARY TABLE status (x int)')),
      ).rejects.toThrow(/malformed record literal/u);
    });

    it('fails a read once a domain it names is constrained, where the digest alone tells', async () => {
      const { pg, renders } = await watching(
        (db) => db.execute(sql`SELECT count(*) AS n FROM tasks WHERE title = 'one'::short_text`),
        (setup) => setup.query('CREATE DOMAIN short_text AS text'),
      );
      await withoutEventTriggers({ pg, renders });

      // Read again, of a value the domain takes no more: the read is not kept as it was.
      await expect(
        renders(async () => {
          await pg.query('ALTER DOMAIN short_text ADD CONSTRAINT short CHECK (length(VALUE) < 3)');
          await sleep(PAST_DIGEST_MS);
        }),
      ).rejects.toMatchObject({
        cause: { message: expect.stringContaining('violates check constraint "short"') },
      });
    });

    it("follows no condition of a statement that reads a view of an alias of a space that names a table's columns", async () => {
      const { orm, renders } = await watching(
        (db) => db.execute(sql`SELECT title FROM spaced WHERE org = ${ORG.one}`),
        (setup) => {
          return setup.query(
            'CREATE VIEW spaced AS SELECT "a p".code, "a p".id AS org, "a p".title FROM projects AS "a p"(code, id)',
          );
        },
      );

      await expect(
        renders(() => orm.update(projects).set({ title: 'Launched' }).where(eq(projects.id, 'p1'))),
      ).resolves.toBe(true);
    });

    it("follows no condition of a statement that reads a view that names a table's columns otherwise", async () => {
      const { orm, renders } = await watching(
        (db) => db.execute(sql`SELECT title FROM renamed WHERE org = ${ORG.one}`),
        (setup) => {
          return setup.query(
            'CREATE VIEW renamed AS SELECT p.code, p.id AS org, p.title FROM projects AS p(code, id)',
          );
        },
      );

      await expect(
        renders(() => orm.update(projects).set({ title: 'Launched' }).where(eq(projects.id, 'p1'))),
      ).resolves.toBe(true);
    });

    it('follows no condition of a value an enum serializer given after the client sends as other text', async () => {
      const { orm, renders } = await watching(
        (db) => {
          return db
            .select({ id: tasks.id })
            .from(tasks)
            .where(sql`${tasks.status} = ${'CLOSED'}`);
        },
        async (setup) => {
          const { rows } = await setup.query<{ oid: number }>(
            "SELECT 'status'::regtype::oid AS oid",
          );
          setup.serializers[rows[0]?.oid ?? 0] = (value: unknown) => String(value).toLowerCase();
        },
      );

      await expect(
        renders(() => orm.update(tasks).set({ status: 'closed' }).where(eq(tasks.title, 'one'))),
      ).resolves.toBe(true);
    });

    it('reads the log and prunes it as a role of the rights it had on it before', async () => {
      const setup = await opened();
      await setup.pg.exec(`
        CREATE ROLE reader;
        GRANT USAGE ON SCHEMA reactive_state TO reader;
        GRANT SELECT ON reactive_state.changes, reactive_state.head TO reader;
        SET ROLE reader;
      `);

      await expect(setup.follow.store(setup.pg).changes(0, 10)).resolves.toBeDefined();
      await expect(setup.follow.prune(setup.pg, Date.now())).resolves.toBeUndefined();
    });

    it("follows the log on where the schema's digest cannot be read, of every read again", async () => {
      const setup = await opened();
      const failing = {
        query: (statement: string, values: unknown[]) => {
          return statement.includes('AS "digest"')
            ? Promise.reject(new Error('canceling statement due to statement timeout'))
            : setup.pg.query(statement, values);
        },
      };
      const store = setup.follow.store(failing);
      const failed = vi.spyOn(console, 'error').mockImplementation(() => {
        // What the store logs of a digest it could not read, kept out of the output.
      });
      onTestFinished(() => {
        failed.mockRestore();
      });

      const first = await store.changes(0, 10);
      const second = await store.changes(0, 10);

      expect(second.epoch).not.toBe(first.epoch);
      expect(failed).toHaveBeenCalledWith(expect.stringContaining('statement timeout'));
    });

    it("reads the log as such a role where the database's default privileges keep functions from all", async () => {
      const setup = await opened(
        'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;',
      );
      await setup.pg.exec(`
        CREATE ROLE reader;
        GRANT USAGE ON SCHEMA reactive_state TO reader;
        GRANT SELECT ON reactive_state.changes, reactive_state.head TO reader;
        SET ROLE reader;
      `);

      await expect(setup.follow.store(setup.pg).changes(0, 10)).resolves.toBeDefined();
      await expect(setup.follow.prune(setup.pg, Date.now())).resolves.toBeUndefined();
    });

    it("renders a read again once a view of the log's schema it reads is defined again", async () => {
      const { pg, renders } = await watching(
        (db) => db.execute(sql`SELECT id FROM reactive_state.chosen`),
        (setup) => setup.query(logViewOf('p1')),
      );

      await expect(
        renders(async () => {
          await pg.query(logViewOf('p2'));
          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
    });

    it("fails a read of the log's own tables, which nothing follows", async () => {
      const setup = await opened();
      const { render } = await engineOf(setup, async (_props, $) => {
        const rows = await setup.orm.execute(sql`SELECT epoch FROM reactive_state.head`);
        return $.h('p', null, JSON.stringify(rows));
      });

      await expect(render()).rejects.toThrow(/does not follow/u);
    });

    it("fails a read once a table of the log's schema inherits from its table", async () => {
      const { pg, renders } = await watching((db) => launchTasks(db));

      await expect(
        renders(() => {
          return pg.exec(`
            CREATE TABLE reactive_state.kid () INHERITS (tasks);
            INSERT INTO reactive_state.kid (project_id, title) VALUES ('p1', 'from the child');
          `);
        }),
      ).rejects.toThrow(/does not follow/u);
    });

    it.each(['mood', 'head_pkey'])(
      "renders a read again once a type of the application's in the log's schema is altered: %s",
      async (name) => {
        const { pg, renders } = await watching(
          (db) => db.execute(sql.raw(`SELECT enum_range(NULL::reactive_state.${name})::text AS v`)),
          (setup) => setup.query(`CREATE TYPE reactive_state.${name} AS ENUM ('a', 'b')`),
        );

        await expect(
          renders(() => pg.query(`ALTER TYPE reactive_state.${name} RENAME VALUE 'a' TO 'c'`)),
        ).resolves.toBe(true);
      },
    );

    it("renders a read again once a function of the application's of a log function's name changes", async () => {
      const { pg, renders } = await watching(
        (db) => db.execute(sql`SELECT reactive_state.note(1) AS v`),
        (setup) => setup.query(noteOf('one')),
      );

      await expect(renders(() => pg.query(noteOf('two')))).resolves.toBe(true);
    });

    it.each(['off', 'on'])(
      "counts no change of the schema as the log's statements run again, of quote_all_identifiers %s",
      async (quoted) => {
        const setup = await opened();
        const before = await countOf(setup.pg);
        await setup.pg.query(`SET quote_all_identifiers = ${quoted}`);

        await installed(setup.pg, setup.follow);

        await expect(countOf(setup.pg)).resolves.toBe(before);
      },
    );

    it.each(['off', 'on'])(
      "counts no drop of the log's own function, of quote_all_identifiers %s",
      async (quoted) => {
        const setup = await opened();
        const before = await countOf(setup.pg);
        await setup.pg.query(`SET quote_all_identifiers = ${quoted}`);

        await setup.pg.query('DROP FUNCTION reactive_state.fold_ddl(double precision)');

        await expect(countOf(setup.pg)).resolves.toBe(before);
      },
    );

    it("counts no drop of the log's own function once its command's event trigger is gone", async () => {
      const setup = await opened();
      await setup.pg.query('DROP EVENT TRIGGER reactive_state_ddl');
      const before = await countOf(setup.pg);

      await setup.pg.query('DROP FUNCTION reactive_state.fold_ddl(double precision)');

      await expect(countOf(setup.pg)).resolves.toBe(before);
    });

    it("counts no change of the schema as the log's statements make its tables again", async () => {
      const setup = await opened();
      await setup.pg.exec(`
        ALTER TABLE reactive_state.changes DROP COLUMN side, DROP COLUMN image;
        ALTER TABLE reactive_state.ddl REPLICA IDENTITY DEFAULT;
      `);
      const before = await countOf(setup.pg);

      await installed(setup.pg, setup.follow);

      await expect(countOf(setup.pg)).resolves.toBe(before);
    });

    it("counts no change of the schema as the log's statements run again over a table an operator partitioned", async () => {
      const setup = await opened();
      await setup.pg.exec(`
        DROP TABLE reactive_state.changes;
        CREATE TABLE reactive_state.changes (seq bigint PRIMARY KEY, schema_name text NOT NULL,
          table_name text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp(), side text,
          image jsonb) PARTITION BY RANGE (seq);
      `);
      const before = await countOf(setup.pg);

      await installed(setup.pg, setup.follow);

      await expect(countOf(setup.pg)).resolves.toBe(before);
    });

    it.each(['off', 'on'])(
      "counts a table of the log's schema whose name is a log table's but for a quote, of quote_all_identifiers %s",
      async (quoted) => {
        const setup = await opened();
        await setup.pg.query(`SET quote_all_identifiers = ${quoted}`);
        const before = await countOf(setup.pg);

        await setup.pg.query('CREATE TABLE reactive_state."he""ad" (id text)');

        await expect(countOf(setup.pg)).resolves.not.toBe(before);
      },
    );

    it.each(['off', 'on'])(
      "counts a function of the log's schema whose name is a log function's but for a quote, of quote_all_identifiers %s",
      async (quoted) => {
        const setup = await opened();
        await setup.pg.query(`SET quote_all_identifiers = ${quoted}`);
        const before = await countOf(setup.pg);

        await setup.pg.query(
          'CREATE FUNCTION reactive_state."no""te"(a text, b text) RETURNS text LANGUAGE sql AS $$ SELECT a $$',
        );
        const made = await countOf(setup.pg);
        await setup.pg.query('DROP FUNCTION reactive_state."no""te"(text, text)');

        expect(made).not.toBe(before);
        await expect(countOf(setup.pg)).resolves.not.toBe(made);
      },
    );

    it.each(['log_two', 'user'])(
      "counts none of another log's statements as they run again, of the namespace %s",
      async (namespace) => {
        const setup = await opened();
        const other = followDrizzle(schema, { namespace });
        await installed(setup.pg, other);
        const before = [await countOf(setup.pg), await countOf(setup.pg, namespace)];

        await installed(setup.pg, other);
        await installed(setup.pg, setup.follow);

        await expect(
          Promise.all([countOf(setup.pg), countOf(setup.pg, namespace)]),
        ).resolves.toStrictEqual(before);
      },
    );

    it("renders nothing again as another log's statements run again", async () => {
      const { pg, renders } = await watching((db) => launchTasks(db));
      const other = followDrizzle(schema, { namespace: 'log_two' });
      await renders(() => installed(pg, other));

      await expect(renders(() => installed(pg, other))).resolves.toBe(false);
    });

    it('counts the statements of another log that made no event trigger', async () => {
      const setup = await opened();
      const other = followDrizzle(schema, { namespace: 'log_two' });
      await installed(setup.pg, other);
      await setup.pg.exec(`
        DROP EVENT TRIGGER log_two_ddl;
        DROP EVENT TRIGGER log_two_drop;
      `);
      const before = await countOf(setup.pg);

      await installed(setup.pg, other);

      await expect(countOf(setup.pg)).resolves.not.toBe(before);
    });

    it.each([
      ['a view', 'CREATE VIEW log_two.chosen AS SELECT 1 AS one', 'DROP VIEW log_two.chosen'],
      [
        "a function of a log function's name and other arguments",
        'CREATE FUNCTION log_two.note(n integer) RETURNS integer LANGUAGE sql AS $$ SELECT n $$',
        'DROP FUNCTION log_two.note(integer)',
      ],
    ])("counts %s of the application's in another log's schema", async (_what, make, drop) => {
      const setup = await opened();
      await installed(setup.pg, followDrizzle(schema, { namespace: 'log_two' }));
      const before = await countOf(setup.pg);

      await setup.pg.query(make);
      const made = await countOf(setup.pg);
      await setup.pg.query(drop);

      expect(made).not.toBe(before);
      await expect(countOf(setup.pg)).resolves.not.toBe(made);
    });

    it.each(['app', 'public'])(
      "counts a function of a log function's signature and a table beside it, in a schema of the log's tables: %s",
      async (name) => {
        const setup = await opened(`
          CREATE SCHEMA IF NOT EXISTS ${name};
          CREATE TABLE ${name}.head (id text);
          CREATE TABLE ${name}.changes (id text);
          CREATE TABLE ${name}.ddl (id text);
        `);
        const before = await countOf(setup.pg);

        await setup.pg.query(
          `CREATE FUNCTION ${name}.note(a text, b text) RETURNS text LANGUAGE sql AS $$ SELECT a $$`,
        );
        const made = await countOf(setup.pg);
        await setup.pg.query(`ALTER TABLE ${name}.head ADD COLUMN note text`);

        expect(made).not.toBe(before);
        await expect(countOf(setup.pg)).resolves.not.toBe(made);
      },
    );

    it.each([
      ['another function', 'app.watch', 'app_ddl'],
      ['another name', 'app.note_ddl', 'app_watch'],
      ["another schema's function", 'public.note_ddl', 'app_ddl'],
    ])(
      "counts a function of a log function's signature in a schema whose event trigger is of %s",
      async (_what, run, trigger) => {
        const setup = await opened(`
          CREATE SCHEMA app;
          CREATE FUNCTION ${run}() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;
          CREATE EVENT TRIGGER ${trigger} ON ddl_command_end EXECUTE FUNCTION ${run}();
        `);
        const before = await countOf(setup.pg);

        await setup.pg.query(
          'CREATE FUNCTION app.note(a text, b text) RETURNS text LANGUAGE sql AS $$ SELECT a $$',
        );

        await expect(countOf(setup.pg)).resolves.not.toBe(before);
      },
    );

    it.each(['pg_tempdata', 'pg_temporary', 'pg_toast_tempdata'])(
      "counts a change of the application's schema whose name begins as a temporary one's: %s",
      async (name) => {
        const setup = await opened(`CREATE SCHEMA ${name};`);
        const before = await countOf(setup.pg);

        await setup.pg.query(`CREATE VIEW ${name}.chosen AS SELECT 1 AS one`);
        const made = await countOf(setup.pg);
        await setup.pg.query(`DROP VIEW ${name}.chosen`);

        expect(made).not.toBe(before);
        await expect(countOf(setup.pg)).resolves.not.toBe(made);
      },
    );

    it("counts no staging table of the session's temporary schema", async () => {
      const setup = await opened();
      const before = await countOf(setup.pg);

      await setup.pg.exec(`
        CREATE TEMP TABLE staging (id text, note text);
        DROP TABLE staging;
      `);

      await expect(countOf(setup.pg)).resolves.toBe(before);
    });

    it.each([
      ['a lock timeout', 'lock_not_available', '55P03'],
      ['a deadlock', 'deadlock_detected', '40P01'],
    ])(
      'fails a command the count meets %s for, which leaves nothing to count',
      async (_what, condition, code) => {
        const setup = await opened();
        await countRefused(setup.pg, condition);
        const before = await countOf(setup.pg);

        await expect(
          setup.pg.query('CREATE VIEW counted AS SELECT 1 AS one'),
        ).rejects.toMatchObject({ code });
        await expect(setup.pg.query('DROP VIEW chosen_tasks')).rejects.toMatchObject({ code });

        await expect(countOf(setup.pg)).resolves.toBe(before);
        await expect(
          setup.pg.query<{ made: string | null; kept: string | null }>(
            "SELECT to_regclass('counted')::text AS made, to_regclass('chosen_tasks')::text AS kept",
          ),
        ).resolves.toMatchObject({ rows: [{ kept: 'chosen_tasks', made: null }] });
      },
    );

    it("fails no command over a fault of the count's own", async () => {
      const setup = await opened();
      await countRefused(setup.pg, 'insufficient_privilege');

      await expect(setup.pg.query('CREATE VIEW counted AS SELECT 1 AS one')).resolves.toBeDefined();
      await expect(setup.pg.query('DROP VIEW counted')).resolves.toBeDefined();
    });

    it.each([
      ['a comment', "COMMENT ON TABLE tasks IS 'the tasks'"],
      ['a grant', 'GRANT SELECT ON tasks TO PUBLIC'],
      ['an index', 'CREATE INDEX tasks_title ON tasks (title)'],
      ['an index built again', 'REINDEX TABLE tasks'],
      ['a staging table', 'CREATE TEMP TABLE staging (id text)'],
      ['a command that changed nothing', 'CREATE TABLE IF NOT EXISTS tasks (id text)'],
    ])('fails no command the count leaves out, for its lock: %s', async (_what, command) => {
      const setup = await opened();
      await countRefused(setup.pg, 'lock_not_available');

      await expect(setup.pg.query(command)).resolves.toBeDefined();
    });

    it("fails none of the log's statements as they run again, for the count's lock", async () => {
      const setup = await opened();
      await countRefused(setup.pg, 'lock_not_available');

      await expect(installed(setup.pg, setup.follow)).resolves.toBeUndefined();
    });

    it('fails a command past the lock timeout its session set', async () => {
      const setup = await opened();
      await countTimedOut(setup.pg);
      await setup.pg.query("SET lock_timeout = '1s'");

      await expect(setup.pg.query('CREATE VIEW counted AS SELECT 1 AS one')).rejects.toMatchObject({
        code: '55P03',
      });
    });

    it('counts a command of a session that set no lock timeout', async () => {
      const setup = await opened();
      await countTimedOut(setup.pg);
      const before = await countOf(setup.pg);

      await setup.pg.query('CREATE VIEW counted AS SELECT 1 AS one');

      await expect(countOf(setup.pg)).resolves.not.toBe(before);
    });

    it('renders a read again by the digest, once a command that failed left a detach pending', async () => {
      const { pg, renders } = await watching(
        (db) => launchTasks(db),
        (setup) => {
          // A partition whose own constraint implies its bounds, of which a detach adds none.
          return setup.exec(`
            CREATE TABLE parted (id int NOT NULL) PARTITION BY RANGE (id);
            CREATE TABLE high (id int NOT NULL, CHECK (id >= 100 AND id < 200));
            ALTER TABLE parted ATTACH PARTITION high FOR VALUES FROM (100) TO (200);
          `);
        },
      );
      await countRefused(pg, 'lock_not_available');
      await renders(() => sleep(PAST_DIGEST_MS));

      await expect(
        renders(async () => {
          await expect(
            pg.query('ALTER TABLE parted DETACH PARTITION high CONCURRENTLY'),
          ).rejects.toMatchObject({ code: '55P03' });

          await sleep(PAST_DIGEST_MS);
        }),
      ).resolves.toBe(true);
    });

    it("runs none of a function another role made on a writer's search path, as it logs a write", async () => {
      const { orm, pg, renders } = await watching((db) => launchTasks(db));
      // A function of `format`'s name whose arguments match a call of the log's better than
      // PostgreSQL's own (`VARIADIC "any"`), in a schema the writer's search path holds.
      await pg.exec(`
        CREATE TABLE loot (what text);
        CREATE FUNCTION public.format(text, text) RETURNS text LANGUAGE sql AS $$ INSERT INTO public.loot VALUES ('hijacked') RETURNING $2 $$;
      `);

      await expect(
        renders(() => orm.insert(tasks).values({ projectId: 'p1', title: 'three' })),
      ).resolves.toBe(true);
      await expect(
        pg.query<{ n: string }>('SELECT count(*)::text AS n FROM loot'),
      ).resolves.toMatchObject({ rows: [{ n: '0' }] });
    });

    it('prunes the log where a publication of all tables publishes its deletes', async () => {
      const setup = await opened();
      const store = setup.follow.store(setup.pg);
      const counted = async (log: 'changes' | 'ddl') => {
        const { rows } = await setup.pg.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM reactive_state.${log}`,
        );
        return rows[0]?.n;
      };
      // Two commands the schema's count takes a row each of, and a followed row the log takes an
      // entry of.
      await setup.pg.query('CREATE PUBLICATION everything FOR ALL TABLES');
      await setup.pg.query('CREATE TABLE published (id text)');
      await setup.orm.insert(tasks).values({ projectId: 'p1', title: 'published' });
      const before = await store.changes(0, 10);

      expect(before.changes).toHaveLength(1);
      await expect(counted('changes')).resolves.toBe('1');
      await expect(counted('ddl')).resolves.toBe('2');

      await setup.follow.prune(setup.pg, Date.now() + PAST_DIGEST_MS);
      const after = await store.changes(0, 10);

      // The entry and the count's rows are deleted, the rows folded into one of their sum: the head
      // and the count go on as they were.
      await expect(counted('changes')).resolves.toBe('0');
      await expect(counted('ddl')).resolves.toBe('1');
      expect(after).toStrictEqual({ ...before, changes: [], floor: before.head + 1 });
    });

    it("keeps no key's value in the log, but its digest", async () => {
      const setup = await opened();
      await setup.orm
        .insert(projects)
        .values({ id: 'secret-token', orgId: ORG.one, title: 'Hidden' });

      const { rows } = await setup.pg.query<{ image: string }>(
        'SELECT image::text AS image FROM reactive_state.changes WHERE image IS NOT NULL',
      );

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((row) => row.image).join(',')).not.toContain('secret-token');
      expect(rows.map((row) => row.image).join(',')).toContain(keyDigest('secret-token'));
    });

    it("renders a read again once a view of the log's schema it reads is defined again, in its second", async () => {
      const { pg, renders } = await watching(
        (db) => db.execute(sql`SELECT id FROM reactive_state.chosen`),
        (setup) => setup.query(logViewOf('p1')),
      );

      await expect(renders(() => pg.query(logViewOf('p2')))).resolves.toBe(true);
    });

    it('follows the rows of a read where a view of the database holds a backslash', async () => {
      const { orm, renders } = await watching(
        (db) => launchTasks(db),
        (setup) =>
          setup.query(String.raw`CREATE VIEW numbered AS SELECT * FROM tasks WHERE title ~ '\d+'`),
      );

      await expect(
        renders(() => orm.update(tasks).set({ title: 'other' }).where(eq(tasks.projectId, 'p2'))),
      ).resolves.toBe(false);
    });

    it.each([
      [
        'a function of a body of the standard',
        'CREATE FUNCTION doubled(a int) RETURNS int IMMUTABLE STRICT LANGUAGE sql RETURN abs(a) * 2',
      ],
      [
        'a view that multiplies a call',
        'CREATE VIEW priced AS SELECT id * abs(id) AS n FROM tasks',
      ],
    ])('follows the rows of a read where the database holds %s', async (_what, made) => {
      const { orm, renders } = await watching(
        (db) => launchTasks(db),
        (setup) => setup.query(made),
      );

      await expect(
        renders(() => orm.update(tasks).set({ title: 'other' }).where(eq(tasks.projectId, 'p2'))),
      ).resolves.toBe(false);
    });

    it("logs the writes of a role of no right of the log, where the database's default privileges keep functions from all", async () => {
      const setup = await opened(
        'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;',
      );
      await setup.pg.exec(`
        CREATE ROLE writer;
        GRANT SELECT, INSERT, DELETE ON projects TO writer;
        SET ROLE writer;
      `);

      await expect(
        setup.pg.query("INSERT INTO projects VALUES ('p9', $1, 'Nine')", [ORG.one]),
      ).resolves.toBeDefined();
      await expect(setup.pg.query("DELETE FROM projects WHERE id = 'p9'")).resolves.toBeDefined();
    });

    it('asks the catalog with one plan of those a first render asks at once', async () => {
      let asked = 0;
      const { renders } = await watching(
        (db) => {
          return Promise.all([
            db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, 'p1')),
            db.select({ id: projects.id }).from(projects).where(eq(projects.id, 'p1')),
            db.select({ id: members.userId }).from(members).where(eq(members.projectId, 'p1')),
            db.select({ id: flags.id }).from(flags).where(eq(flags.lit, true)),
          ]);
        },
        (setup) => {
          const exec = setup.exec.bind(setup);
          vi.spyOn(setup, 'exec').mockImplementation((statement, options) => {
            if (statement.includes('AS "conforming"')) asked += 1;
            return exec(statement, options);
          });
          return Promise.resolve();
        },
      );

      expect(asked).toBe(1);
      await expect(renders(() => Promise.resolve())).resolves.toBe(false);
    });

    it("keeps the count of the schema's changes as the log is pruned", async () => {
      const setup = await opened();
      const store = setup.follow.store(setup.pg);
      await setup.pg.query('CREATE TABLE pruned (id text)');
      const before = await store.changes(0, 10);

      await setup.follow.prune(setup.pg, Date.now() + PAST_DIGEST_MS);
      await setup.pg.query('CREATE TABLE after_prune (id text)');
      await setup.pg.query('DROP TABLE after_prune');

      const after = await store.changes(0, 10);

      expect(after.epoch.split(':', 2)[1]).not.toBe(before.epoch.split(':', 2)[1]);
      await expect(
        setup.pg.query<{ rows: string }>('SELECT count(*)::text AS rows FROM reactive_state.ddl'),
      ).resolves.toMatchObject({ rows: [{ rows: '3' }] });
    });

    it('makes the log as a role that may make triggers on a table it does not own', async () => {
      const pg = await PGlite.create();
      onTestFinished(async () => {
        await pg.close();
      });
      await pg.exec(`
        CREATE ROLE host;
        CREATE TABLE tasks (id text PRIMARY KEY);
        GRANT TRIGGER, SELECT ON tasks TO host;
        GRANT CREATE ON DATABASE postgres TO host;
        SET ROLE host;
      `);
      const follow = followDrizzle({ tasks: pgTable('tasks', { id: text().primaryKey() }) });

      for (const statement of follow.captureSql()) {
        await expect(pg.query(statement)).resolves.toBeDefined();
      }
    });

    it("makes no event trigger where another role owns the log's schema", async () => {
      const pg = await PGlite.create();
      onTestFinished(async () => {
        await pg.close();
      });
      await pg.exec(`
        CREATE ROLE other;
        CREATE SCHEMA reactive_state AUTHORIZATION other;
        CREATE TABLE tasks (id text PRIMARY KEY);
      `);
      const follow = followDrizzle({ tasks: pgTable('tasks', { id: text().primaryKey() }) });
      for (const statement of follow.captureSql()) await pg.query(statement);

      await expect(
        pg.query<{ made: string }>('SELECT count(*)::text AS made FROM pg_event_trigger'),
      ).resolves.toMatchObject({ rows: [{ made: '0' }] });
    });

    it('reads the table whole for an entry whose row lacks a key the table has now', async () => {
      const setup = await opened();
      const store = setup.follow.store(setup.pg);
      const { head } = await store.changes(0, 10);
      // An entry a trigger wrote before `project_id` was a key of the table.
      await setup.pg.query(
        `INSERT INTO reactive_state.changes ("seq", "schema_name", "table_name", "side", "image") VALUES ($1, 'public', 'tasks', 'after', '{"id": "9"}'::jsonb)`,
        [head + 1],
      );

      const read = await store.changes(head, 10);

      expect(read.changes).toStrictEqual([{ id: '', seq: head + 1, table: 'tasks' }]);
    });

    it('asks its plans again once a store of another `followDrizzle` of the schema read that it changed', async () => {
      const setup = await opened();
      const evaluate = vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
        const rows = await setup.orm.execute(sql`SELECT title FROM chosen_tasks`);
        return $.h('p', null, JSON.stringify(rows.rows));
      });
      const { engine, render } = await engineOf(
        { follow: followDrizzle(schema), pg: setup.pg },
        evaluate,
      );
      await render();
      await setup.pg.query(
        "CREATE OR REPLACE VIEW chosen_tasks AS SELECT * FROM tasks WHERE project_id = 'p2'",
      );
      await sleep(PAST_DIGEST_MS);
      await engine.poke();
      await render();

      await setup.orm.insert(tasks).values({ projectId: 'p2', title: 'chosen' });
      await engine.poke();

      await expect(render()).resolves.toContain('chosen');
    });

    it("shows an operation's write behind more entries than a turn of reads reaches", async () => {
      const setup = await opened();
      const evaluate = vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
        const rows = await launchTasks(setup.orm);
        return $.h('p', null, rows.map((row) => row.title).join(','));
      });
      const { operate, render } = await engineOf(setup, evaluate, {
        'operations/tasks': {
          add: async () => {
            await setup.orm.insert(tasks).values({ projectId: 'p1', title: 'mine' });
          },
        },
      });
      await render();
      const rows = Array.from({ length: PAST_LOGGED_ROWS - 1 }, (_, at) => {
        return {
          projectId: 'p2',
          title: `t${String(at)}`,
        };
      });
      for (let statement = 0; statement < PAST_A_TURN; statement += 1) {
        await setup.orm.insert(tasks).values(rows);
      }

      await operate('operations/tasks', 'add');

      await expect(render()).resolves.toContain('mine');
    });

    it("names each table a commit of the log's rows changed once, not each row", async () => {
      const setup = await opened();
      const evaluate = vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
        const rows = await launchTasks(setup.orm);
        return $.h('p', null, rows.map((row) => row.title).join(','));
      });
      const { engine, render } = await engineOf(setup, evaluate);
      await render();
      const commits: CommitEvent[] = [];
      engine.onCommit((event) => {
        commits.push(event);
      });

      await setup.orm.insert(tasks).values([
        { projectId: 'p1', title: 'a' },
        { projectId: 'p2', title: 'b' },
      ]);
      await engine.poke();

      expect(commits.map((event) => event.changed)).toStrictEqual([['tasks:row']]);
    });

    it('reads a log further behind than a turn reaches by the tables its entries changed', async () => {
      const setup = await opened();
      const store = setup.follow.store(setup.pg);
      const { head } = await store.changes(0, 10);
      const rows = Array.from({ length: PAST_LOGGED_ROWS - 1 }, (_, at) => {
        return {
          projectId: 'p2',
          title: `t${String(at)}`,
        };
      });
      await setup.orm.insert(tasks).values(rows);
      await setup.orm.insert(tasks).values(rows);
      await setup.orm.update(projects).set({ title: 'Moved' }).where(eq(projects.id, 'p3'));
      const last = head + (PAST_LOGGED_ROWS - 1) * 2;

      // Past 10 pages of 10 entries: the tables, each at its last entry.
      await expect(store.changes(head, 10)).resolves.toMatchObject({
        changes: [
          { id: '', seq: last, table: 'tasks' },
          { id: '', seq: last + 2, table: 'projects' },
        ],
        head: last + 2,
      });
      // Of more tables than a page holds (2, past 10 entries and within 100): none, and a floor
      // past the head.
      await expect(store.changes(last - 20, 1)).resolves.toMatchObject({
        changes: [],
        floor: last + 3,
        head: last + 2,
      });
      // Within 10 turns of reads of 2 entries (`FOLD`, 200), the tables; past them, none, and a
      // floor past the head, though the page holds both tables.
      await expect(store.changes(head + 10, 2)).resolves.toMatchObject({
        changes: [
          { id: '', seq: last, table: 'tasks' },
          { id: '', seq: last + 2, table: 'projects' },
        ],
      });
      await expect(store.changes(head, 2)).resolves.toMatchObject({
        changes: [],
        floor: last + 3,
      });
      // Within 10 pages: the entries.
      await expect(store.changes(last - 1, 10)).resolves.toMatchObject({
        changes: [
          { seq: last, table: 'tasks' },
          { seq: last + 1, table: 'projects' },
          { seq: last + 2, table: 'projects' },
        ],
      });
    });
  },
);
