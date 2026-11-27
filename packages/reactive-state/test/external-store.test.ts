import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { eq } from 'drizzle-orm';
import { pgTable, text as column } from 'drizzle-orm/pg-core';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Dependencies, type RowChange } from '../src/authority/dependencies.ts';
import { ExternalTail } from '../src/authority/external-tail.ts';
import { type ExternalChange, ExternalFollower } from '../src/authority/external.ts';
import { Engine } from '../src/authority/node-engine.ts';
import { nextTurn } from '../src/authority/turns.ts';
import { ObjectAlarm } from '../src/cloudflare/alarm.ts';
import {
  type ComponentProgram,
  componentRef,
  PROTOCOL_VERSION,
  type RenderScope,
  type Json,
} from '../src/program.ts';
import { database, definitionOf } from '../src/server/schema.ts';
import { followDrizzle, followedDb } from '../src/sql/index.ts';
import { keyDigest } from '../src/sql/reads.ts';
import { openedWith } from './support/drizzle.ts';
import { followInternals, logStore, readingThrough } from './support/follow-store.ts';
import { textOf } from './support/frames.ts';

/** The application's items, of a Drizzle schema, which its own database holds and logs. */
const items = pgTable('items', {
  id: column().primaryKey(),
  title: column().notNull(),
  group: column().notNull().unique(),
});
const ITEMS_DDL = `
  CREATE TABLE items (id text PRIMARY KEY, title text NOT NULL, "group" text NOT NULL UNIQUE);
  INSERT INTO items VALUES ('one', 'first', 'a');
`;
/** A follow of the items, of the store `remote`, given no connection: a stand-in reads its log. */
const follow = followDrizzle({ items }, { store: 'remote' });
/** The tables read through the store, as the authority reads them of the follow's database. */
const tables = definitionOf(followedDb(follow)).tables;
const CLOCK = { start: 1000, tick: 100, expired: 31_000 } as const;
const BUILD = 'b_external';
const LOG_PAGE = 200;

/**
 * A stand-in of a follow's store: a log the application changes without writing to the authority,
 * of an epoch and a floor the test moves, whose reads may fail.
 */
function log() {
  const changes: ExternalChange[] = [];
  let epoch = 'initial';
  let floor = 0;
  let fail = false;
  const readLog = vi.fn((since: number, limit: number) => {
    if (fail) return Promise.reject(new Error('The remote store is unavailable.'));
    return Promise.resolve({
      changes: changes.filter((change) => change.seq > since).slice(0, limit),
      epoch,
      floor,
      head: changes.at(-1)?.seq ?? 0,
    });
  });
  return {
    changes,
    epoch: (value: string) => {
      epoch = value;
    },
    fail: (value: boolean) => {
      fail = value;
    },
    floor: (value: number) => {
      floor = value;
    },
    readLog,
    store: logStore(readLog),
  };
}

/** A database of the follow's tables, whose log the authority reads through `source`. */
function readThrough(source: ReturnType<typeof log>) {
  return readingThrough(followedDb(follow), { remote: () => source.store });
}

/**
 * The items in a database of the application's own, read by its Drizzle, and a database of them
 * whose log the authority reads through `source`.
 */
async function followedItems(source: ReturnType<typeof log>) {
  const setup = await openedWith({ items }, ITEMS_DDL);
  return { ...setup, db: readingThrough(followedDb(setup.follow), { sql: () => source.store }) };
}

/** The title of the item `one`, as the application's Drizzle reads it. */
async function titleOfOne(setup: Awaited<ReturnType<typeof followedItems>>) {
  const [item] = await setup.orm
    .select({ title: items.title })
    .from(items)
    .where(eq(items.id, 'one'));
  return item?.title;
}

/** What a follow's log keeps of the item `id` of `group`: its keys, as their digests. */
function keysOf(id: string, group: string) {
  return { k_group: keyDigest(group), k_id: keyDigest(id) };
}

