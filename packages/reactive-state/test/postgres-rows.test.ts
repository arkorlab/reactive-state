import { setTimeout as sleep } from 'node:timers/promises';

import { and, eq } from 'drizzle-orm';
import { boolean, integer, pgEnum, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import type { PoolConfig } from 'pg';
import { describe, expect, it, onTestFinished } from 'vitest';

import { Engine } from '../src/authority/node-engine.ts';
import { type ComponentProgram, PROTOCOL_VERSION, type ProgramUpdater } from '../src/program.ts';
import { database } from '../src/server/index.ts';
import { followDrizzle } from '../src/sql/index.ts';
import { clientOf as frameClientOf } from './support/frames.ts';
import { clientOf, databaseOf, poolOf, SERVER_TIMEOUT_MS, SERVER_URL } from './support/postgres.ts';

/**
 * A state bound to a row, written through a `pg.Pool` on a real server: what a lock, a deadlock, an
 * isolation level, a role and a policy do to a setter, which a PGlite of one session cannot show.
 */

const BUILD = 'b_postgres';
const COMPONENT = 'components/postgres';
const OWNER = '11111111-1111-4111-8111-111111111111';
const NEXT_OWNER = '22222222-2222-4222-8222-222222222222';
/** How long a write may run before its call's time ends, of the tests that outlast it. */
const CALL_MS = 600;
/** What a test leaves a statement to reach its lock, and one past its call to land. */
const LANDED_MS = 400;
/** Text past what an index's page holds: CJK ideographs, one a stride apart. */
const STEPS = { first: 0x4e_00, length: 2000, span: 20_000, stride: 7919 } as const;

const statuses = pgEnum('status', ['open', 'closed']);
const tasks = pgTable('tasks', {
  id: text().primaryKey(),
  projectId: text('project_id').notNull(),
  title: text().notNull(),
  slug: text().notNull().unique(),
  estimate: integer().notNull(),
  done: boolean().notNull(),
  status: statuses().notNull(),
  owner: uuid().notNull(),
  rank: smallint().notNull(),
  label: text().notNull(),
});
const schema = { tasks };
const updaters: Readonly<Record<string, ProgramUpdater>> = {
  add: {
    apply: (current: number, { step }: { readonly step: number }) => current + step,
    keys: ['estimate'],
    kind: 'apply',
  },
  bang: { apply: (current: string) => `${current}!`, keys: ['label'], kind: 'apply' },
  flip: {
    apply: (current: string) => (current === 'open' ? 'closed' : 'open'),
    keys: ['status'],
    kind: 'apply',
  },
  rank: { apply: (current: number) => current + 1, keys: ['rank'], kind: 'apply' },
  setOwner: { keys: ['owner'], kind: 'set' },
  setSlug: { keys: ['slug'], kind: 'set' },
  setTitle: { keys: ['title'], kind: 'set' },
  toggle: { apply: (current: boolean) => !current, keys: ['done'], kind: 'apply' },
};
const KEYS = ['done', 'estimate', 'label', 'owner', 'rank', 'slug', 'status', 'title'] as const;

/** The roles of the tests of rights, of the server, which each database grants its own. */
const ROLES = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reactive_reader') THEN CREATE ROLE reactive_reader LOGIN; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reactive_writer') THEN CREATE ROLE reactive_writer LOGIN; END IF;
  END $$;
  GRANT USAGE ON SCHEMA public, reactive_state TO reactive_reader, reactive_writer;
  GRANT SELECT ON ALL TABLES IN SCHEMA public, reactive_state TO reactive_reader, reactive_writer;
  GRANT UPDATE ON tasks TO reactive_writer;
