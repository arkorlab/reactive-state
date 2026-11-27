import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { pgTable, text as pgText } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { hostOf } from '../../src/authority/database-host.ts';
import { migrate, reactiveDb } from '../../src/cloudflare/db.ts';
import type { AuthorityObject } from '../../src/cloudflare/object.ts';
import type { SharedRenderRequest } from '../../src/routing.ts';
import { BUILD } from '../support/program.ts';
import {
  type AuthorityStub,
  deliveryState,
  inObject,
  retitle,
  signedIn,
  valueOf,
  write,
} from './helpers.ts';
import {
  slowStart,
  ZC_MIGRATION,
  zcDatabase,
  zcOrm,
  zcProgram,
  zcTasks,
} from './zero-config-fixture.ts';

/**
 * An application of one call in its Durable Object, run in workerd: the object makes its D1's log
 * itself as it starts, follows a write of the application's at its alarm, and prunes the log there;
 * and an object that knows no site lets go of what it would tell none, and shares no view.
 */

const db = env.REACTIVE_D1;
const ROOT = { build: zcProgram.buildId, component: zcProgram.component, props: {} };
/** How long a test's session lives. */
const LIFETIME_MS = 60_000;
/** How far the test's clock moves between two reads of the log: past the object's interval. */
const TICK_MS = 1000;
/** How long the log keeps an entry, by the host's own (`LOG`). */
const KEPT_MS = 3_600_000;
/** How often the object prunes its log. */
const PRUNE_EVERY_MS = 600_000;
/** How long the object's start waits for its log at most, past which calls go on. */
const OPEN_WAIT_MS = 10_000;
/** The route the test application shares, and the counter `main`'s view of it. */
const ROUTE = '/counters/[id]';
const MAIN: SharedRenderRequest = { build: BUILD, props: { id: 'main' }, route: ROUTE };

/** The object's stub, `poke` too, which the application's own code calls after its write. */
type ObjectStub = AuthorityStub & Pick<AuthorityObject, 'poke'>;

/** An object of `namespace`'s own, its alarm deleted as the test ends. */
function objectOf(namespace: DurableObjectNamespace): ObjectStub {
  const stub = namespace.getByName(crypto.randomUUID()) as unknown as ObjectStub;
  onTestFinished(async () => {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  });
  return stub;
}

/** When the object's alarm is armed for, or `null`. */
async function alarmOf(stub: AuthorityStub): Promise<number | null> {
  return runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
}

/** Waits for the object to arm its alarm, as a retained read of its log does. */
async function armed(stub: AuthorityStub): Promise<void> {
  await vi.waitFor(async () => {
    await expect(alarmOf(stub)).resolves.not.toBeNull();
  });
}

/** How many entries the D1's log holds. */
async function logged(): Promise<unknown> {
  return db.prepare('SELECT count(*) AS n FROM _rs_changes').first('n');
}

/**
 * The application's object, its table made by its own migration, of a clock the test moves: ahead
 * of workerd's own, by which it runs alarms, so that none the object arms comes due by itself.
 */
async function opened() {
  await db.exec(ZC_MIGRATION);
  let now = Date.now() + KEPT_MS;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  onTestFinished(() => {
    clock.mockRestore();
  });
  const stub = objectOf(env.ZERO_CONFIG);
  const session = { expires: now + LIFETIME_MS, id: 'zero-config', user: 'alice' };
  return {
    advance: (milliseconds = TICK_MS) => {
      now += milliseconds;
    },
    render: async () => valueOf(await stub.render(session, ROOT)),
    stub,
  };
}

