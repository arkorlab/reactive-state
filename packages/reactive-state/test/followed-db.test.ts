import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core';
import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest';

import type { ExternalStore, ExternalStores } from '../src/authority/external.ts';
import { Engine } from '../src/authority/node-engine.ts';
import {
  type ComponentProgram,
  type FieldRef,
  isFieldRef,
  PROTOCOL_VERSION,
  type RenderScope,
} from '../src/program.ts';
import { type AnyDatabase, database } from '../src/server/schema.ts';
import { type DrizzleFollow, followDrizzle, followedDb } from '../src/sql/index.ts';
import { followInternals } from './support/follow-store.ts';
import { textOf } from './support/frames.ts';

/**
 * `followedDb`: the database of a host's follows, each of which brings the store the authority
 * follows its log by, made as the authority starts of the connection the follow's `client` was last
 * given — and what it refuses.
 */

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text().notNull() });
const notes = pgTable('notes', { id: text().primaryKey(), body: text().notNull() });
const cards = sqliteTable('cards', {
  id: sqliteText().primaryKey(),
  title: sqliteText().notNull(),
});
const BUILD = 'b_followed';
const COMPONENT = 'components/followed';
/** Long enough that only `poke()` reads the logs in a test. */
const IDLE_POLL_MS = 60_000;
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;
const TASKS = `
  CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL);
  INSERT INTO tasks VALUES ('t1', 'Write docs');
`;
const NOTES = `
  CREATE TABLE notes (id text PRIMARY KEY, body text NOT NULL);
  INSERT INTO notes VALUES ('n1', 'Kept');
`;

/**
 * A PGlite of its own, whose tables `ddl` makes, with their log, followed as the store `store`, and
 * its Drizzle through the client a render's queries are followed by.
 */
async function opened<S extends Readonly<Record<string, unknown>>>(
  schema: S,
  ddl: string,
  store = 'sql',
) {
  // A schema of PostgreSQL's tables, which a type of no table yet says not.
  const follow = followDrizzle(schema, { store }) as DrizzleFollow<S>;
  const pg = await PGlite.create();
  onTestFinished(async () => {
    await pg.close();
  });
  await pg.exec(ddl);
  for (const statement of follow.captureSql()) {
    await pg.query(statement);
  }
  const orm = drizzle({ client: follow.client(pg), schema });
  return { follow, orm, pg };
}

/** A component of `evaluate`, of no updates. */
function programOf(evaluate: ComponentProgram['evaluate']): ComponentProgram {
  return {
    buildId: BUILD,
    component: COMPONENT,
    evaluate,
    protocolVersion: PROTOCOL_VERSION,
    updaters: {},
    writable: [],
  };
}

/** An engine of one component, of `database`, given `stores` alone of what a host may give. */
async function engineOf(
  db: AnyDatabase,
  evaluate: ComponentProgram['evaluate'],
  stores?: ExternalStores,
) {
  const engine = new Engine({
    buildId: BUILD,
    database: db,
    externalPollMs: IDLE_POLL_MS,
    programs: [programOf(evaluate)],
    ...(stores !== undefined && { stores }),
  });
  onTestFinished(async () => {
    await engine.close();
  });
  await engine.poke();
  const session = (await engine.login('alice')).sessionId;
  const root = { build: BUILD, component: COMPONENT, props: {} };
  return { engine, render: async () => textOf((await engine.render(session, root)).tree) };
}

/** What a store of the host's answers of its records: they are read by SQL. */
const readBySql = (): Promise<never> => Promise.reject(new Error('Read by SQL.'));

/** A store of the host's own, whose log tells of no change, and its reads of the log. */
function quietStore() {
  const changes = vi.fn<ExternalStore['changes']>(() =>
    Promise.resolve({ changes: [], epoch: 'host', floor: 0, head: 0 }),
  );
  const store: ExternalStore = { changes, count: readBySql, find: readBySql, get: readBySql };
  return { changes, store };
}

