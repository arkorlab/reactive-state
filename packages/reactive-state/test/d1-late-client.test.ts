import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest';

import { Engine } from '../src/authority/node-engine.ts';
import { type ComponentProgram, PROTOCOL_VERSION, type RenderScope } from '../src/program.ts';
import { internalsOf } from '../src/sql/follow-internals.ts';
import { type DrizzleD1Follow, followDrizzle, followedDb } from '../src/sql/index.ts';
import { type LocalD1, localD1 } from '../src/sql/sqlite/local-d1.ts';
import { notedBy } from './cloudflare/d1-drizzle-render.ts';
import { textOf } from './support/frames.ts';

/**
 * D1's follow given a function that answers the binding of now, or none — as a Durable Object
 * connects the D1 of its environment in its constructor — of files in D1's shape: each statement
 * runs through what the function answers as it is called, and the follow's own store reads the log
 * through it, and reads nothing while it answers none.
 */

const cards = sqliteTable('cards', { id: text().primaryKey(), title: text().notNull() });
const schema = { cards };
const DDL = 'CREATE TABLE cards (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL)';
const BUILD = 'b_late_client';
const COMPONENT = 'components/late-client';
const ROOT = { build: BUILD, component: COMPONENT, props: {} };
/** Long enough that only `poke()` reads the log in a test. */
const IDLE_POLL_MS = 60_000;
/** The page of the log of a function that answers no binding. */
const UNCONNECTED = { changes: [], epoch: 'unconnected', floor: 0, head: 0 };

/** The follow of the schema's tables, of the store `store`. */
function followOf(store = 'sql'): DrizzleD1Follow<typeof schema> {
  return followDrizzle(schema, { store });
}

/**
 * A database of memory alone, of the table, `more` of the application's, the log of `follow` and
 * the card `c1` of `title`, closed as the test ends.
 */
async function opened(
  follow: DrizzleD1Follow<typeof schema>,
  title: string,
  more: readonly string[] = [],
): Promise<LocalD1> {
  const binding = localD1(':memory:');
  onTestFinished(() => {
    binding.close();
  });
  const statements = [DDL, ...more, ...follow.captureSql()];
  await binding.batch(statements.map((statement) => binding.prepare(statement)));
  await binding.prepare("INSERT INTO cards VALUES ('c1', ?)").bind(title).run();
  return binding;
}

/** The follow's own store, as an authority makes it as it starts. */
function storeOf(follow: DrizzleD1Follow<typeof schema>) {
  const store = internalsOf(follow)?.store();
  if (store === undefined) throw new Error('The follow brings no store.');
  return store;
}