describe('an application of one call, in its Durable Object', () => {
  beforeEach(async () => {
    for (const table of ['zc_tasks', '_rs_changes', '_rs_meta']) {
      await db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  });

  it('makes the log of its D1 as it starts, before a call, which logs a write of the application', async () => {
    const { stub } = await opened();

    // A first call that is no render, as an operation's write may be.
    valueOf(await stub.poke());
    await zcOrm.insert(zcTasks).values({ id: 'a', title: 'Written by the application' });

    await expect(
      db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?")
        .bind('zc_tasks')
        .first('n'),
    ).resolves.toBeGreaterThan(0);
    await expect(
      db.prepare("SELECT after FROM _rs_changes WHERE id = 'row'").first('after'),
    ).resolves.toBe('{"k_id":"a"}');
  });

  it('answers its first call once the log is made, as it starts', async () => {
    await db.exec(ZC_MIGRATION);
    slowStart.made = false;

    await objectOf(env.SLOW_START).stats();

    expect(slowStart.made).toBe(true);
  });

  it(
    'answers its calls of a log whose making ends not, rather than wait past what Cloudflare lets it',
    { timeout: 40_000 },
    async () => {
      await db.exec(ZC_MIGRATION);
      const stub = objectOf(env.HUNG_START);
      const session = { expires: Date.now() + LIFETIME_MS, id: 'zero-config', user: 'alice' };
      const started = Date.now();

      await stub.stats();
      const waited = Date.now() - started;
      // A render, and an alarm, which ask for the log again: of no more wait, past its start's.
      const rendered = valueOf(await stub.render(session, ROOT));
      await inObject(stub, async (instance) => {
        await instance.alarm();
      });
      const all = Date.now() - started;

      expect(waited).toBeLessThan(OPEN_WAIT_MS + TICK_MS * 5);
      expect(all).toBeLessThan(OPEN_WAIT_MS + TICK_MS * 5);
      expect(rendered.frame.revision).toBe(0);
    },
  );

  it('arms its alarm to prune the log of none else to arm it, and again after each', async () => {
    await db.exec(ZC_MIGRATION);
    const stub = objectOf(env.ZERO_CONFIG);

    await stub.stats();
    const first = await alarmOf(stub);

    // Run as workerd runs it, which lets go of the alarm it runs: what is armed after is new.
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const again = await alarmOf(stub);

    expect(first).not.toBeNull();
    expect(again).not.toBeNull();
    expect((again ?? 0) - Date.now()).toBeLessThanOrEqual(PRUNE_EVERY_MS);
  });

  it("says why it makes no log before the application's migration, and makes it at a render after it", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {
      // What the object says of the log it could not make, asserted below.
    });
    onTestFinished(() => {
      errors.mockRestore();
    });
    const stub = objectOf(env.ZERO_CONFIG);
    const session = { expires: Date.now() + LIFETIME_MS, id: 'zero-config', user: 'alice' };

    // Asked inside the object, where what it throws is caught: thrown across its RPC, it would be
    // reported as the object's own uncaught exception besides.
    await inObject(stub, async (instance) => {
      await expect(instance.render(session, ROOT)).rejects.toThrow('Failed query');
    });
    await db.exec(ZC_MIGRATION);
    const started = valueOf(await stub.render(session, ROOT));
    await zcOrm.insert(zcTasks).values({ id: 'a', title: 'Logged' });

    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("Run the application's migrations"),
    );
    expect(started.frame.revision).toBe(0);
    await expect(
      db.prepare("SELECT after FROM _rs_changes WHERE id = 'row'").first('after'),
    ).resolves.toBe('{"k_id":"a"}');
  });

  it("makes the log at its alarm after the application's migration, as of a view it follows", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {
      // What the object says of the log it could not make.
    });
    onTestFinished(() => {
      errors.mockRestore();
    });
    const stub = objectOf(env.ZERO_CONFIG);
    // The object started, and its log made not: no table is there yet.
    await stub.stats();

    await db.exec(ZC_MIGRATION);
    await inObject(stub, async (instance) => {
      await instance.alarm();
    });
    await zcOrm.insert(zcTasks).values({ id: 'a', title: 'Logged' });

    await expect(
      db.prepare("SELECT after FROM _rs_changes WHERE id = 'row'").first('after'),
    ).resolves.toBe('{"k_id":"a"}');
  });

  it("makes the log at a route's render after the application's migration, as a routed page's", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {
      // What the object says of the log it could not make.
    });
    onTestFinished(() => {
      errors.mockRestore();
    });
    const stub = objectOf(env.ZERO_CONFIG);
    const session = { expires: Date.now() + LIFETIME_MS, id: 'zero-config', user: 'alice' };
    await stub.stats();

    await db.exec(ZC_MIGRATION);
    // A route's root, as a Next.js route renders it (`shared-root.ts`): of none here, a refusal.
    await inObject(stub, async (instance) => {
      await instance.renderShared(session, { build: zcProgram.buildId, props: {}, route: '/none' });
    });
    await zcOrm.insert(zcTasks).values({ id: 'a', title: 'Logged' });

    await expect(
      db.prepare("SELECT after FROM _rs_changes WHERE id = 'row'").first('after'),
    ).resolves.toBe('{"k_id":"a"}');
  });

  it('renders again what read a write of the application, of its log at its alarm', async () => {
    const { advance, render, stub } = await opened();
    valueOf(await stub.poke());
    await render();
    await armed(stub);
    const before = (await stub.stats()).revision;
    await zcOrm.insert(zcTasks).values({ id: 'a', title: 'Written by the application' });
    advance();

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    expect((await stub.stats()).revision).toBeGreaterThan(before);
    expect(JSON.stringify((await render()).tree)).toContain('Written by the application');
  });

  it('prunes its log from its alarm, of what the log keeps no longer, at most every ten minutes', async () => {
    const { advance, render, stub } = await opened();
    // The object's alarm, run as workerd runs it, whatever armed it.
    const alarmed = async () => {
      return inObject(stub, async (instance) => {
        await instance.alarm();
      });
    };
    await render();
    await zcOrm.insert(zcTasks).values({ id: 'a', title: 'Kept a while' });
    advance(KEPT_MS);

    await alarmed();
    const pruned = await logged();
    await zcOrm.insert(zcTasks).values({ id: 'b', title: 'Kept until the next prune' });
    advance();
    await alarmed();
    const kept = await logged();
    advance(PRUNE_EVERY_MS);
    await alarmed();

    expect({ kept, pruned }).toStrictEqual({ kept: 1, pruned: 0 });
    await expect(logged()).resolves.toBe(0);
  });
});

