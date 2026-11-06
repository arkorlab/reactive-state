import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Dependencies, type RowChange } from '../src/authority/dependencies.ts';
import { ExternalTail } from '../src/authority/external-tail.ts';
import {
  type ExternalChange,
  ExternalFollower,
  externalFind,
  externalGet,
  type ExternalStore,
} from '../src/authority/external.ts';
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
import { database, definitionOf, json, table, text } from '../src/server/schema.ts';
import { textOf } from './support/frames.ts';

/** The application's records, held by its store alone. */
const db = database({
  items: table({ title: text(), group: text(), document: json() }, { external: 'remote' }),
});
const declared = definitionOf(db).tables.get('items');
if (declared === undefined) throw new Error('The test declares items.');
const tables = definitionOf(db).tables;
const ITEMS = { name: 'items', table: declared };
const CLOCK = { start: 1000, tick: 100, expired: 31_000 } as const;
const BUILD = 'b_external';
const LOG_PAGE = 200;

/** A store whose records and log the application changes without writing to the authority. */
function remote() {
  const records = new Map([
    ['one', { title: 'first', group: 'a', document: { nested: ['original'] } }],
  ]);
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
  const store: ExternalStore = {
    changes: readLog,
    count: () => Promise.resolve(records.size),
    find: () => Promise.resolve([...records].map(([id, values]) => ({ id, values }))),
    get: (_table, id) => {
      const values = records.get(id);
      return Promise.resolve(values === undefined ? null : { id, values });
    },
  };
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
    records,
    store,
  };
}

/** The test's one required record. */
function oneOf(source: ReturnType<typeof remote>) {
  const record = source.records.get('one');
  if (record === undefined) throw new Error('The test has one record.');
  return record;
}

