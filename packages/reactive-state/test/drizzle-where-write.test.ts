import { setTimeout as sleep } from 'node:timers/promises';

import { and, eq } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { RowChange } from '../src/authority/dependencies.ts';
import type { ExternalStore } from '../src/authority/external.ts';
import type { Json, ProgramUpdater, RenderScope, Value } from '../src/program.ts';
import { database, forbidden, table, text as textField } from '../src/server/index.ts';
import { followDrizzle, followedDb } from '../src/sql/index.ts';
import {
  COMPONENT,
  engineOf,
  type Following,
  openedWith,
  type ProgramOptions,
} from './support/drizzle.ts';
import { followInternals, ownStore } from './support/follow-store.ts';
import { clientOf } from './support/frames.ts';

/**
 * A setter of a state bound to a row writes the row, through the application's connection, once the
 * binding's path says the session may: the server part runs for each write, whatever the memo holds
 * and whatever the log has told, and the receipt commits at a revision whose frame shows the value.
 */

const members = pgTable(
  'members',
  { projectId: text('project_id').notNull(), userId: text('user_id').notNull() },
  (columns) => [primaryKey({ columns: [columns.projectId, columns.userId] })],
);
const tasks = pgTable('tasks', {
  id: text().primaryKey(),
  projectId: text('project_id').notNull(),
  title: text().notNull(),
  slug: text().notNull().unique(),
  done: boolean().notNull(),
  estimate: integer().notNull(),
  kind: text({ enum: ['bug', 'chore'] }).notNull(),
  owner: uuid().notNull(),
});
const schema = { members, tasks };
/** What makes `PAST_AN_INDEX`: CJK ideographs, one a stride apart. */
const STEPS = { first: 0x4e_00, span: 20_000, stride: 7919 } as const;
const OWNER = '11111111-1111-4111-8111-111111111111';
const NEXT_OWNER = '22222222-2222-4222-8222-222222222222';
const statuses = pgEnum('status', ['open', 'closed']);
/** A column of each type a compare-and-set compares otherwise. */
const issues = pgTable('issues', {
  id: text().primaryKey(),
  code: varchar({ length: 8 }).notNull(),
  label: text().notNull(),
  owner: uuid().notNull(),
  rank: smallint().notNull(),
  status: statuses().notNull(),
});
const MARK = 'u_mark';
/** A key of a type a condition's text may not hold. */
const keyedNotes = pgTable('notes', { id: uuid().primaryKey(), body: text().notNull() });
/** The table of `issues`, of a column the schema calls text and the database holds as an enum. */
const looseIssues = pgTable('issues', { id: text().primaryKey(), status: text().notNull() });
/** Text of three bytes a character, in no run a page of an index could compress. */
const PAST_AN_INDEX = Array.from({ length: 2000 }, (_, at) =>
  String.fromCodePoint(STEPS.first + ((at * STEPS.stride) % STEPS.span)),
).join('');
const SET = {
  done: 'u_done',
  estimate: 'u_estimate',
  kind: 'u_kind',
  owner: 'u_owner',
  slug: 'u_slug',
  title: 'u_title',
} as const;
const ADD_ESTIMATE = 'u_add';
const TOGGLE_DONE = 'u_toggle';
const TIMEOUT_MS = 200;
/** What `ROW_ATTEMPTS` lets an `apply` try, as `row-writes.ts` counts them. */
const ATTEMPTS = 3;
const TOO_MUCH = 2_147_483_648;
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;

const updaters: Readonly<Record<string, ProgramUpdater>> = {
  ...Object.fromEntries(
    Object.entries(SET).map(([key, updaterId]) => [updaterId, { keys: [key], kind: 'set' }]),
  ),
  [ADD_ESTIMATE]: {
    apply: (current: number, { step }: { readonly step: number }): number => current + step,
    keys: ['estimate'],
    kind: 'apply',
  },
  [TOGGLE_DONE]: {
    apply: (current: boolean): boolean => !current,
    keys: ['done'],
    kind: 'apply',
  },
};