describe('external stores', () => {
  it('refuses a host without the store or with no interval before it opens the database', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'reactive-state-external-'));
    onTestFinished(async () => {
      await rm(dir, { force: true, recursive: true });
    });
    const filename = path.join(dir, 'authority.sqlite');
    // Of a follow given no connection, which brings no store.
    const opened = { buildId: BUILD, database: followedDb(follow), filename, programs: [] };

    expect(() => new Engine(opened)).toThrow(
      "The store `remote` reads its follow's log through the connection `follow.client` was given",
    );
    // Of the follow's tables declared beside none, whose declaration no follow brought a store
    // of: the authority's own refusal of a table whose store no follow brought.
    expect(
      () => new Engine({ ...opened, database: database(followInternals(follow).tables) }),
    ).toThrow("the store `remote`, which no follow of the authority's database brought");
    expect(
      () => new Engine({ ...opened, database: readThrough(log()), externalPollMs: 0 }),
    ).toThrow('externalPollMs');

    const kept = new DatabaseSync(filename);
    onTestFinished(() => {
      kept.close();
    });

    expect(kept.prepare('SELECT name FROM sqlite_master').all()).toStrictEqual([]);
  });

  it('does not commit an unchanged log', async () => {
    const source = log();
    const engine = new Engine({
      buildId: BUILD,
      database: readThrough(source),
      programs: [],
    });
    onTestFinished(async () => {
      await engine.close();
    });
    await engine.poke();
    const revision = engine.revision();

    await engine.poke();

    expect(engine.revision()).toBe(revision);
  });

  it('stops after idle memos expire and reads the store again on the next visit', async () => {
    const source = log();
    const setup = await followedItems(source);
    let now = CLOCK.start;
    const child: ComponentProgram = {
      buildId: BUILD,
      component: 'components/external-child',
      protocolVersion: PROTOCOL_VERSION,
      evaluate: async (_props, $) => $.h('p', null, await titleOfOne(setup)),
      updaters: {},
      writable: [],
    };
    const root: ComponentProgram = {
      ...child,
      component: 'components/child-root',
      evaluate: (_props, $) => $.h(componentRef(child.component), {}),
    };
    const engine = new Engine({
      buildId: BUILD,
      clock: () => now,
      database: setup.db,
      externalPollMs: CLOCK.tick,
      programs: [root, child],
    });
    onTestFinished(async () => {
      await engine.close();
    });
    const session = (await engine.login('alice')).sessionId;
    const request = { build: BUILD, component: root.component, props: {} };
    await engine.poke();
    await engine.render(session, request);
    await nextTurn();
    const reads = source.readLog.mock.calls.length;
    now += CLOCK.expired;

    await engine.pollExternal();

    expect(source.readLog).toHaveBeenCalledTimes(reads);

    await setup.pg.query("UPDATE items SET title = 'after idle' WHERE id = 'one'");

    expect(textOf((await engine.render(session, request)).tree)).toBe('after idle');
  });

  it('keeps the cursor until its changes have been ingested', async () => {
    const source = log();
    const follower = new ExternalFollower(source.store, tables);
    await follower.changed();
    source.changes.push({ seq: 1, table: 'items', id: 'one' });
    const ingest = vi.fn(() => Promise.reject(new Error('The local commit failed.')));

    await expect(follower.changed(ingest)).rejects.toThrow('local commit failed');

    const replayed = await follower.changed();

    expect(replayed).toMatchObject([{ id: 'one', table: 'items', unknown: 'fields' }]);
    expect(source.readLog.mock.calls.at(-1)?.[0]).toBe(0);
  });

  it.each([
    { what: 'corrected record', before: { k_id: 1 }, after: { k_id: 'corrected' } },
    { what: 'deleted invalid record', before: { k_id: 1 }, after: null },
    { what: 'invalid after image', before: { k_id: 'before' }, after: { k_id: 1 } },
  ])('invalidates an invalid historical $what and continues to later changes', async (image) => {
    const source = log();
    const follower = new ExternalFollower(source.store, tables);
    await follower.changed();
    const dependencies = new Dependencies();
    dependencies.query('items', { k_id: 'any prior predicate' });
    source.changes.push({ ...image, id: 'one', seq: 1, table: 'items' });

    const changed = await follower.changed();

    expect(changed).toMatchObject([{ id: 'one', unknown: 'fields' }]);
    expect(dependencies.changedBy(changed)).toBe(true);

    source.changes.push({
      before: { k_id: 'corrected' },
      after: { k_id: 'later' },
      id: 'two',
      seq: 2,
      table: 'items',
    });

    await expect(follower.changed()).resolves.toMatchObject([
      { id: 'two', after: { k_id: 'later' } },
    ]);
    expect(source.readLog.mock.calls.at(-1)?.[0]).toBe(1);
  });

  it('invalidates every dependency when a log is replaced or pruned past its cursor', async () => {
    const source = log();
    const follower = new ExternalFollower(source.store, tables);
    const dependencies = new Dependencies();
    dependencies.record('items', 'missing');

    expect(dependencies.changedBy(await follower.changed())).toBe(true);
    await expect(follower.changed()).resolves.toStrictEqual([]);

    source.epoch('replaced');

    expect(dependencies.changedBy(await follower.changed())).toBe(true);

    source.changes.push({ seq: CLOCK.tick, table: 'items', id: 'one' });
    source.floor(CLOCK.tick);

    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('invalidates a rewound log even when its epoch was preserved', async () => {
    const source = log();
    source.changes.push({ seq: 2, table: 'items', id: 'one' });
    const follower = new ExternalFollower(source.store, tables);
    await follower.changed();
    source.changes.length = 0;

    // Each table of the store: the items, and the table of their schema's changes.
    await expect(follower.changed()).resolves.toMatchObject([
      { table: 'items', unknown: 'table' },
      { table: 'reactive_state_schema_remote', unknown: 'table' },
    ]);
  });

  it('rejects malformed log metadata and replays the same cursor after recovery', async () => {
    const source = log();
    const follower = new ExternalFollower(source.store, tables);
    await follower.changed();
    source.readLog.mockResolvedValueOnce({ changes: [], epoch: 'initial', floor: 0, head: NaN });

    await expect(follower.changed()).rejects.toThrow('valid head');

    source.changes.push({ seq: 1, table: 'items', id: 'one' });

    await expect(follower.changed()).resolves.toMatchObject([{ id: 'one' }]);
  });

  it('recovers a coalesced read even when the read ahead of it rejects', async () => {
    const source = log();
    source.readLog.mockRejectedValueOnce(new Error('A transient failure.'));
    const tail = new ExternalTail({
      ingest: () => Promise.resolve(),
      stores: new Map([['items', source.store]]),
      tables,
    });
    onTestFinished(() => {
      tail.stop();
    });
    const first = tail.read();
    const after = tail.read();

    await expect(first).rejects.toThrow('transient failure');
    await expect(after).resolves.toBeUndefined();
    expect(source.readLog).toHaveBeenCalledTimes(2);
  });

  it('keeps the earliest deadline when delivery and a log arm the same object', async () => {
    let alarm: number | null = null;
    const shared = new ObjectAlarm({
      getAlarm: () => Promise.resolve(alarm),
      setAlarm: (at) => {
        alarm = at;
        return Promise.resolve();
      },
    });

    await Promise.all([shared.arm(CLOCK.start), shared.arm(CLOCK.tick), shared.arm(CLOCK.expired)]);

    expect(alarm).toBe(CLOCK.tick);
  });

  it('uses a host alarm while renderings are retained, and stops once none remain', async () => {
    const source = log();
    let retained = false;
    let now = CLOCK.start;
    const schedule = vi.fn();
    const tail = new ExternalTail({
      clock: () => now,
      everyMs: CLOCK.tick,
      ingest: () => Promise.resolve(),
      retained: () => retained,
      schedule,
      stores: new Map([['items', source.store]]),
      tables,
    });
    onTestFinished(() => {
      tail.stop();
    });
    tail.refresh();

    expect(schedule).not.toHaveBeenCalled();

    retained = true;
    tail.refresh();

    expect(source.readLog).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenLastCalledWith(CLOCK.start + CLOCK.tick);

    now += CLOCK.tick;
    await tail.run();

    expect(source.readLog).toHaveBeenCalledExactlyOnceWith(Number.MAX_SAFE_INTEGER, LOG_PAGE);

    retained = false;
    now += CLOCK.tick;
    schedule.mockClear();
    await tail.run();

    expect(schedule).not.toHaveBeenCalled();
    expect(source.readLog).toHaveBeenCalledExactlyOnceWith(Number.MAX_SAFE_INTEGER, LOG_PAGE);
  });

  it('rearms after a failed read without losing its cursor', async () => {
    const source = log();
    let now = CLOCK.start;
    const schedule = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {
      /* The test asserts this failure below. */
    });
    onTestFinished(() => {
      errors.mockRestore();
    });
    const ingest = vi
      .fn<(rows: readonly RowChange[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const tail = new ExternalTail({
      clock: () => now,
      everyMs: CLOCK.tick,
      ingest,
      retained: () => true,
      schedule,
      stores: new Map([['items', source.store]]),
      tables,
    });
    onTestFinished(() => {
      tail.stop();
    });
    await tail.read();
    source.fail(true);
    tail.refresh();
    now += CLOCK.tick;
    await tail.run();

    expect(schedule).toHaveBeenLastCalledWith(now + CLOCK.tick);

    source.fail(false);
    source.changes.push({ seq: 1, table: 'items', id: 'one' });
    now += CLOCK.tick;
    await tail.run();

    expect(ingest.mock.calls.at(-1)?.[0]).toMatchObject([{ id: 'one' }]);
  });

  it('keeps memoized renders current without a connected stream', async () => {
    const source = log();
    const setup = await followedItems(source);
    const component: ComponentProgram = {
      buildId: BUILD,
      component: 'components/external-record',
      evaluate: async (_props, $) => $.h('p', null, await titleOfOne(setup)),
      protocolVersion: PROTOCOL_VERSION,
      updaters: {},
      writable: [],
    };
    const engine = new Engine({
      buildId: BUILD,
      database: setup.db,
      externalPollMs: CLOCK.tick,
      programs: [component],
    });
    onTestFinished(async () => {
      await engine.close();
    });
    const session = (await engine.login('alice')).sessionId;
    const root = { build: BUILD, component: component.component, props: {} };

    expect(textOf((await engine.render(session, root)).tree)).toBe('first');

    await vi.waitFor(() => {
      expect(source.readLog).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER, LOG_PAGE);
    });
    await setup.pg.query("UPDATE items SET title = 'second' WHERE id = 'one'");
    const one = keysOf('one', 'a');
    source.changes.push({ after: one, before: one, id: 'row', seq: 1, table: 'items' });

    await vi.waitFor(async () => {
      expect(textOf((await engine.render(session, root)).tree)).toBe('second');
    });

    expect((await engine.stats()).commits).toBeGreaterThan(0);
  });

  it('evicts only queries whose where predicate a changed record enters or leaves', async () => {
    const source = log();
    const setup = await followedItems(source);
    const evaluate = vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
      const records = await setup.orm
        .select({ title: items.title })
        .from(items)
        .where(eq(items.group, 'a'))
        .limit(1);
      return $.h('p', null, records.map((record) => record.title).join(','));
    });
    const component: ComponentProgram = {
      buildId: BUILD,
      component: 'components/filtered-records',
      evaluate,
      protocolVersion: PROTOCOL_VERSION,
      updaters: {},
      writable: [],
    };
    const engine = new Engine({
      buildId: BUILD,
      database: setup.db,
      externalPollMs: CLOCK.expired,
      programs: [component],
    });
    onTestFinished(async () => {
      await engine.close();
    });
    const session = (await engine.login('alice')).sessionId;
    const root = { build: BUILD, component: component.component, props: {} };
    await engine.poke();
    await engine.render(session, root);
    source.changes.push({
      after: keysOf('other', 'b'),
      before: keysOf('other', 'b'),
      id: 'row',
      seq: 1,
      table: 'items',
    });
    await engine.poke();
    await engine.render(session, root);

    expect(evaluate).toHaveBeenCalledExactlyOnceWith({}, expect.anything());

    await setup.pg.query(`UPDATE items SET "group" = 'b' WHERE id = 'one'`);
    source.changes.push({
      after: keysOf('one', 'b'),
      before: keysOf('one', 'a'),
      id: 'row',
      seq: 2,
      table: 'items',
    });
    await engine.poke();

    expect(textOf((await engine.render(session, root)).tree)).toBe('');
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('follows a retained shared route after its memo has expired', async () => {
    const source = log();
    const setup = await followedItems(source);
    let now = CLOCK.start;
    const component: ComponentProgram = {
      buildId: BUILD,
      component: 'components/shared-external-record',
      evaluate: async (_props, $) => $.h('p', null, await titleOfOne(setup)),
      protocolVersion: PROTOCOL_VERSION,
      updaters: {},
      writable: [],
    };
    const engine = new Engine({
      buildId: BUILD,
      clock: () => now,
      database: setup.db,
      externalPollMs: CLOCK.tick,
      programs: [component],
      routes: [
        {
          blocking: true,
          middleware: [],
          page: 'items/[id]/page.tsx',
          params: ['id'],
          props: { id: 'id' },
          root: component.component,
          route: '/items/[id]',
          shared: true,
        },
      ],
    });
    onTestFinished(async () => {
      await engine.close();
    });
    await engine.poke();
    const ask = async () => {
      return engine.renderShared(null, {
        build: BUILD,
        props: { id: 'one' },
        route: '/items/[id]',
      });
    };

    expect(textOf((await ask()).result.tree)).toBe('first');
    expect((await engine.stats()).sharedViews).toBe(1);

    await nextTurn();
    now += CLOCK.expired;
    await setup.pg.query("UPDATE items SET title = 'shared-second' WHERE id = 'one'");
    const one = keysOf('one', 'a');
    source.changes.push({ after: one, before: one, id: 'row', seq: 1, table: 'items' });

    await engine.pollExternal();

    await vi.waitFor(async () => {
      expect(textOf((await ask()).result.tree)).toBe('shared-second');
    });
  });
});