describe('external stores', () => {
  it('refuses a host without the store or with no interval before it opens the database', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'reactive-state-external-'));
    onTestFinished(async () => {
      await rm(dir, { force: true, recursive: true });
    });
    const filename = path.join(dir, 'authority.sqlite');
    const opened = { buildId: BUILD, database: db, filename, programs: [] };

    expect(() => new Engine(opened)).toThrow('`stores.remote`');
    expect(
      () => new Engine({ ...opened, externalPollMs: 0, stores: { remote: remote().store } }),
    ).toThrow('externalPollMs');

    const kept = new DatabaseSync(filename);
    onTestFinished(() => {
      kept.close();
    });

    expect(kept.prepare('SELECT name FROM sqlite_master').all()).toStrictEqual([]);
  });

  it('does not commit an unchanged log', async () => {
    const source = remote();
    const engine = new Engine({
      buildId: BUILD,
      database: db,
      programs: [],
      stores: { remote: source.store },
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
    const source = remote();
    let now = CLOCK.start;
    const child: ComponentProgram = {
      buildId: BUILD,
      component: 'components/external-child',
      protocolVersion: PROTOCOL_VERSION,
      evaluate: async (_props, $) => $.h('p', null, (await db.items.get('one'))?.title),
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
      database: db,
      externalPollMs: CLOCK.tick,
      programs: [root, child],
      stores: { remote: source.store },
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

    oneOf(source).title = 'after idle';

    expect(textOf((await engine.render(session, request)).tree)).toBe('after idle');
  });

  it('keeps the cursor until its changes have been ingested', async () => {
    const source = remote();
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
    { what: 'corrected record', before: { title: 1 }, after: { title: 'corrected' } },
    { what: 'deleted invalid record', before: { title: 1 }, after: null },
    { what: 'invalid after image', before: { title: 'before' }, after: { title: 1 } },
  ])('invalidates an invalid historical $what and continues to later changes', async (image) => {
    const source = remote();
    const follower = new ExternalFollower(source.store, tables);
    await follower.changed();
    const dependencies = new Dependencies();
    dependencies.query('items', { title: 'any prior predicate' });
    source.changes.push({ ...image, id: 'one', seq: 1, table: 'items' });

    const changed = await follower.changed();

    expect(changed).toMatchObject([{ id: 'one', unknown: 'fields' }]);
    expect(dependencies.changedBy(changed)).toBe(true);

    source.changes.push({
      before: { title: 'corrected' },
      after: { title: 'later' },
      id: 'two',
      seq: 2,
      table: 'items',
    });

    await expect(follower.changed()).resolves.toMatchObject([
      { id: 'two', after: { title: 'later' } },
    ]);
    expect(source.readLog.mock.calls.at(-1)?.[0]).toBe(1);
  });

  it('invalidates every dependency when a log is replaced or pruned past its cursor', async () => {
    const source = remote();
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
    const source = remote();
    source.changes.push({ seq: 2, table: 'items', id: 'one' });
    const follower = new ExternalFollower(source.store, tables);
    await follower.changed();
    source.changes.length = 0;

    await expect(follower.changed()).resolves.toMatchObject([{ table: 'items', unknown: 'table' }]);
  });

  it('rejects malformed log metadata and replays the same cursor after recovery', async () => {
    const source = remote();
    const follower = new ExternalFollower(source.store, tables);
    await follower.changed();
    source.readLog.mockResolvedValueOnce({ changes: [], epoch: 'initial', floor: 0, head: NaN });

    await expect(follower.changed()).rejects.toThrow('valid head');

    source.changes.push({ seq: 1, table: 'items', id: 'one' });

    await expect(follower.changed()).resolves.toMatchObject([{ id: 'one' }]);
  });

  it('recovers a coalesced read even when the read ahead of it rejects', async () => {
    const source = remote();
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
    const source = remote();
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
    const source = remote();
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

  it('copies and freezes documents without freezing the store-owned value', async () => {
    const source = remote();
    const read = await externalGet(source.store, ITEMS, 'one');
    const owned = source.records.get('one');
    owned?.document.nested.push('changed later');

    expect(read?.['document']).toStrictEqual({ nested: ['original'] });
    expect(Object.isFrozen(read?.['document'])).toBe(true);
    expect(Object.isFrozen(owned?.document)).toBe(false);
  });

  it('defaults NULL fields but refuses other values outside the declaration', async () => {
    const source = remote();
    const nulls: ExternalStore = {
      ...source.store,
      get: () => Promise.resolve({ id: 'one', values: { title: null, document: null } }),
    };

    await expect(externalGet(nulls, ITEMS, 'one')).resolves.toMatchObject({
      title: '',
      group: '',
      document: null,
    });

    const invalid: ExternalStore = {
      ...source.store,
      get: () => Promise.resolve({ id: 'one', values: { title: 1 } }),
      find: () => Promise.resolve([{ id: 'one', values: { title: 1 } }]),
    };

    await expect(externalGet(invalid, ITEMS, 'one')).rejects.toThrow('external field title');
    await expect(
      externalFind(invalid, ITEMS, { where: {}, orderBy: [], limit: undefined }, undefined),
    ).rejects.toThrow('external field title');
  });

  it('keeps memoized renders current without a connected stream', async () => {
    const source = remote();
    const component: ComponentProgram = {
      buildId: BUILD,
      component: 'components/external-record',
      evaluate: async (_props, $) => $.h('p', null, (await db.items.get('one'))?.title),
      protocolVersion: PROTOCOL_VERSION,
      updaters: {},
      writable: [],
    };
    const engine = new Engine({
      buildId: BUILD,
      database: db,
      externalPollMs: CLOCK.tick,
      programs: [component],
      stores: { remote: source.store },
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
    const current = oneOf(source);
    const before = { ...current };
    current.title = 'second';
    source.changes.push({ after: current, before, id: 'one', seq: 1, table: 'items' });

    await vi.waitFor(async () => {
      expect(textOf((await engine.render(session, root)).tree)).toBe('second');
    });

    expect((await engine.stats()).commits).toBeGreaterThan(0);
  });

  it('evicts only queries whose where predicate a changed record enters or leaves', async () => {
    const source = remote();
    const evaluate = vi.fn(async (_props: Readonly<Record<string, Json>>, $: RenderScope) => {
      const records = await db.items.findMany({ where: { group: 'a' }, limit: 1 });
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
      database: db,
      externalPollMs: CLOCK.expired,
      programs: [component],
      stores: { remote: source.store },
    });
    onTestFinished(async () => {
      await engine.close();
    });
    const session = (await engine.login('alice')).sessionId;
    const root = { build: BUILD, component: component.component, props: {} };
    await engine.poke();
    await engine.render(session, root);
    source.changes.push({
      after: { title: 'unrelated', group: 'b' },
      before: { title: 'old', group: 'b' },
      id: 'other',
      seq: 1,
      table: 'items',
    });
    await engine.poke();
    await engine.render(session, root);

    expect(evaluate).toHaveBeenCalledExactlyOnceWith({}, expect.anything());

    const record = oneOf(source);
    record.group = 'b';
    source.changes.push({
      after: record,
      before: { title: 'first', group: 'a' },
      id: 'one',
      seq: 2,
      table: 'items',
    });
    await engine.poke();

    expect(textOf((await engine.render(session, root)).tree)).toBe('');
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('follows a retained shared route after its memo has expired', async () => {
    const source = remote();
    let now = CLOCK.start;
    const component: ComponentProgram = {
      buildId: BUILD,
      component: 'components/shared-external-record',
      evaluate: async (_props, $) => $.h('p', null, (await db.items.get('one'))?.title),
      protocolVersion: PROTOCOL_VERSION,
      updaters: {},
      writable: [],
    };
    const engine = new Engine({
      buildId: BUILD,
      clock: () => now,
      database: db,
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
      stores: { remote: source.store },
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
    const current = oneOf(source);
    const before = { ...current };
    current.title = 'shared-second';
    source.changes.push({ after: current, before, id: 'one', seq: 1, table: 'items' });

    await engine.pollExternal();

    await vi.waitFor(async () => {
      expect(textOf((await ask()).result.tree)).toBe('shared-second');
    });
  });
});