/** A PGlite of the application's tables, with alice a member of the project of the row. */
async function opened() {
  return openedWith(
    schema,
    `
    CREATE TABLE members (project_id text NOT NULL, user_id text NOT NULL, PRIMARY KEY (project_id, user_id));
    CREATE TABLE tasks (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      title text NOT NULL CHECK (title <> 'refused'),
      slug text NOT NULL UNIQUE,
      done boolean NOT NULL,
      estimate integer NOT NULL,
      kind text NOT NULL,
      owner uuid NOT NULL
    );
    CREATE FUNCTION refused_title() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.title = 'raised' THEN RAISE EXCEPTION 'No such title'; END IF;
        RETURN NEW;
      END
    $$;
    CREATE TRIGGER tasks_refused_title BEFORE UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION refused_title();
    INSERT INTO members VALUES ('p1', 'alice');
    INSERT INTO tasks VALUES ('t1', 'p1', 'Write docs', 'first', false, 3, 'bug', '${OWNER}');
  `,
  );
}

type Opened = Awaited<ReturnType<typeof opened>>;

/** The row of `id` as a component binds it, of the project `p1`, for alice alone. */
async function editing(
  setup: Pick<Following, 'store'> & Pick<Opened, 'follow' | 'orm' | 'pg'>,
  options: ProgramOptions & { readonly row?: () => string } = {},
) {
  const { orm } = setup;
  const db = followedDb(setup.follow);
  const evaluate = vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
    const access = await orm
      .select({ userId: members.userId })
      .from(members)
      .where(and(eq(members.projectId, 'p1'), eq(members.userId, 'alice')));
    if (access.length === 0) forbidden();
    const id = options.row?.() ?? 't1';
    const row = db.tasks.where(and(eq(tasks.id, id), eq(tasks.projectId, 'p1')));
    return $.client({
      props: {},
      slots: {},
      states: {
        done: row.done,
        estimate: row.estimate,
        kind: row.kind,
        owner: row.owner,
        slug: row.slug,
        title: row.title,
      },
    });
  });
  const rendering = await engineOf(
    setup,
    evaluate,
    {},
    { updaters, writable: Object.keys(SET), ...options },
  );
  const { engine, rendered, session } = rendering;
  const part = async () => clientOf((await rendered()).tree, COMPONENT).part;
  /** The binding and the key of the frame's field of the state `key`, as a render issues them. */
  const stateOf = async (key: keyof typeof SET) => {
    const state = (await part()).states[key];
    if (state === undefined || !('field' in state) || state.binding === undefined) {
      throw new Error(`${key} is no state a setter writes.`);
    }
    return { binding: state.binding, field: state.field };
  };
  return {
    ...rendering,
    evaluate,
    part,
    stateOf,
    /** What a page's setter of the state `key` sends, as the render it holds binds it. */
    write: async (
      key: keyof typeof SET,
      value: unknown,
      operationId: string = crypto.randomUUID(),
    ) => {
      const { binding } = await stateOf(key);
      return engine.update(session, { binding, operationId, updaterId: SET[key], value });
    },
    /** What a page's `setDone((done) => !done)` sends. */
    toggle: async () => {
      const { binding } = await stateOf('done');
      const operationId = crypto.randomUUID();
      return engine.update(session, { binding, operationId, updaterId: TOGGLE_DONE });
    },
    /** What a page's `setEstimate((current) => current + step)` sends. */
    add: async (step: number, operationId: string = crypto.randomUUID()) => {
      const { binding } = await stateOf('estimate');
      return engine.update(session, {
        binding,
        captures: { step },
        operationId,
        updaterId: ADD_ESTIMATE,
      });
    },
  };
}

/** What the row `id` holds, read by the test alone. */
async function rowOf({ pg }: Pick<Opened, 'pg'>, id = 't1') {
  const { rows } = await pg.query<Record<string, unknown>>('SELECT * FROM tasks WHERE id = $1', [
    id,
  ]);
  return rows[0];
}