describe('`./db` in a Worker', () => {
  it("refuses a schema of PostgreSQL's tables, and runs no migration", async () => {
    const items = pgTable('items', { id: pgText().primaryKey() });

    await expect(reactiveDb({ items })).rejects.toThrow(
      "A Worker holds no database of a schema of PostgreSQL's tables",
    );
    await expect(migrate(zcDatabase, 'drizzle')).rejects.toThrow('A Worker runs no migration');
  });

  it('reads the D1 it is named, and refuses one the Worker is not bound', async () => {
    await expect(reactiveDb({ zcTasks }, { binding: 'NO_SUCH_D1' })).rejects.toThrow(
      'NO_SUCH_D1 is no D1 database bound to this Worker',
    );

    const { orm } = await reactiveDb({ zcTasks }, { binding: 'REACTIVE_D1' });
    await db.exec('DROP TABLE IF EXISTS zc_tasks');
    await db.exec(ZC_MIGRATION);
    await orm.insert(zcTasks).values({ id: 'n', title: 'Named' });

    await expect(db.prepare('SELECT title FROM zc_tasks').first('title')).resolves.toBe('Named');
  });

  it("answers a write's own changes, not the rows the log's triggers wrote beside them", async () => {
    const { db: database, orm } = await reactiveDb({ zcTasks });
    for (const table of ['zc_tasks', '_rs_changes', '_rs_meta']) {
      await db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    await db.exec(ZC_MIGRATION);
    await hostOf(database)?.open();

    const inserted = await orm.insert(zcTasks).values({ id: 'a', title: 'one' }).run();
    const own = await db.prepare("UPDATE zc_tasks SET title = 'two' WHERE id = 'a'").run();

    expect(inserted.meta.changes).toBe(1);
    // D1's own count of a write of the table holds the log's row.
    expect(own.meta.changes).toBe(2);
  });
});

describe('an object that knows no site', () => {
  it('lets go of what it would tell no site, and keeps what a site would take', async () => {
    const stub = objectOf(env.SITELESS);
    const { alice } = await signedIn(stub);
    valueOf(await retitle(stub, alice, 'Told nowhere'));
    const told = (await stub.stats()).revision;

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const unpublished = await deliveryState(stub);
    // The counter's count, which the public page shows: a site would take it.
    valueOf(await write(stub, alice));

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const published = await deliveryState(stub);

    expect(unpublished.cursor).toBe(told);
    expect(published.cursor).toBe(told);
    expect(published.meta['delivery_disabled']).toContain('REACTIVE_SITE_URL');
  });

  it('lets go of more than a page of what it would tell no site, at one alarm', async () => {
    const stub = objectOf(env.SITELESS);
    const { alice } = await signedIn(stub);
    valueOf(await retitle(stub, alice, 'Told nowhere'));
    // The commit's own change, again and again: past the thousand a read of the log takes.
    const latest = await inObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500)
         INSERT INTO changes (revision, event_id, changed, kind, created)
         SELECT last.revision + n.i, 'again-' || n.i, last.changed, last.kind, last.created
         FROM n, (SELECT * FROM changes ORDER BY revision DESC LIMIT 1) AS last`,
      );
      // The revision with them, as their commits would have moved it.
      state.storage.sql.exec(
        "UPDATE meta SET value = (SELECT max(revision) FROM changes) WHERE key = 'revision'",
      );
      return state.storage.sql
        .exec<{ top: number }>('SELECT max(revision) AS top FROM changes')
        .one().top;
    });

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    await expect(deliveryState(stub)).resolves.toMatchObject({ cursor: latest });
  });

  it('shares no view, its gate letting each request through to its page', async () => {
    const stub = objectOf(env.SITELESS);

    await expect(stub.renderShared(null, MAIN)).resolves.toMatchObject({
      ok: true,
      value: { kind: 'session' },
    });
    await expect(
      stub.gate({ headers: {}, method: 'GET', route: ROUTE, url: '/counters/main' }),
    ).resolves.toStrictEqual({ ok: true, value: { kind: 'pass' } });
  });
});
