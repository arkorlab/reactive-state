import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { boolean, integer, pgSchema, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Engine } from '../src/authority/index.ts';
import {
  type ComponentProgram,
  type Json,
  PROTOCOL_VERSION,
  type RenderScope,
  type StateSource,
} from '../src/program.ts';
import { type DrizzleFollow, followDrizzle, followedDb } from '../src/sql/index.ts';
import {
  COMPONENT,
  engineOf,
  type Following,
  openedWith,
  type ProgramOptions,
} from './support/drizzle.ts';
import { storeThrough } from './support/follow-store.ts';
import { clientOf } from './support/frames.ts';

/**
 * A state bound to a row of the application's tables shows what the row holds, read as the render
 * reads anything else: through the application's connection, noted by what its plan names, and kept
 * with the rendering until a change the log tells of renders it again.
 */

const tasks = pgTable('tasks', {
  id: text().primaryKey(),
  projectId: text('project_id').notNull(),
  title: text().notNull(),
  done: boolean().notNull(),
  estimate: integer().notNull(),
  rank: smallint().notNull(),
  kind: text({ enum: ['bug', 'chore'] }).notNull(),
});
const notes = pgTable('notes', { id: uuid().primaryKey(), body: text().notNull() });
const labels = pgTable('labels', { id: text().primaryKey(), title: text().notNull() });
const entries = pgSchema('archive').table('old entries', {
  id: text().primaryKey(),
  title: text('the title').notNull(),
});
const schema = { entries, notes, tasks };
const NOTE = '11111111-1111-4111-8111-111111111111';
/** Longer than any field the authority keeps may hold. */
const LONG_TEXT = 'x'.repeat(3000);
const TIMEOUT_MS = 200;
const BUILD = 'b_where';
/** Long enough that only `poke()` reads the log in a test. */
const IDLE_POLL_MS = 60_000;
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;

/** A PGlite of the application's tables: `extra` runs once its tables and rows are there. */
async function opened(extra = '') {
  return openedWith(
    schema,
    `
    CREATE TABLE tasks (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      title text NOT NULL,
      done boolean NOT NULL,
      estimate integer NOT NULL,
      rank smallint NOT NULL,
      kind text NOT NULL
    );
    CREATE TABLE notes (id uuid PRIMARY KEY, body text NOT NULL);
    CREATE SCHEMA archive;
    CREATE TABLE archive."old entries" (id text PRIMARY KEY, "the title" text NOT NULL);
    INSERT INTO archive."old entries" VALUES ('e1', 'Kept');
    INSERT INTO tasks VALUES ('t1', 'p1', 'Write docs', true, 3, 2, 'bug');
    INSERT INTO tasks VALUES ('t2', 'p2', 'Ship it', false, 5, 1, 'chore');
    ${extra}
  `,
  );
}

type Opened = Awaited<ReturnType<typeof opened>>;
type Db = ReturnType<typeof followedDb<[Opened['follow']]>>;

/** An engine of one component whose states `states` makes: what a render of it shows of each. */
async function showing(
  setup: Pick<Following, 'store'> & Pick<Opened, 'follow'>,
  states: (db: Db) => Readonly<Record<string, unknown>>,
  options: ProgramOptions = {},
) {
  const db = followedDb(setup.follow);
  const evaluate = vi.fn((_props: Readonly<Record<string, Json>>, $: RenderScope) =>
    $.client({ props: {}, slots: {}, states: states(db) as never }),
  );
  const rendering = await engineOf(setup, evaluate, {}, options);
  return {
    ...rendering,
    evaluate,
    shown: async (): Promise<Readonly<Record<string, unknown>>> => {
      const { frame, tree } = await rendering.rendered();
      const { part } = clientOf(tree, COMPONENT);
      const values: Record<string, unknown> = {};
      for (const [key, state] of Object.entries<StateSource>(part.states)) {
        values[key] = 'field' in state ? frame.fields[state.field] : state.value;
      }
      return values;
    },
  };
}

/** The statements of the row's own reads `query`, a spy of the connection's, was asked. */
function rowReads(query: { readonly mock: { readonly calls: readonly unknown[][] } }) {
  return query.mock.calls.filter(([statement]) =>
    /^SELECT .* FROM "public"\./u.test(String(statement)),
  );
}

/** What `renderShared` answers of a route of a root that binds a row, `writable` or not. */
async function sharedAnswer(setup: Opened, writable: readonly string[]) {
  const db = followedDb(setup.follow);
  const root: ComponentProgram = {
    buildId: BUILD,
    component: COMPONENT,
    evaluate: (_props, $) => {
      const { title } = db.tasks.where(eq(tasks.id, 't1'));
      return $.client({ props: {}, slots: {}, states: { title } });
    },
    protocolVersion: PROTOCOL_VERSION,
    updaters: {},
    writable,
  };
  const engine = new Engine({
    buildId: BUILD,
    database: db,
    externalPollMs: IDLE_POLL_MS,
    programs: [root],
    routes: [
      {
        blocking: true,
        middleware: [],
        page: 'page.tsx',
        params: [],
        props: {},
        root: COMPONENT,
        route: '/',
        shared: true,
      },
    ],
  });
  onTestFinished(async () => {
    await engine.close();
  });
  await engine.poke();
  return engine.renderShared(null, { build: BUILD, props: {}, route: '/' });
}