/** Runs `before` first, once a `times` of the row's own writes, as another writer gets in first. */
function racing({ pg }: Pick<Opened, 'pg'>, times: number, before: () => Promise<unknown>) {
  const query = pg.query.bind(pg);
  let left = times;
  return vi.spyOn(pg, 'query').mockImplementation(async (statement, ...rest) => {
    if (statement.startsWith('UPDATE "public".') && left > 0) {
      left -= 1;
      await before();
    }
    return query(statement, ...rest);
  });
}

/** The store of `setup`'s log, of the follow's own, which answers no read once `hold` is called. */
function heldLog(setup: Opened) {
  const { promise: released, resolve: release } = Promise.withResolvers<undefined>();
  let held = false;
  onTestFinished(() => {
    release(undefined);
  });
  const store = (): ExternalStore => {
    const own = ownStore(setup.follow);
    return {
      ...own,
      changes: async (...args) => {
        if (held) await released;
        return own.changes(...args);
      },
    };
  };
  return {
    hold: () => {
      held = true;
    },
    store,
  };
}

/** `setup` of a store whose log's reads `changes` counts, of the follow's own. */
function counted(setup: Opened, changes: () => void) {
  const store = (): ExternalStore => {
    const own = ownStore(setup.follow);
    return {
      ...own,
      changes: async (...args) => {
        changes();
        return own.changes(...args);
      },
    };
  };
  return { ...setup, store };
}

/** A PGlite of one issue, its `label` of the collation `collation`, where one is given. */
async function issueOpened(collation = '') {
  return openedWith(
    { issues },
    `
    CREATE COLLATION folded (provider = icu, locale = '@colStrength=secondary', deterministic = false);
    CREATE TYPE status AS ENUM ('open', 'closed');
    CREATE TABLE issues (
      id text PRIMARY KEY,
      code varchar(8) NOT NULL,
      label text ${collation} NOT NULL,
      owner uuid NOT NULL,
      rank smallint NOT NULL,
      status status NOT NULL
    );
    INSERT INTO issues VALUES ('i1', 'a', 'A', '${OWNER}', 1, 'open');
  `,
  );
}

/** Applies `apply` to the column `key` of the issue, as a page's updater of it sends. */
async function applied(
  setup: Awaited<ReturnType<typeof issueOpened>>,
  key: 'code' | 'label' | 'owner' | 'rank' | 'status',
  apply: (current: never) => Value,
) {
  const db = followedDb(setup.follow);
  const { engine, rendered, session } = await engineOf(
    setup,
    (_props, $) => {
      const row = db.issues.where(eq(issues.id, 'i1'));
      return $.client({ props: {}, slots: {}, states: { [key]: row[key] } });
    },
    {},
    { updaters: { [MARK]: { apply, keys: [key], kind: 'apply' } }, writable: [key] },
  );
  const state = clientOf((await rendered()).tree, COMPONENT).part.states[key];
  const binding = state !== undefined && 'binding' in state ? state.binding : undefined;
  return async () => {
    const operationId = crypto.randomUUID();
    return engine.update(session, { binding, operationId, updaterId: MARK });
  };
}