describe('a D1 follow given a function that answers its binding', () => {
  it('runs each statement through the binding the function answers as it runs', async () => {
    const follow = followOf();
    const first = await opened(follow, 'Of the first');
    const second = await opened(follow, 'Of the second');
    let current: LocalD1 | undefined = first;
    const client = follow.client(() => current);
    const orm = drizzle(client as never, { schema });
    const title = async () => (await orm.select().from(cards).where(eq(cards.id, 'c1')))[0]?.title;
    const { row } = followedDb(follow).cards.where(eq(cards.id, 'c1')).title;

    await expect(title()).resolves.toBe('Of the first');
    await expect(row?.read(['title'])).resolves.toStrictEqual({ title: 'Of the first' });

    current = second;

    await expect(title()).resolves.toBe('Of the second');
    await expect(row?.read(['title'])).resolves.toStrictEqual({ title: 'Of the second' });
    // In a render too, whose plan is asked of the binding of now.
    await expect(notedBy(title)).resolves.toContainEqual(
      expect.objectContaining({ table: 'cards' }),
    );

    // D1's methods of the binding's type alone: not `close`, which no D1 binding of a Worker's has
    // and the binding of a function calls not.
    expectTypeOf(client).toEqualTypeOf<Pick<LocalD1, 'batch' | 'prepare'>>();

    expect(Object.hasOwn(client, 'close')).toBe(false);
  });

  it('calls each other method of D1’s of the binding the function answers', async () => {
    const session = { batch: vi.fn(), prepare: vi.fn() };
    const binding = {
      batch: vi.fn(),
      dump: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
      exec: vi.fn<(sql: string) => Promise<unknown>>(() =>
        Promise.resolve({ count: 1, duration: 0 }),
      ),
      prepare: vi.fn(),
      withSession: vi.fn<(constraint?: string) => typeof session>(() => session),
    };
    const client = followOf().client(() => binding);

    await expect(client.exec('SELECT 1')).resolves.toStrictEqual({ count: 1, duration: 0 });
    await expect(client.dump()).resolves.toBeInstanceOf(ArrayBuffer);

    client.withSession('first-primary');

    expect(binding.exec).toHaveBeenCalledWith('SELECT 1');
    expect(binding.dump).toHaveBeenCalledTimes(1);
    expect(binding.withSession).toHaveBeenCalledWith('first-primary');
  });

  it('throws a statement, naming the store, while the function answers none', async () => {
    const follow = followOf('cards');
    // Of no environment yet: no binding.
    const connection: { binding?: LocalD1 } = {};
    const orm = drizzle(follow.client(() => connection.binding) as never, { schema });
    const { row } = followedDb(follow).cards.where(eq(cards.id, 'c1')).title;
    const named = 'The store `cards` reads and writes D1 through the binding that the function';

    await expect(orm.select().from(cards)).rejects.toThrow(named);
    await expect(row?.read(['title'])).rejects.toThrow(named);
    await expect(row?.write('title', 'Renamed')).rejects.toThrow(named);
  });

  /** As a plain-JavaScript `env.DB ?? null` answers none. */
  it('takes a binding of null for none, of a statement and of a read of the log', async () => {
    const follow = followOf('cards');
    const client = follow.client((): LocalD1 | null => null);
    const orm = drizzle(client as never, { schema });

    await expect(orm.select().from(cards)).rejects.toThrow('The store `cards` reads and writes D1');
    await expect(storeOf(follow).changes(0, 10)).resolves.toStrictEqual(UNCONNECTED);
  });

  it('reads no log while the function answers none, of one epoch', async () => {
    const follow = followOf();
    const current = vi.fn<() => LocalD1 | undefined>();
    follow.client(current);
    const store = storeOf(follow);

    await expect(store.changes(0, 10)).resolves.toStrictEqual(UNCONNECTED);
    await expect(store.changes(Number.MAX_SAFE_INTEGER, 10)).resolves.toStrictEqual(UNCONNECTED);
    expect(current).toHaveBeenCalledTimes(2);
  });

  it('reads the log through a binding the function answers later, of another epoch', async () => {
    const follow = followOf();
    const connection: { binding?: LocalD1 } = {};
    const orm = drizzle(follow.client(() => connection.binding) as never, { schema });
    const store = storeOf(follow);
    const before = await store.changes(0, 10);
    const binding = await opened(follow, 'First');
    connection.binding = binding;

    const after = await store.changes(0, 10);
    await orm.update(cards).set({ title: 'Renamed' }).where(eq(cards.id, 'c1'));
    const changed = await store.changes(after.head, 10);

    expect(after.epoch).not.toBe(before.epoch);
    expect(after.epoch).toBe((await follow.store(binding).changes(0, 10)).epoch);
    expect(changed.changes).toStrictEqual([
      expect.objectContaining({ after: { k_id: 'c1' }, before: { k_id: 'c1' }, table: 'cards' }),
    ]);
  });

  it('reads each binding’s log by a store of its own, of that database’s schema', async () => {
    const follow = followOf();
    const first = await opened(follow, 'First');
    // Of another schema than the first's: another digest.
    const second = await opened(follow, 'Second', ['CREATE INDEX cards_title ON cards (title)']);
    let current: LocalD1 | undefined = first;
    follow.client(() => current);
    const store = storeOf(follow);

    const ofFirst = await store.changes(0, 10);
    current = second;
    const ofSecond = await store.changes(0, 10);
    current = first;
    const again = await store.changes(0, 10);

    expect(ofSecond.epoch).toBe((await follow.store(second).changes(0, 10)).epoch);
    expect(ofSecond.epoch).not.toBe(ofFirst.epoch);
    expect(again.epoch).toBe(ofFirst.epoch);
  });

  /**
   * The follow's plans are of the schema its store read last: a store kept for the first binding
   * would not read its schema again on the way back, and the plans would stay of the second's.
   */
  it('reads the schema again of a binding it comes back to, of whose schema the plans then are', async () => {
    const follow = followOf();
    const first = await opened(follow, 'First');
    const second = await opened(follow, 'Second', [
      'CREATE UNIQUE INDEX cards_title ON cards (title)',
    ]);
    let current: LocalD1 | undefined = first;
    follow.client(() => current);
    const store = storeOf(follow);
    await store.changes(0, 10);
    current = second;
    await store.changes(0, 10);
    const prepared = vi.spyOn(first, 'prepare');
    current = first;

    await store.changes(0, 10);

    expect(prepared.mock.calls.map(([sql]) => sql)).toContain(
      'SELECT rowid, type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name',
    );
  });

  it('throws what the function throws, of a statement and of a read of the log', async () => {
    const follow = followOf();
    const thrown = new Error('No environment yet.');
    const orm = drizzle(
      follow.client((): LocalD1 => {
        throw thrown;
      }) as never,
      { schema },
    );

    await expect(orm.select().from(cards)).rejects.toBe(thrown);
    await expect(storeOf(follow).changes(0, 10)).rejects.toBe(thrown);
  });
});