/** A PGlite of `tasks`, its row `t1` titled `title`, followed as `followed` of the store `store`. */
async function databaseOf<S extends Readonly<Record<string, unknown>>>(
  followed: S,
  store: string,
  title: string,
) {
  const follow = followDrizzle(followed, { store }) as DrizzleFollow<S>;
  const pg = await PGlite.create();
  onTestFinished(async () => {
    await pg.close();
  });
  await pg.exec(`
    CREATE TABLE tasks (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      title text NOT NULL,
      done boolean NOT NULL,
      estimate integer NOT NULL,
      rank smallint NOT NULL,
      kind text NOT NULL
    );
    INSERT INTO tasks VALUES ('t1', 'p1', '${title}', false, 0, 0, 'bug');
  `);
  for (const statement of follow.captureSql()) {
    await pg.query(statement);
  }
  follow.client(pg);
  return { follow, pg };
}

describe('a state bound to a row of a followed table', () => {
  it(
    'shows what the row holds, of each type a state may hold',
    async () => {
      const setup = await opened();
      const { shown } = await showing(setup, (db) => {
        const row = db.tasks.where(eq(tasks.id, 't1'));
        return {
          done: row.done,
          estimate: row.estimate,
          kind: row.kind,
          local: 'as it starts',
          rank: row.rank,
          title: row.title,
        };
      });

      await expect(shown()).resolves.toStrictEqual({
        done: true,
        estimate: 3,
        kind: 'bug',
        local: 'as it starts',
        rank: 2,
        title: 'Write docs',
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reads a table of another schema, and columns the schema spells otherwise',
    async () => {
      const setup = await opened();
      const { shown } = await showing(setup, (db) => {
        const { title } = db.entries.where(eq(entries.id, 'e1'));
        return { title };
      });

      await expect(shown()).resolves.toStrictEqual({ title: 'Kept' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reads rows of one relation and one key of two databases apart',
    async () => {
      const first = await databaseOf({ firstTasks: tasks }, 'one', 'Of the first');
      const second = await databaseOf({ secondTasks: tasks }, 'two', 'Of the second');
      const db = followedDb(first.follow, second.follow);
      const component: ComponentProgram = {
        buildId: BUILD,
        component: COMPONENT,
        evaluate: (_props, $) => {
          const condition = eq(tasks.id, 't1');
          return $.client({
            props: {},
            slots: {},
            states: {
              first: db.firstTasks.where(condition).title,
              second: db.secondTasks.where(condition).title,
            },
          });
        },
        protocolVersion: PROTOCOL_VERSION,
        updaters: {},
        writable: [],
      };
      const engine = new Engine({
        buildId: BUILD,
        database: db,
        externalPollMs: IDLE_POLL_MS,
        programs: [component],
      });
      onTestFinished(async () => {
        await engine.close();
      });
      await engine.poke();
      const { sessionId } = await engine.login('alice');
      const root = { build: BUILD, component: COMPONENT, props: {} };
      const { frame } = await engine.render(sessionId, root);

      expect(
        Object.values(frame.fields).toSorted((one, other) =>
          String(one).localeCompare(String(other)),
        ),
      ).toStrictEqual(['Of the first', 'Of the second']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reads a row once for all its component binds of it, and each row by itself',
    async () => {
      const setup = await opened();
      const query = vi.spyOn(setup.pg, 'query');
      const { shown } = await showing(setup, (db) => {
        return {
          done: db.tasks.where(eq(tasks.id, 't1')).done,
          other: db.tasks.where(eq(tasks.id, 't2')).title,
          title: db.tasks.where(eq(tasks.id, 't1')).title,
        };
      });

      await expect(shown()).resolves.toStrictEqual({
        done: true,
        other: 'Ship it',
        title: 'Write docs',
      });
      expect(rowReads(query)).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the rendering, and runs no query, until something it read changes',
    async () => {
      const setup = await opened();
      const query = vi.spyOn(setup.pg, 'query');
      const { engine, evaluate, shown } = await showing(setup, (db) => {
        return {
          title: db.tasks.where(eq(tasks.id, 't1')).title,
        };
      });
      await shown();
      const reads = rowReads(query).length;

      await expect(shown()).resolves.toStrictEqual({ title: 'Write docs' });
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(rowReads(query)).toHaveLength(reads);

      await setup.orm.update(tasks).set({ title: 'Other' }).where(eq(tasks.id, 't2'));
      await engine.poke();
      await shown();

      expect(evaluate).toHaveBeenCalledTimes(1);

      await setup.orm.update(tasks).set({ title: 'Rewritten' }).where(eq(tasks.id, 't1'));
      await engine.poke();

      await expect(shown()).resolves.toStrictEqual({ title: 'Rewritten' });
      expect(evaluate).toHaveBeenCalledTimes(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows each type’s empty value where no row is there, and the row once it is',
    async () => {
      const setup = await opened();
      const { engine, shown } = await showing(setup, (db) => {
        const row = db.tasks.where(and(eq(tasks.id, 't1'), eq(tasks.projectId, 'p2')));
        return {
          done: row.done,
          estimate: row.estimate,
          note: db.notes.where(eq(notes.id, NOTE)).body,
          title: row.title,
        };
      });

      await expect(shown()).resolves.toStrictEqual({
        done: false,
        estimate: 0,
        note: '',
        title: '',
      });

      await setup.orm.insert(notes).values({ body: 'First', id: NOTE });
      await engine.poke();

      await expect(shown()).resolves.toMatchObject({ note: 'First' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'finds no row of a value the column could never hold, as a URL may name',
    async () => {
      const setup = await opened();
      const { shown } = await showing(setup, (db) => {
        return {
          body: db.notes.where(eq(notes.id, 'not-a-uuid')).body,
        };
      });

      await expect(shown()).resolves.toStrictEqual({ body: '' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows text longer than a write may give a field',
    async () => {
      const setup = await opened();
      await setup.orm.update(tasks).set({ title: LONG_TEXT }).where(eq(tasks.id, 't1'));
      const { shown } = await showing(setup, (db) => {
        return {
          title: db.tasks.where(eq(tasks.id, 't1')).title,
        };
      });

      await expect(shown()).resolves.toStrictEqual({ title: LONG_TEXT });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'follows a text key of a collation that finds two texts equal by every change of the table',
    async () => {
      const setup = await openedWith(
        { labels },
        `
        CREATE COLLATION folded (provider = icu, locale = '@colStrength=secondary', deterministic = false);
        CREATE TABLE labels (id text COLLATE folded PRIMARY KEY, title text NOT NULL);
        INSERT INTO labels VALUES ('P1', 'Launch');
      `,
      );
      const db = followedDb(setup.follow);
      const { engine, rendered } = await engineOf(setup, (_props, $) => {
        return $.client({
          props: {},
          slots: {},
          states: { title: db.labels.where(eq(labels.id, 'p1')).title },
        });
      });
      const shown = async () => Object.values((await rendered()).frame.fields);

      await expect(shown()).resolves.toStrictEqual(['Launch']);

      await setup.orm.update(labels).set({ title: 'Launched' }).where(eq(labels.id, 'P1'));
      await engine.poke();

      await expect(shown()).resolves.toStrictEqual(['Launched']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'follows a table whose rows a policy hides by every change of it',
    async () => {
      const setup = await opened(`
        CREATE ROLE app;
        GRANT USAGE ON SCHEMA public TO app;
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO app;
        ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
        CREATE POLICY seen ON tasks FOR SELECT TO app USING (project_id <> 'hidden');
      `);
      await setup.pg.exec(`
        GRANT USAGE ON SCHEMA reactive_state TO app;
        GRANT SELECT ON ALL TABLES IN SCHEMA reactive_state TO app;
        SET ROLE app;
      `);
      const { engine, evaluate, shown } = await showing(setup, (db) => {
        return {
          title: db.tasks.where(eq(tasks.id, 't1')).title,
        };
      });
      await shown();

      await setup.pg.exec(`
        RESET ROLE;
        UPDATE tasks SET estimate = 9 WHERE id = 't2';
        SET ROLE app;
      `);
      await engine.poke();
      await shown();

      expect(evaluate).toHaveBeenCalledTimes(2);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['no setter writes', []],
    ['a setter writes', ['title']],
  ])(
    'renders a state %s for the session, as a view of any query of the application’s',
    async (_, writable) => {
      const answer = await sharedAnswer(await opened(), writable);

      expect(answer.kind).toBe('session');
      expect(Object.values(answer.result.frame.fields)).toStrictEqual(['Write docs']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ends a read that does not answer within the call’s time, as a fault of the render',
    async () => {
      const setup = await opened();
      const query = setup.pg.query.bind(setup.pg);
      vi.spyOn(setup.pg, 'query').mockImplementation(async (statement, ...rest) => {
        return statement.startsWith('SELECT "title"')
          ? new Promise(() => {
              // A statement that holds a lock no one lets go of.
            })
          : query(statement, ...rest);
      });
      const { rendered } = await showing(
        setup,
        (db) => ({ title: db.tasks.where(eq(tasks.id, 't1')).title }),
        { timeoutMs: TIMEOUT_MS },
      );

      await expect(rendered()).rejects.toThrow('did not settle within');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is a fault of the render where `follow.client` was given no connection',
    async () => {
      const setup = await opened();
      const follow = followDrizzle(schema);
      // The log, read through a follow of the same tables given the connection, as this one is not.
      const store = () => storeThrough(followDrizzle(schema), setup.pg);
      const { rendered } = await showing({ follow, store }, (db) => {
        return {
          title: db.tasks.where(eq(tasks.id, 't1')).title,
        };
      });

      await expect(rendered()).rejects.toThrow('`follow.client`');
    },
    TEST_TIMEOUT_MS,
  );
});