describe('a write to a state bound to a row', () => {
  it(
    'writes the row, and the next render shows it and the operation',
    async () => {
      const setup = await opened();
      const { rendered, stateOf, write } = await editing(setup);
      const { field } = await stateOf('title');

      const receipt = await write('title', 'Rewritten', 'op-title');
      const { frame } = await rendered();

      expect(receipt).toMatchObject({ deduplicated: false, operationId: 'op-title' });
      await expect(rowOf(setup)).resolves.toMatchObject({ title: 'Rewritten' });
      expect(frame.fields[field]).toBe('Rewritten');
      expect(frame.operations).toContain('op-title');
      expect(frame.revision).toBeGreaterThanOrEqual(receipt.committedRevision);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'writes a value of each type a state may hold',
    async () => {
      const setup = await opened();
      const { write } = await editing(setup);

      await write('done', true);
      await write('estimate', 8);
      await write('kind', 'chore');
      await write('owner', '22222222-2222-4222-8222-222222222222');

      await expect(rowOf(setup)).resolves.toMatchObject({
        done: true,
        estimate: 8,
        kind: 'chore',
        owner: '22222222-2222-4222-8222-222222222222',
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs the server part again for the write, and refuses what it refuses now, though no log told of it',
    async () => {
      const setup = await opened();
      const { evaluate, stateOf, engine, session } = await editing(setup);
      const { binding } = await stateOf('title');
      const before = evaluate.mock.calls.length;

      await setup.pg.query("DELETE FROM members WHERE user_id = 'alice'");

      await expect(
        engine.update(session, {
          binding,
          operationId: 'op-revoked',
          updaterId: SET.title,
          value: 'Not mine',
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(evaluate.mock.calls.length).toBeGreaterThan(before);
      await expect(rowOf(setup)).resolves.toMatchObject({ title: 'Write docs' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the value at the receipt’s revision, though the log never answers',
    async () => {
      const setup = await opened();
      const log = heldLog(setup);
      const { rendered, stateOf, write } = await editing({ ...setup, store: log.store });
      const { field } = await stateOf('title');
      log.hold();

      const receipt = await write('title', 'Rewritten');
      const { frame } = await rendered();

      expect(frame.revision).toBeGreaterThanOrEqual(receipt.committedRevision);
      expect(frame.fields[field]).toBe('Rewritten');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reads the log before it answers, for what read the row by other keys',
    async () => {
      const setup = await opened();
      const { engine, write } = await editing(setup);
      const rows: RowChange[] = [];
      engine.onCommit((event) => {
        rows.push(...event.rows);
      });

      await write('title', 'Rewritten');

      // The receipt's row holds what the condition names; the log's, each key of the table.
      expect(rows.some((row) => row.after !== null && 'k_slug' in row.after)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reads no log after a write to a record the authority keeps, as it did not before',
    async () => {
      const setup = await opened();
      const changes = vi.fn();
      const notes = table({ title: textField() });
      // No public form mixes the two: declared of the follow's tables, and given its store.
      const db = database(
        { ...followInternals(setup.follow).tables, notes },
        { seed: { notes: { n1: { title: 'Kept' } } } },
      );
      const { engine, rendered, session } = await engineOf(
        counted(setup, changes),
        (_props, $) =>
          $.client({ props: {}, slots: {}, states: { title: db.notes.ref('n1').title } }),
        {},
        {
          database: db,
          updaters: { [SET.title]: { keys: ['title'], kind: 'set' } },
          writable: ['title'],
        },
      );
      const { title } = clientOf((await rendered()).tree, COMPONENT).part.states;
      const reads = changes.mock.calls.length;

      expect(reads).toBeGreaterThan(0);

      await engine.update(session, {
        binding: title !== undefined && 'binding' in title ? title.binding : undefined,
        operationId: 'op-note',
        updaterId: SET.title,
        value: 'Rewritten',
      });

      expect(changes).toHaveBeenCalledTimes(reads);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'computes an `apply` from what the row holds, in the database, not in the rendering',
    async () => {
      const setup = await opened();
      const { add, stateOf } = await editing(setup);
      await stateOf('estimate');
      await setup.pg.query("UPDATE tasks SET estimate = 10 WHERE id = 't1'");

      await add(2);

      await expect(rowOf(setup)).resolves.toMatchObject({ estimate: 12 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'computes an `apply` of a boolean, held to what it read as an integer’s is',
    async () => {
      const setup = await opened();
      const { toggle } = await editing(setup);

      await toggle();

      await expect(rowOf(setup)).resolves.toMatchObject({ done: true });

      await toggle();

      await expect(rowOf(setup)).resolves.toMatchObject({ done: false });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'computes an `apply` again from what another writer left between its read and its write',
    async () => {
      const setup = await opened();
      const { add } = await editing(setup);
      const query = setup.pg.query.bind(setup.pg);
      racing(setup, 1, async () => query("UPDATE tasks SET estimate = 10 WHERE id = 't1'"));

      await add(2);

      await expect(rowOf(setup)).resolves.toMatchObject({ estimate: 12 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'tells text apart in an `apply` that the column’s collation finds equal',
    async () => {
      const setup = await issueOpened('COLLATE folded');
      const send = await applied(setup, 'label', (current: string) => `${current}!`);
      const query = setup.pg.query.bind(setup.pg);
      racing(setup, 1, async () => query("UPDATE issues SET label = 'a' WHERE id = 'i1'"));

      await send();

      const { rows } = await query<{ label: string }>('SELECT label FROM issues');

      expect(rows).toStrictEqual([{ label: 'a!' }]);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['varchar', 'code', (current: string) => `${current}b`, 'ab'],
    ['text', 'label', (current: string) => `${current}!`, 'A!'],
    ['a UUID', 'owner', () => NEXT_OWNER, NEXT_OWNER],
    ['smallint', 'rank', (current: number) => current + 1, 2],
    ['an enum', 'status', () => 'closed', 'closed'],
  ] as const)(
    'holds an `apply` of %s to what it read',
    async (_, key, apply, written) => {
      const setup = await issueOpened();
      const send = await applied(setup, key, apply);

      await send();

      const { rows } = await setup.pg.query<Record<string, unknown>>('SELECT * FROM issues');

      expect(rows[0]?.[key]).toBe(written);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses an `apply` of a row that goes on changing under it, of this operation alone',
    async () => {
      const setup = await opened();
      const { add } = await editing(setup);
      const query = setup.pg.query.bind(setup.pg);
      const raced = racing(setup, ATTEMPTS, async () =>
        query("UPDATE tasks SET estimate = estimate + 100 WHERE id = 't1'"),
      );

      await expect(add(2)).rejects.toMatchObject({ code: 'ROW_CHANGED', status: 409 });

      raced.mockRestore();

      await expect(rowOf(setup)).resolves.toMatchObject({ estimate: 303 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers a resend with its first receipt, writing once',
    async () => {
      const setup = await opened();
      const { add, write } = await editing(setup);

      const first = await add(5, 'op-add');
      const again = await add(5, 'op-add');

      expect(again).toStrictEqual({ ...first, deduplicated: true });
      await expect(rowOf(setup)).resolves.toMatchObject({ estimate: 8 });
      await expect(add(1, 'op-add')).rejects.toMatchObject({
        code: 'OPERATION_REUSED',
        status: 409,
      });
      await expect(write('title', 'Other', 'op-add')).rejects.toMatchObject({
        code: 'OPERATION_REUSED',
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'commits an `apply` that changes nothing without writing the row',
    async () => {
      const setup = await opened();
      const { add, rendered } = await editing(setup);
      const query = vi.spyOn(setup.pg, 'query');

      const receipt = await add(0, 'op-same');
      const { frame } = await rendered();

      expect(query.mock.calls.filter(([sent]) => sent.startsWith('UPDATE'))).toHaveLength(0);
      expect(receipt).toMatchObject({ deduplicated: false });
      expect(frame.operations).toContain('op-same');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders again what read the row of an `apply` that changes nothing, though the log never answers',
    async () => {
      const setup = await opened();
      const log = heldLog(setup);
      const { add, rendered, stateOf } = await editing({ ...setup, store: log.store });
      const { field } = await stateOf('estimate');
      log.hold();
      await setup.pg.query("UPDATE tasks SET estimate = 7 WHERE id = 't1'");

      const receipt = await add(0);
      const { frame } = await rendered();

      expect(frame.revision).toBeGreaterThanOrEqual(receipt.committedRevision);
      expect(frame.fields[field]).toBe(7);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a write to a row no longer of the condition, as to a row deleted, and writes neither',
    async () => {
      const setup = await opened();
      const { add, write } = await editing(setup);
      await setup.pg.query("UPDATE tasks SET project_id = 'p2' WHERE id = 't1'");

      await expect(write('title', 'Moved')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
      await expect(add(1)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      await expect(rowOf(setup)).resolves.toMatchObject({ estimate: 3, title: 'Write docs' });

      await setup.pg.query("DELETE FROM tasks WHERE id = 't1'");

      await expect(write('title', 'Gone')).rejects.toMatchObject({ status: 404 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a write under a binding of a row the component binds no more',
    async () => {
      const setup = await opened();
      await setup.pg.query(
        `INSERT INTO tasks VALUES ('t2', 'p1', 'Other', 'second', false, 1, 'bug', '${OWNER}')`,
      );
      let row = 't1';
      const { engine, session, stateOf } = await editing(setup, { row: () => row });
      const { binding } = await stateOf('title');
      row = 't2';

      await expect(
        engine.update(session, {
          binding,
          operationId: 'op-moved',
          updaterId: SET.title,
          value: 'Moved',
        }),
      ).rejects.toMatchObject({ code: 'TARGET_CHANGED', status: 409 });
      await expect(rowOf(setup)).resolves.toMatchObject({ title: 'Write docs' });
      await expect(rowOf(setup, 't2')).resolves.toMatchObject({ title: 'Other' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a value a unique key holds elsewhere, of this operation alone',
    async () => {
      const setup = await opened();
      await setup.pg.query(
        `INSERT INTO tasks VALUES ('t2', 'p1', 'Other', 'second', false, 1, 'bug', '${OWNER}')`,
      );
      const { write } = await editing(setup);

      await expect(write('slug', 'second')).rejects.toMatchObject({
        code: 'UNIQUE_VIOLATION',
        status: 409,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['a value the database’s check refuses', 'title', 'refused'],
    ['a value a trigger of the database raises of', 'title', 'raised'],
    ['a value past what a unique index holds', 'slug', PAST_AN_INDEX],
    ['a label the schema does not list', 'kind', 'feature'],
    ['a value of another type', 'title', 3],
    ['a number for a boolean', 'done', 1],
    ['a number past the column', 'estimate', TOO_MUCH],
    ['a fraction', 'estimate', 1.5],
    ['text no UUID is', 'owner', 'not-a-uuid'],
    ['text PostgreSQL cannot hold', 'title', 'a\0b'],
  ] as const)(
    'refuses %s',
    async (_, key, value) => {
      const setup = await opened();
      const { write } = await editing(setup);
      const before = await rowOf(setup);

      await expect(write(key, value)).rejects.toMatchObject({
        code: 'INVALID_VALUE',
        status: 422,
      });
      await expect(rowOf(setup)).resolves.toStrictEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'writes nothing of an `apply` whose read answers after the call’s time',
    async () => {
      const setup = await opened();
      const { add } = await editing(setup, { timeoutMs: TIMEOUT_MS });
      const query = setup.pg.query.bind(setup.pg);
      const { promise: released, resolve: release } = Promise.withResolvers<undefined>();
      const spied = vi.spyOn(setup.pg, 'query').mockImplementation(async (statement, ...rest) => {
        if (statement.startsWith('SELECT "estimate"')) await released;
        return query(statement, ...rest);
      });

      await expect(add(1)).rejects.toThrow('did not settle within');

      release(undefined);
      await query('SELECT 1');
      await sleep(TIMEOUT_MS);

      expect(spied.mock.calls.filter(([sent]) => sent.startsWith('UPDATE'))).toHaveLength(0);
      await expect(rowOf(setup)).resolves.toMatchObject({ estimate: 3 });
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['the database’s policy refuses', 'title', 'barred'],
    ['the role has no right to', 'done', true],
  ] as const)(
    'refuses a write %s, as the session’s, of this binding',
    async (_, key, value) => {
      const setup = await opened();
      const { write, stateOf } = await editing(setup);
      await stateOf(key);
      await setup.pg.exec(`
        CREATE ROLE app;
        GRANT USAGE ON SCHEMA public, reactive_state TO app;
        GRANT SELECT ON ALL TABLES IN SCHEMA public, reactive_state TO app;
        GRANT UPDATE (title) ON tasks TO app;
        ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
        CREATE POLICY seen ON tasks FOR SELECT USING (true);
        CREATE POLICY kept ON tasks FOR UPDATE USING (true) WITH CHECK (title <> 'barred');
        SET ROLE app;
      `);

      await expect(write(key, value)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

      await setup.pg.exec('RESET ROLE');

      await expect(rowOf(setup)).resolves.toMatchObject({ done: false, title: 'Write docs' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'finds no row of a condition no row could hold, of a `set` as of an `apply`',
    async () => {
      const setup = await openedWith(
        { notes: keyedNotes },
        'CREATE TABLE notes (id uuid PRIMARY KEY, body text NOT NULL);',
      );
      const db = followedDb(setup.follow);
      const { engine, rendered, session } = await engineOf(
        setup,
        (_props, $) => {
          const { body } = db.notes.where(eq(keyedNotes.id, 'not-a-uuid'));
          return $.client({ props: {}, slots: {}, states: { body } });
        },
        {},
        {
          updaters: {
            [MARK]: { apply: (current: string) => `${current}!`, keys: ['body'], kind: 'apply' },
            [SET.title]: { keys: ['body'], kind: 'set' },
          },
          writable: ['body'],
        },
      );
      const { body } = clientOf((await rendered()).tree, COMPONENT).part.states;
      const binding = body !== undefined && 'binding' in body ? body.binding : undefined;
      const sent = { binding, operationId: 'op-none' };

      await expect(
        engine.update(session, { ...sent, updaterId: SET.title, value: 'Written' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      await expect(engine.update(session, { ...sent, updaterId: MARK })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'holds an `apply` to what it read of a column the schema calls text and the database does not',
    async () => {
      const setup = await issueOpened();
      const follow = followDrizzle({ issues: looseIssues });
      follow.client(setup.pg);
      const db = followedDb(follow);
      const { engine, rendered, session } = await engineOf(
        { follow },
        (_props, $) => {
          const { status } = db.issues.where(eq(looseIssues.id, 'i1'));
          return $.client({ props: {}, slots: {}, states: { status } });
        },
        {},
        {
          updaters: { [MARK]: { apply: () => 'closed', keys: ['status'], kind: 'apply' } },
          writable: ['status'],
        },
      );
      const { status } = clientOf((await rendered()).tree, COMPONENT).part.states;

      await engine.update(session, {
        binding: status !== undefined && 'binding' in status ? status.binding : undefined,
        operationId: 'op-loose',
        updaterId: MARK,
      });

      const { rows } = await setup.pg.query<{ status: string }>('SELECT status FROM issues');

      expect(rows).toStrictEqual([{ status: 'closed' }]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ends a write that does not answer within the call’s time, and the queue goes on',
    async () => {
      const setup = await opened();
      const { rendered, write } = await editing(setup, { timeoutMs: TIMEOUT_MS });
      const query = setup.pg.query.bind(setup.pg);
      const hung = vi.spyOn(setup.pg, 'query').mockImplementation(async (statement, ...rest) => {
        return statement.startsWith('UPDATE "public"."tasks"')
          ? new Promise(() => {
              // A statement that waits on a lock no one lets go of.
            })
          : query(statement, ...rest);
      });

      await expect(write('title', 'Never')).rejects.toThrow('did not settle within');

      hung.mockRestore();

      await expect(rendered()).resolves.toMatchObject({ status: 'rendered' });
    },
    TEST_TIMEOUT_MS,
  );
});