describe('an engine of a database of such a follow', () => {
  it('starts unconnected, and renders once connected, again of the new log', async () => {
    const follow = followOf();
    const connection: { binding?: LocalD1 } = {};
    const orm = drizzle(follow.client(() => connection.binding) as never, { schema });
    const evaluate = vi.fn(async (_props: unknown, $: RenderScope) => {
      const [card] = await orm.select().from(cards).where(eq(cards.id, 'c1'));
      return $.h('p', null, card?.title);
    });
    const program: ComponentProgram = {
      buildId: BUILD,
      component: COMPONENT,
      evaluate,
      protocolVersion: PROTOCOL_VERSION,
      updaters: {},
      writable: [],
    };
    const engine = new Engine({
      buildId: BUILD,
      database: followedDb(follow),
      externalPollMs: IDLE_POLL_MS,
      programs: [program],
    });
    onTestFinished(async () => {
      await engine.close();
    });
    // The log of no binding, read of nothing.
    await engine.poke();
    connection.binding = await opened(follow, 'First');
    const session = (await engine.login('alice')).sessionId;
    const render = async () => textOf((await engine.render(session, ROOT)).tree);

    await expect(render()).resolves.toBe('First');

    // The log of the binding, of another epoch: what read its tables renders again.
    await engine.poke();

    await expect(render()).resolves.toBe('First');
    expect(evaluate).toHaveBeenCalledTimes(2);

    await orm.update(cards).set({ title: 'Renamed' }).where(eq(cards.id, 'c1'));
    await engine.poke();

    await expect(render()).resolves.toBe('Renamed');
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  /**
   * A render whose code answers something of its own for the error of no binding read nothing the
   * binding's arrival could render again: it fails instead, and is rendered again, of the binding.
   */
  it('fails a render that caught the error of no binding, and renders it once connected', async () => {
    const follow = followOf();
    const connection: { binding?: LocalD1 } = {};
    const orm = drizzle(follow.client(() => connection.binding) as never, { schema });
    const evaluate = vi.fn(async (_props: unknown, $: RenderScope) => {
      try {
        const [card] = await orm.select().from(cards).where(eq(cards.id, 'c1'));
        return $.h('p', null, card?.title);
      } catch {
        return $.h('p', null, 'Unavailable');
      }
    });
    const program: ComponentProgram = {
      buildId: BUILD,
      component: COMPONENT,
      evaluate,
      protocolVersion: PROTOCOL_VERSION,
      updaters: {},
      writable: [],
    };
    const engine = new Engine({
      buildId: BUILD,
      database: followedDb(follow),
      externalPollMs: IDLE_POLL_MS,
      programs: [program],
    });
    onTestFinished(async () => {
      await engine.close();
    });
    const session = (await engine.login('alice')).sessionId;
    const render = async () => textOf((await engine.render(session, ROOT)).tree);

    await expect(render()).rejects.toThrow('The store `sql` reads and writes D1');

    connection.binding = await opened(follow, 'First');
    await engine.poke();

    await expect(render()).resolves.toBe('First');
  });
});