describe('a database of follows', { timeout: TEST_TIMEOUT_MS }, () => {
  it('renders again a row its follow’s Drizzle changed, of no stores given', async () => {
    const setup = await opened({ tasks }, TASKS);
    const { engine, render } = await engineOf(followedDb(setup.follow), async (_props, $) => {
      const [task] = await setup.orm.select().from(tasks).where(eq(tasks.id, 't1'));
      return $.h('p', null, task?.title);
    });

    await expect(render()).resolves.toBe('Write docs');

    await setup.orm.update(tasks).set({ title: 'Renamed' }).where(eq(tasks.id, 't1'));
    await engine.poke();

    await expect(render()).resolves.toBe('Renamed');
  });

  it('follows each of two follows of their own stores, in one database', async () => {
    const web = await opened({ tasks }, TASKS, 'web');
    const control = await opened({ notes }, NOTES, 'control');
    const evaluate = vi.fn(async (_props: unknown, $: RenderScope) => {
      const [task] = await web.orm.select().from(tasks).where(eq(tasks.id, 't1'));
      const [note] = await control.orm.select().from(notes).where(eq(notes.id, 'n1'));
      return $.h('p', null, `${task?.title ?? ''} / ${note?.body ?? ''}`);
    });
    const { engine, render } = await engineOf(followedDb(web.follow, control.follow), evaluate);

    await expect(render()).resolves.toBe('Write docs / Kept');

    await web.orm.update(tasks).set({ title: 'Renamed' }).where(eq(tasks.id, 't1'));
    await engine.poke();

    await expect(render()).resolves.toBe('Renamed / Kept');

    await control.orm.update(notes).set({ body: 'Edited' }).where(eq(notes.id, 'n1'));
    await engine.poke();

    await expect(render()).resolves.toBe('Renamed / Edited');
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it('reads the store the host gives in place of the follow’s', async () => {
    const setup = await opened({ tasks }, TASKS);
    const host = quietStore();
    const evaluate = vi.fn(async (_props: unknown, $: RenderScope) => {
      const [task] = await setup.orm.select().from(tasks).where(eq(tasks.id, 't1'));
      return $.h('p', null, task?.title);
    });
    const { engine, render } = await engineOf(followedDb(setup.follow), evaluate, {
      sql: host.store,
    });

    await expect(render()).resolves.toBe('Write docs');

    await setup.orm.update(tasks).set({ title: 'Renamed' }).where(eq(tasks.id, 't1'));
    await engine.poke();

    // The host's log tells of no change, and the follow's is not read.
    await expect(render()).resolves.toBe('Write docs');
    expect(evaluate).toHaveBeenCalledExactlyOnceWith({}, expect.anything());
    expect(host.changes).toHaveBeenCalledTimes(2);
  });

  it('starts of a follow given no connection where the host gives its store', () => {
    const engine = new Engine({
      buildId: BUILD,
      database: followedDb(followDrizzle({ tasks })),
      programs: [programOf((_props, $) => $.h('p', null))],
      stores: { sql: quietStore().store },
    });
    onTestFinished(async () => {
      await engine.close();
    });

    expect(engine).toBeInstanceOf(Engine);
  });

  it('refuses at the authority’s start a follow given no connection', () => {
    const db = followedDb(followDrizzle({ tasks }), followDrizzle({ notes }, { store: 'notes' }));

    expect(() => {
      return new Engine({
        buildId: BUILD,
        database: db,
        programs: [programOf((_props, $) => $.h('p', null))],
      });
    }).toThrow(
      "The store `sql` reads its follow's log through the connection `follow.client` was given, and the follow was given none as the authority started",
    );
  });

  it('answers a database whose tables bind a row, and answer nothing else', () => {
    const db = followedDb(followDrizzle({ tasks }), followDrizzle({ cards }, { store: 'd1' }));
    const row = db.tasks.where(eq(tasks.id, 't1'));
    const card = db.cards.where(eq(cards.id, 'c1'));

    expect(isFieldRef(row.title)).toBe(true);
    expect(isFieldRef(card.title)).toBe(true);

    expectTypeOf(row.title).toEqualTypeOf<FieldRef<string>>();
    expectTypeOf(card.title).toEqualTypeOf<FieldRef<string>>();
    expectTypeOf(db.tasks).not.toHaveProperty('findMany');
    expectTypeOf(db).not.toHaveProperty('reactive_state_schema_sql');
  });
});

describe('what followedDb refuses', () => {
  const follow = followDrizzle({ tasks });

  it.each([
    ['its tables', () => followInternals(follow).tables],
    ['a copy of it', () => ({ ...follow })],
    ['a database of its tables', () => database(followInternals(follow).tables)],
  ])('refuses in place of a follow %s', (_, given) => {
    expect(() => followedDb(given() as never)).toThrow(
      'followedDb(): argument 1 is not what `followDrizzle()` answered: give each follow itself, not its `tables` nor a database',
    );
  });

  it('refuses no follow at all', () => {
    const untyped = followedDb as (...follows: readonly unknown[]) => unknown;

    expect(() => untyped()).toThrow(
      'followedDb(): give it at least one follow, of what `followDrizzle()` answered',
    );
  });

  it.each([
    ['given twice', () => followedDb(follow, follow)],
    ['of two schemas', () => followedDb(follow, followDrizzle({ notes }))],
    ['of PostgreSQL and of D1', () => followedDb(follow, followDrizzle({ cards }))],
  ])('refuses two follows of one store, %s', (_, made) => {
    expect(made).toThrow(
      'followedDb(): two of the follows are of the store `sql`: give each follow once, and each its own store, `followDrizzle(schema, { store })`',
    );
  });

  it('refuses a table two follows hold', () => {
    const other = followDrizzle({ notes, tasks }, { store: 'other' });

    expect(() => followedDb(follow, other)).toThrow(
      "followedDb(): `tasks` is a table of two of the follows' schemas: export it by another name in one of them",
    );
  });
});