`;

/** What a test gives its database and the application's pool. */
interface Options {
  readonly collation?: boolean;
  readonly pool?: PoolConfig;
  readonly setup?: string;
  readonly timeoutMs?: number;
}

/** A database of the tasks, an engine of a component that binds a row, through a pool of it. */
async function opened(options: Options = {}) {
  const folded = options.collation === true;
  const { name, owner } = await databaseOf(`
    ${folded ? "CREATE COLLATION folded (provider = icu, locale = '@colStrength=secondary', deterministic = false);" : ''}
    CREATE TYPE status AS ENUM ('open', 'closed');
    CREATE TABLE tasks (
      id text PRIMARY KEY, project_id text NOT NULL, title text NOT NULL CHECK (title <> 'refused'),
      slug text NOT NULL UNIQUE, estimate integer NOT NULL, done boolean NOT NULL,
      status status NOT NULL, owner uuid NOT NULL, rank smallint NOT NULL,
      label text ${folded ? 'COLLATE folded' : ''} NOT NULL
    );
    INSERT INTO tasks VALUES ('t1', 'p1', 'Write docs', 'one', 3, false, 'open', '${OWNER}', 1, 'A');
    INSERT INTO tasks VALUES ('t2', 'p1', 'Ship it', 'two', 5, false, 'open', '${OWNER}', 2, 'B');
  `);
  const follow = followDrizzle(schema);
  for (const statement of follow.captureSql()) await owner.query(statement);
  if (options.setup !== undefined) await owner.query(options.setup);
  follow.client(poolOf(name, { max: 6, ...options.pool }));
  const db = database(follow.tables);
  const evaluations = { count: 0 };
  const component: ComponentProgram = {
    buildId: BUILD,
    component: COMPONENT,
    evaluate: (_props, $) => {
      evaluations.count += 1;
      const row = db.tasks.where(and(eq(tasks.id, 't1'), eq(tasks.projectId, 'p1')));
      const states = Object.fromEntries(KEYS.map((key) => [key, row[key]]));
      return $.client({ props: {}, slots: {}, states: states as never });
    },
    protocolVersion: PROTOCOL_VERSION,
    updaters,
    writable: [...KEYS],
  };
  const engine = new Engine({
    buildId: BUILD,
    database: db,
    externalPollMs: 60_000,
    programs: [component],
    stores: { sql: follow.store(await clientOf(name)) },
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
  });
  onTestFinished(async () => {
    await engine.close();
  });
  await engine.poke();
  const { sessionId: session } = await engine.login('alice');
  const root = { build: BUILD, component: COMPONENT, props: {} };
  const rendered = async () => engine.render(session, root);
  const bindingOf = async (key: (typeof KEYS)[number]) => {
    const state = frameClientOf((await rendered()).tree, COMPONENT).part.states[key];
    return state !== undefined && 'binding' in state ? state.binding : undefined;
  };
  return {
    bindingOf,
    engine,
    evaluations,
    /** What a render's frame holds of each state. */
    fields: async () => {
      const { frame, tree } = await rendered();
      const { states } = frameClientOf(tree, COMPONENT).part;
      return Object.fromEntries(
        KEYS.map((key) => {
          const state = states[key];
          return [key, state !== undefined && 'field' in state ? frame.fields[state.field] : null];
        }),
      );
    },
    other: await clientOf(name),
    owner,
    rendered,
    /** What the row holds, read by the test alone. */
    row: async () => {
      const { rows } = await owner.query<Readonly<Record<string, unknown>>>(
        "SELECT * FROM tasks WHERE id = 't1'",
      );
      return rows[0];
    },
    session,
    /** What a page's setter of `key` sends, by the updater `updaterId`. */
    write: async (
      key: (typeof KEYS)[number],
      updaterId: string,
      sent: Readonly<Record<string, unknown>>,
    ) => {
      return engine.update(session, {
        binding: await bindingOf(key),
        operationId: crypto.randomUUID(),
        updaterId,
        ...sent,
      });
    },
  };
}

describe.skipIf(SERVER_URL === undefined)('a state bound to a row, through a pool', () => {
  it(
    'reads and writes a column of each type',
    async () => {
      const setup = await opened();
      const written = {
        done: true,
        estimate: 7,
        label: 'A!',
        owner: NEXT_OWNER,
        rank: 2,
        status: 'closed',
        title: 'Rewritten',
      };

      await setup.write('title', 'setTitle', { value: 'Rewritten' });
      await setup.write('owner', 'setOwner', { value: NEXT_OWNER });
      await setup.write('estimate', 'add', { captures: { step: 4 } });
      await setup.write('done', 'toggle', {});
      await setup.write('status', 'flip', {});
      await setup.write('rank', 'rank', {});
      await setup.write('label', 'bang', {});

      await expect(setup.fields()).resolves.toMatchObject(written);
      await expect(setup.row()).resolves.toMatchObject(written);
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'renders nothing again of another row, and again of its own',
    async () => {
      const setup = await opened();
      await setup.rendered();
      const before = setup.evaluations.count;

      await setup.owner.query("UPDATE tasks SET title = 'Other' WHERE id = 't2'");
      await setup.engine.poke();
      await setup.rendered();

      expect(setup.evaluations.count).toBe(before);

      await setup.owner.query("UPDATE tasks SET title = 'Own' WHERE id = 't1'");
      await setup.engine.poke();

      await expect(setup.fields()).resolves.toMatchObject({ title: 'Own' });
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'computes an apply again of what the transaction it waited on committed',
    async () => {
      const setup = await opened();
      const binding = await setup.bindingOf('estimate');
      await setup.other.query('BEGIN');
      await setup.other.query("UPDATE tasks SET estimate = 10 WHERE id = 't1'");
      const sending = setup.engine.update(setup.session, {
        binding,
        captures: { step: 2 },
        operationId: 'waits',
        updaterId: 'add',
      });
      await sleep(LANDED_MS);

      await setup.other.query('COMMIT');
      await sending;

      await expect(setup.row()).resolves.toMatchObject({ estimate: 12 });
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'writes what it read under a lock the other rolls back',
    async () => {
      const setup = await opened();
      const binding = await setup.bindingOf('estimate');
      await setup.other.query('BEGIN');
      await setup.other.query("UPDATE tasks SET estimate = 10 WHERE id = 't1'");
      const sending = setup.engine.update(setup.session, {
        binding,
        captures: { step: 2 },
        operationId: 'rolled',
        updaterId: 'add',
      });
      await sleep(LANDED_MS);

      await setup.other.query('ROLLBACK');
      await sending;

      await expect(setup.row()).resolves.toMatchObject({ estimate: 5 });
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'faults a set past its call, whose statement lands once the lock goes, and renders meanwhile',
    async () => {
      const setup = await opened({ timeoutMs: CALL_MS });
      const binding = await setup.bindingOf('title');
      await setup.other.query('BEGIN');
      await setup.other.query("UPDATE tasks SET title = 'Held' WHERE id = 't1'");

      await expect(
        setup.engine.update(setup.session, {
          binding,
          operationId: 'late',
          updaterId: 'setTitle',
          value: 'Late',
        }),
      ).rejects.toThrow('did not settle within');
      await expect(setup.rendered()).resolves.toBeDefined();

      await setup.other.query('COMMIT');
      await sleep(LANDED_MS);

      await expect(setup.row()).resolves.toMatchObject({ title: 'Late' });
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    "faults past the pool's `lock_timeout`, and the resend writes",
    async () => {
      const setup = await opened({ pool: { options: '-c lock_timeout=200' } });
      const sent = {
        binding: await setup.bindingOf('title'),
        operationId: 'timed',
        updaterId: 'setTitle',
        value: 'Mine',
      };
      await setup.other.query('BEGIN');
      await setup.other.query("UPDATE tasks SET title = 'Held' WHERE id = 't1'");

      await expect(setup.engine.update(setup.session, sent)).rejects.toMatchObject({
        code: '55P03',
      });

      await setup.other.query('COMMIT');
      await setup.engine.update(setup.session, sent);

      await expect(setup.row()).resolves.toMatchObject({ title: 'Mine' });
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'faults a concurrent update at SERIALIZABLE, and the resend writes',
    async () => {
      const setup = await opened({
        pool: { options: '-c default_transaction_isolation=serializable' },
      });
      const sent = {
        binding: await setup.bindingOf('estimate'),
        captures: { step: 2 },
        operationId: 'serial',
        updaterId: 'add',
      };
      await setup.other.query('BEGIN');
      await setup.other.query("UPDATE tasks SET estimate = 10 WHERE id = 't1'");
      const sending = setup.engine.update(setup.session, sent);
      await sleep(LANDED_MS);

      await setup.other.query('COMMIT');

      // The serialization failure, not any other, which the resend then recovers from.
      await expect(sending).rejects.toMatchObject({ code: '40001' });

      await setup.engine.update(setup.session, sent);

      await expect(setup.row()).resolves.toMatchObject({ estimate: 12 });
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'says what the database refuses of a value',
    async () => {
      const setup = await opened();
      await setup.owner.query(
        `INSERT INTO tasks VALUES ('t3', 'p1', 'Third', 'taken', 1, false, 'open', '${OWNER}', 3, 'C')`,
      );

      await expect(setup.write('slug', 'setSlug', { value: 'taken' })).rejects.toMatchObject({
        code: 'UNIQUE_VIOLATION',
      });
      await expect(setup.write('title', 'setTitle', { value: 'refused' })).rejects.toMatchObject({
        code: 'INVALID_VALUE',
      });
      await expect(setup.write('owner', 'setOwner', { value: 'no-uuid' })).rejects.toMatchObject({
        code: 'INVALID_VALUE',
      });
      await expect(setup.write('title', 'setTitle', { value: 'a\0b' })).rejects.toMatchObject({
        code: 'INVALID_VALUE',
      });
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'tells text apart under a nondeterministic collation',
    async () => {
      const setup = await opened({ collation: true });
      const binding = await setup.bindingOf('label');
      await setup.other.query('BEGIN');
      await setup.other.query("UPDATE tasks SET label = 'a' WHERE id = 't1'");
      const sending = setup.engine.update(setup.session, {
        binding,
        operationId: 'folded',
        updaterId: 'bang',
      });
      await sleep(LANDED_MS);

      await setup.other.query('COMMIT');
      await sending;

      await expect(setup.row()).resolves.toMatchObject({ label: 'a!' });
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    'is forbidden a write its role has no right to, though it reads the row',
    async () => {
      const setup = await opened({ pool: { user: 'reactive_reader' }, setup: ROLES });

      await expect(setup.fields()).resolves.toMatchObject({ title: 'Write docs' });
      await expect(setup.write('title', 'setTitle', { value: 'Mine' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    "is refused by a policy's check, a trigger's exception and an index's limit",
    async () => {
      const setup = await opened({
        pool: { user: 'reactive_writer' },
        setup: `${ROLES}
          ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
          CREATE POLICY seen ON tasks FOR SELECT USING (true);
          CREATE POLICY kept ON tasks FOR UPDATE USING (true) WITH CHECK (title <> 'barred');
          CREATE FUNCTION refused_title() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF NEW.title = 'raised' THEN RAISE EXCEPTION 'No such title'; END IF;
              RETURN NEW;
            END
          $$;
          CREATE TRIGGER tasks_refused_title BEFORE UPDATE ON tasks
            FOR EACH ROW EXECUTE FUNCTION refused_title();
        `,
      });
      const past = Array.from({ length: STEPS.length }, (_, at) =>
        String.fromCodePoint(STEPS.first + ((at * STEPS.stride) % STEPS.span)),
      ).join('');

      await expect(setup.write('title', 'setTitle', { value: 'barred' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(setup.write('title', 'setTitle', { value: 'raised' })).rejects.toMatchObject({
        code: 'INVALID_VALUE',
      });
      await expect(setup.write('slug', 'setSlug', { value: past })).rejects.toMatchObject({
        code: 'INVALID_VALUE',
      });

      await setup.write('title', 'setTitle', { value: 'Fine' });

      await expect(setup.row()).resolves.toMatchObject({ title: 'Fine' });
    },
    SERVER_TIMEOUT_MS,
  );

  it(
    "applies once more, of what a holder that rolled back left, past its call's end",
    async () => {
      const setup = await opened({ timeoutMs: CALL_MS });
      const sent = {
        binding: await setup.bindingOf('estimate'),
        captures: { step: 2 },
        operationId: 'twice',
        updaterId: 'add',
      };
      await setup.other.query('BEGIN');
      await setup.other.query("UPDATE tasks SET estimate = 10 WHERE id = 't1'");

      await expect(setup.engine.update(setup.session, sent)).rejects.toThrow(
        'did not settle within',
      );

      await setup.other.query('COMMIT');
      await sleep(LANDED_MS);

      await expect(setup.row()).resolves.toMatchObject({ estimate: 10 });

      await setup.engine.update(setup.session, sent);

      await expect(setup.row()).resolves.toMatchObject({ estimate: 12 });
    },
    SERVER_TIMEOUT_MS,
  );
});
