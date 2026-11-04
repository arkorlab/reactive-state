import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { AuthorityEngine } from '../../src/authority/engine.ts';
import { SiteDelivery } from '../../src/cloudflare/delivery.ts';
import { siteOf } from '../../src/cloudflare/env.ts';
import { authorityObject, type PublicPage } from '../../src/cloudflare/index.ts';
import { durableObjectSql } from '../../src/cloudflare/sql.ts';
import { db } from '../support/app/db.ts';
import { application, BUILD, operations, programs } from '../support/program.ts';
import {
  authority,
  type AuthorityStub,
  COUNTER,
  countWith,
  deliveryState,
  type DeliveryState,
  expireBackoff,
  json,
  operate,
  OTHER,
  retitle,
  signIn,
  valueOf,
  write,
} from './helpers.ts';
import { fakeSite } from './site.ts';

/** What the suites' Miniflare binds for the object's requests to its site. */
const TOKEN = 'test-engine-token';
const BYPASS = 'test-access-bypass';

/** The backoff after a first failure: two seconds. */
const FIRST_BACKOFF_MS = 2000;

/**
 * An object that owes its site nothing, its cursor at `cursor`: no alarm, and nothing kept but
 * when the last check of the public page was asked for — no failure, no floor, no check owed.
 */
function nothingOwed(cursor: number): DeliveryState {
  return { alarm: null, cursor, meta: { catch_up_at: expect.any(String) as string } };
}

/** The deployments the object owes a check of their pages, oldest first. */
function owedIn(meta: Readonly<Record<string, string>>): readonly (string | undefined)[] {
  const owed = JSON.parse(meta['catch_up_fresh'] ?? '[]') as readonly {
    readonly deployment?: string;
  }[];
  return owed.map(({ deployment }) => deployment);
}

/** The object, five minutes on from its last check: the next render asks for another. */
async function fiveMinutesOn(stub: AuthorityStub): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE meta SET value = '0' WHERE key = 'catch_up_at'");
  });
}

/** How many changes the object's log holds. */
async function loggedChanges(stub: AuthorityStub): Promise<number> {
  return runInDurableObject(stub, (_instance, state) => {
    const [row] = state.storage.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM changes')
      .toArray();
    return row?.n ?? 0;
  });
}

/** Alice's session on an object whose first commit, `revision` 1, the site was told of. */
async function delivered(stub: AuthorityStub): Promise<string> {
  const alice = await signIn(stub, 'alice');
  valueOf(await write(stub, alice));
  await runDurableObjectAlarm(stub);
  return alice;
}

describe('the change log, delivered from the object’s alarm', () => {
  it('posts the records a delay’s commits published in one request, and settles the public page', async () => {
    const stub = authority();
    const site = fakeSite();
    const alice = await signIn(stub, 'alice');
    for (let writes = 0; writes < 3; writes += 1) {
      valueOf(await write(stub, alice));
    }
    const armed = await deliveryState(stub);

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    expect(armed).toMatchObject({ cursor: 0 });
    expect(armed.alarm).not.toBeNull();
    expect(site.posted).toStrictEqual([
      { body: { changed: ['counters:main'], revision: 3 }, bypass: BYPASS, token: TOKEN },
    ]);
    // Asked for while it showed what it did before, then once more when it showed the change; and
    // once by the check the first render asked for, which found it current.
    expect(site.reads).toStrictEqual([{ bypass: BYPASS }, { bypass: BYPASS }, { bypass: BYPASS }]);
    await expect(deliveryState(stub)).resolves.toStrictEqual(nothingOwed(3));
  });

  it('takes the changes that published nothing without asking the site anything, and lets them go', async () => {
    const stub = authority();
    const site = fakeSite();
    const alice = await signIn(stub, 'alice');
    // The title of one of the todos, and every one of a project's todos completed by a server
    // operation: records of a table with no public field.
    valueOf(await retitle(stub, alice, 'Oat milk'));
    valueOf(await operate(stub, alice, { args: [json('p1')], name: 'completeProject' }));
    const armed = await deliveryState(stub);

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    expect(armed.alarm).not.toBeNull();
    expect(site.fetch).not.toHaveBeenCalled();
    await expect(deliveryState(stub)).resolves.toStrictEqual(nothingOwed(2));
    await expect(loggedChanges(stub)).resolves.toBe(0);
  });

  it('names at most a hundred records in one request, and the rest in the next', async () => {
    const stub = authority();
    const site = fakeSite();
    // More counters than the application has, each changed once: written into the log as the
    // engine writes a change, with the alarm armed as a commit arms it — a minute away, as the
    // suites' Worker arms it, for the test to run it rather than have it fire on its own.
    await runInDurableObject(stub, async (_instance, state) => {
      for (let revision = 1; revision <= 150; revision += 1) {
        state.storage.sql.exec(
          'INSERT INTO changes VALUES (?, ?, ?, ?, ?)',
          revision,
          `event:${String(revision)}`,
          JSON.stringify([`counters:c${String(revision)}`]),
          'state',
          Date.now(),
        );
      }
      state.storage.sql.exec("UPDATE meta SET value = '150' WHERE key = 'revision'");
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    expect(site.posted.map(({ body }) => body)).toStrictEqual([
      {
        changed: Array.from({ length: 100 }, (_, index) => `counters:c${String(index + 1)}`),
        revision: 150,
      },
      {
        changed: Array.from({ length: 50 }, (_, index) => `counters:c${String(index + 101)}`),
        revision: 150,
      },
    ]);
    // None of them is the record the public page shows, which is not asked for.
    expect(site.reads).toStrictEqual([]);
    await expect(deliveryState(stub)).resolves.toStrictEqual({
      alarm: null,
      cursor: 150,
      meta: {},
    });
  });

  it('waits for the public page after a change to the record it shows, and after no other', async () => {
    const stub = authority();
    const site = fakeSite();
    const alice = await signIn(stub, 'alice');
    valueOf(await write(stub, alice, { root: OTHER }));
    await runDurableObjectAlarm(stub);
    const afterOther = site.reads.length;

    valueOf(await write(stub, alice));
    await runDurableObjectAlarm(stub);

    expect(site.posted.map(({ body }) => body)).toStrictEqual([
      { changed: ['counters:other'], revision: 1 },
      { changed: ['counters:main'], revision: 2 },
    ]);
    expect(afterOther).toBe(0);
    expect(site.reads).toHaveLength(2);
    expect(site.shown).toBe(2);
    await expect(deliveryState(stub)).resolves.toStrictEqual(nothingOwed(2));
  });

  it('keeps the cursor where it was when the site refuses, and backs off twice as long each time', async () => {
    const stub = authority();
    const site = fakeSite();
    site.status = 500;
    const alice = await signIn(stub, 'alice');
    valueOf(await write(stub, alice));
    const before = Date.now();

    await runDurableObjectAlarm(stub);
    const first = await deliveryState(stub);
    await expireBackoff(stub);
    await runDurableObjectAlarm(stub);
    const second = await deliveryState(stub);

    expect(first).toMatchObject({
      cursor: 0,
      meta: {
        delivery_backoff_ms: '2000',
        delivery_error: 'https://site.test/api/internal/changes: HTTP 500',
      },
    });
    expect(first.alarm).toBe(Number(first.meta['delivery_retry_at']));
    expect(first.alarm).toBeGreaterThanOrEqual(before + FIRST_BACKOFF_MS);
    expect(second).toMatchObject({ cursor: 0, meta: { delivery_backoff_ms: '4000' } });
    expect(site.posted).toHaveLength(2);
  });

  it('delivers what it failed to once the site takes it, and forgets the failure', async () => {
    const stub = authority();
    const site = fakeSite();
    site.status = 500;
    const alice = await signIn(stub, 'alice');
    valueOf(await write(stub, alice));
    await runDurableObjectAlarm(stub);

    site.status = 200;
    await expireBackoff(stub);
    await runDurableObjectAlarm(stub);

    await expect(deliveryState(stub)).resolves.toStrictEqual(nothingOwed(1));
    expect(site.shown).toBe(1);
  });

  it('puts an alarm that comes before the backoff’s floor back to it, without a request', async () => {
    const stub = authority();
    const site = fakeSite();
    site.status = 500;
    const alice = await signIn(stub, 'alice');
    valueOf(await write(stub, alice));
    await runDurableObjectAlarm(stub);
    site.fetch.mockClear();

    await runDurableObjectAlarm(stub);
    const { alarm, meta } = await deliveryState(stub);

    expect(site.fetch).not.toHaveBeenCalled();
    expect(alarm).toBe(Number(meta['delivery_retry_at']));
    expect(meta).toMatchObject({ delivery_backoff_ms: '2000' });
  });

  it('arms its alarm again when it starts with a change the site was not told of', async () => {
    const stub = authority();
    fakeSite();
    const alice = await delivered(stub);
    valueOf(await write(stub, alice));
    // As a pause consumes an alarm: gone, with the change still owed.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });

    // An eviction waits for every timer the object has still to fire: a request's time limit left
    // behind once it was answered would hold this up past the test's own (`delivery/site.ts`).
    await evictDurableObject(stub);
    await stub.stats();

    await expect.poll(async () => (await deliveryState(stub)).alarm).not.toBeNull();
    await expect(deliveryState(stub)).resolves.toMatchObject({ cursor: 1 });
  });

  it('arms nothing when it starts with nothing owed', async () => {
    const stub = authority();
    fakeSite();
    await delivered(stub);

    await evictDurableObject(stub);
    await stub.stats();

    await expect(deliveryState(stub)).resolves.toMatchObject({ alarm: null, cursor: 1 });
  });
});

describe('a deployment’s public page, caught up', () => {
  it('hears of a new deployment whose page renders a registered route’s root, as of one that renders any root', async () => {
    const stub = authority();
    fakeSite();

    // The counter's route, as its page renders it: a counter there is not, refused by its root.
    valueOf(
      await stub.renderShared(
        null,
        { build: BUILD, props: { id: 'missing' }, route: '/counters/[id]' },
        { deployment: 'dpl_routes' },
      ),
    );

    await expect(deliveryState(stub)).resolves.toMatchObject({
      meta: { caller_deployments: '["dpl_routes"]' },
    });
  });

  it('delivers the record again to a new deployment whose page shows an older revision', async () => {
    const stub = authority();
    const site = fakeSite();
    const alice = await delivered(stub);
    const posted = site.posted.length;
    // The new deployment's page, rendered when it was built: before the change.
    site.shown = 0;

    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_second' }));
    const armed = await deliveryState(stub);
    await runDurableObjectAlarm(stub);

    expect(armed.alarm).not.toBeNull();
    expect(site.posted.slice(posted)).toStrictEqual([
      { body: { changed: ['counters:main'], revision: 1 }, bypass: BYPASS, token: TOKEN },
    ]);
    expect(site.shown).toBe(1);
    await expect(deliveryState(stub)).resolves.toMatchObject({
      alarm: null,
      meta: { caller_deployments: '["dpl_second"]' },
    });
  });

  it('asks a new deployment for its page once, and posts nothing when it is current', async () => {
    const stub = authority();
    const site = fakeSite();
    const alice = await delivered(stub);
    const posted = site.posted.length;
    const reads = site.reads.length;

    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_current' }));
    await runDurableObjectAlarm(stub);

    expect(site.posted).toHaveLength(posted);
    expect(site.reads).toHaveLength(reads + 1);
  });

  it('checks the page against the last change to the record it shows, and to no other', async () => {
    const stub = authority();
    const site = fakeSite();
    const alice = await delivered(stub);
    // A change to a counter the page does not show, which leaves it at revision 1.
    valueOf(await write(stub, alice, { root: OTHER }));
    await runDurableObjectAlarm(stub);
    const posted = site.posted.length;
    const reads = site.reads.length;

    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_third' }));
    await runDurableObjectAlarm(stub);

    expect(site.shown).toBe(1);
    expect(site.posted).toHaveLength(posted);
    expect(site.reads).toHaveLength(reads + 1);
    await expect(deliveryState(stub)).resolves.toStrictEqual({
      alarm: null,
      cursor: 2,
      meta: { caller_deployments: '["dpl_third"]', catch_up_at: expect.any(String) as string },
    });
  });

  it('gives a check up that fails, holding no delivery back, and keeps why', async () => {
    const stub = authority();
    const site = fakeSite();
    const alice = await delivered(stub);
    site.pageStatus = 500;

    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_failing' }));
    await runDurableObjectAlarm(stub);

    const { alarm, meta } = await deliveryState(stub);

    // Owed still to the new deployment, it is checked again a minute on.
    expect(alarm).toBe(Number(meta['catch_up_owed_at']));
    expect(meta).toMatchObject({ catch_up_error: 'https://site.test/public: HTTP 500' });
    expect(Object.keys(meta)).not.toContain('catch_up_due');
    expect(Object.keys(meta)).not.toContain('delivery_retry_at');
    expect(Object.keys(meta)).not.toContain('delivery_backoff_ms');
  });

  it('renders a new deployment’s page of records that never changed again, once', async () => {
    const stub = authority();
    const site = fakeSite();
    const alice = await signIn(stub, 'alice');

    // Its build seeded `counters:main` as the declaration says now, which the record the object
    // kept from before need not hold: the page renders it again from the object, once, its render
    // started by the object asking for it.
    const reads = site.reads.length;
    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_reseeded' }));
    await runDurableObjectAlarm(stub);
    const once = [...site.posted];
    const asked = site.reads.length - reads;
    // The same deployment's check five minutes on asks for nothing again.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET value = '0' WHERE key = 'catch_up_at'");
    });
    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_reseeded' }));
    await runDurableObjectAlarm(stub);

    expect(once).toStrictEqual([
      { body: { changed: ['counters:main'], revision: 0 }, bypass: BYPASS, token: TOKEN },
    ]);
    // Once to learn which deployment serves it, and once to start the render.
    expect(asked).toBe(2);
    expect(site.posted).toStrictEqual(once);
    await expect(deliveryState(stub)).resolves.toMatchObject({ alarm: null });
    await expect(deliveryState(stub)).resolves.not.toMatchObject({
      meta: { catch_up_fresh: expect.any(String) as string },
    });
  });

  it('renders a new deployment’s page again at the next check, where the first one failed', async () => {
    const stub = authority();
    const site = fakeSite();
    const alice = await signIn(stub, 'alice');
    site.status = 500;

    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_unsteady' }));
    await runDurableObjectAlarm(stub);
    const failed = site.posted.length;
    // Five minutes on, with the site answering again.
    site.status = 200;
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET value = '0' WHERE key = 'catch_up_at'");
    });
    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_unsteady' }));
    await runDurableObjectAlarm(stub);

    expect(failed).toBe(1);
    expect(site.posted.slice(failed)).toStrictEqual([
      { body: { changed: ['counters:main'], revision: 0 }, bypass: BYPASS, token: TOKEN },
    ]);
    await expect(deliveryState(stub)).resolves.not.toMatchObject({
      meta: { catch_up_fresh: expect.any(String) as string },
    });
  });

  it('renders a new deployment’s page again by that deployment alone, owed still where another answers', async () => {
    const stub = authority();
    const site = fakeSite();
    const alice = await signIn(stub, 'alice');
    // The project's hostname serves the deployment before until the switch reaches every location.
    site.deployment = 'dpl_before';

    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_switched' }));
    await runDurableObjectAlarm(stub);
    const owed = await deliveryState(stub);
    // Five minutes on, the hostname serves the new one.
    site.deployment = 'dpl_switched';
    await fiveMinutesOn(stub);
    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_switched' }));
    await runDurableObjectAlarm(stub);

    expect(owed.meta['catch_up_error']).toBe(
      'https://site.test/public: answered by dpl_before, whose pages are owed no check; owed still: dpl_switched',
    );
    expect(owedIn(owed.meta)).toStrictEqual(['dpl_switched']);
    // The deployment before, owed no check, has none of its pages rendered again.
    expect(site.posted.map(({ body }) => body)).toStrictEqual([
      { changed: ['counters:main'], revision: 0 },
    ]);

    const { meta } = await deliveryState(stub);

    expect(owedIn(meta)).toStrictEqual([]);
    expect(Object.keys(meta)).not.toContain('catch_up_error');
  });

  it('owes each of two deployments heard from before its alarm a check of its own, done by its own answers', async () => {
    const stub = authority();
    const site = fakeSite();
    const alice = await signIn(stub, 'alice');

    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_a' }));
    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_b' }));
    site.deployment = 'dpl_b';
    await runDurableObjectAlarm(stub);
    const first = await deliveryState(stub);
    site.deployment = 'dpl_a';
    await fiveMinutesOn(stub);
    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_a' }));
    await runDurableObjectAlarm(stub);

    expect(owedIn(first.meta)).toStrictEqual(['dpl_a']);
    expect(site.posted.map(({ body }) => body)).toStrictEqual([
      { changed: ['counters:main'], revision: 0 },
      { changed: ['counters:main'], revision: 0 },
    ]);
    await expect(deliveryState(stub)).resolves.not.toMatchObject({
      meta: { catch_up_fresh: expect.any(String) as string },
    });
  });

  it('checks a new deployment’s page of a record that changed by that deployment’s answers alone', async () => {
    const stub = authority();
    const site = fakeSite();
    const alice = await delivered(stub);
    const posted = site.posted.length;
    // The page the hostname serves shows the change, but it is the deployment before's.
    site.deployment = 'dpl_before';

    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_switched' }));
    await runDurableObjectAlarm(stub);
    const { meta } = await deliveryState(stub);

    expect(site.posted).toHaveLength(posted);
    expect(owedIn(meta)).toStrictEqual(['dpl_switched']);
    expect(meta['catch_up_error']).toBe(
      'https://site.test/public: answered by dpl_before, whose pages are owed no check; owed still: dpl_switched',
    );
  });

  it('checks again a minute on what is owed still, though no render asks for it', async () => {
    const stub = authority();
    const site = fakeSite();
    const alice = await signIn(stub, 'alice');
    site.deployment = 'dpl_before';

    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_switched' }));
    await runDurableObjectAlarm(stub);
    const owed = await deliveryState(stub);
    // A minute on, the hostname serves the new deployment; no render comes.
    site.deployment = 'dpl_switched';
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET value = '0' WHERE key = 'catch_up_owed_at'");
    });
    await runDurableObjectAlarm(stub);

    expect(owed.alarm).toBe(Number(owed.meta['catch_up_owed_at']));
    expect(site.posted.map(({ body }) => body)).toStrictEqual([
      { changed: ['counters:main'], revision: 0 },
    ]);
    await expect(deliveryState(stub)).resolves.toMatchObject({ alarm: null });
    await expect(deliveryState(stub)).resolves.not.toMatchObject({
      meta: { catch_up_owed_at: expect.any(String) as string },
    });
    await expect(deliveryState(stub)).resolves.not.toMatchObject({
      meta: { catch_up_fresh: expect.any(String) as string },
    });
  });

  it('gives a check up that was owed for an hour, which the hostname never answered', async () => {
    const stub = authority();
    const site = fakeSite();
    const alice = await signIn(stub, 'alice');
    site.deployment = 'dpl_live';
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO meta VALUES (\'catch_up_fresh\', \'[{"at":0,"deployment":"dpl_gone","pages":[]}]\')',
      );
    });

    valueOf(await stub.render(alice, COUNTER));
    await runDurableObjectAlarm(stub);
    const { meta } = await deliveryState(stub);

    expect(owedIn(meta)).toStrictEqual([]);
    expect(Object.keys(meta)).not.toContain('catch_up_error');
  });

  it('hears from each of two deployments serving at once a single time, however they alternate', async () => {
    const stub = authority();
    const site = fakeSite();
    const alice = await signIn(stub, 'alice');

    for (const deployment of ['dpl_old', 'dpl_new', 'dpl_old', 'dpl_new']) {
      valueOf(await stub.render(alice, COUNTER, { deployment }));
      await runDurableObjectAlarm(stub);
    }

    // Each new deployment's page of a record that never changed is rendered again once, and no more.
    expect(site.posted.map(({ body }) => body)).toStrictEqual([
      { changed: ['counters:main'], revision: 0 },
      { changed: ['counters:main'], revision: 0 },
    ]);
    await expect(deliveryState(stub)).resolves.toMatchObject({
      meta: { caller_deployments: '["dpl_old","dpl_new"]' },
    });
  });

  it('asks for no check for a deployment it heard from within five minutes', async () => {
    const stub = authority();
    fakeSite();
    const alice = await delivered(stub);
    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_same' }));
    await runDurableObjectAlarm(stub);

    valueOf(await stub.render(alice, COUNTER, { deployment: 'dpl_same' }));
    valueOf(await stub.render(alice, COUNTER));

    await expect(deliveryState(stub)).resolves.toMatchObject({ alarm: null });
  });
});

describe('the public pages a delivery waits for', () => {
  it('tells the site of each change, and neither waits for a page nor checks one, given none', async () => {
    const site = fakeSite();
    const seen = await runInDurableObject(authority(), async (_instance, state) => {
      const sql = durableObjectSql(state.storage);
      const engine = new AuthorityEngine({ ...application, sql });
      const delivery = new SiteDelivery({
        delayMs: 60_000,
        engine,
        env,
        pages: [],
        sql,
        storage: state.storage,
      });
      const { sessionId } = await engine.login('alice');
      await countWith(engine, sessionId);

      await delivery.noteCaller({ deployment: 'dpl_new' });
      await delivery.run();
      return {
        alarm: await state.storage.getAlarm(),
        cursor: await engine.delivery('site'),
        due: sql.get("SELECT value FROM meta WHERE key = 'catch_up_due'"),
      };
    });

    expect(site.posted.map(({ body }) => body)).toStrictEqual([
      { changed: ['counters:main'], revision: 1 },
    ]);
    expect(site.reads).toStrictEqual([]);
    expect(seen).toStrictEqual({ alarm: null, cursor: 1, due: undefined });
  });

  it('waits for each page for the records it shows, and checks each whatever another’s check did', async () => {
    const site = fakeSite({ '/other': 'counters:other' });
    const other = site.page('/other');
    const kept = await runInDurableObject(authority(), async (_instance, state) => {
      const sql = durableObjectSql(state.storage);
      const engine = new AuthorityEngine({ ...application, sql });
      const delivery = new SiteDelivery({
        delayMs: 60_000,
        engine,
        env,
        // The page whose check fails first: the one after it is checked all the same.
        pages: [
          { path: '/other', resources: ['counters:other'] },
          { path: '/public', resources: ['counters:main'] },
        ],
        sql,
        storage: state.storage,
      });
      const { sessionId } = await engine.login('alice');
      for (const root of [COUNTER, OTHER]) {
        await countWith(engine, sessionId, root);
        await delivery.run();
      }
      const publicReads = site.reads.length;
      // A new deployment, whose public page was rendered before `main`'s change, and whose
      // other page fails.
      site.shown = 0;
      other.status = 500;

      await delivery.noteCaller({ deployment: 'dpl_new' });
      await delivery.run();
      return {
        error: sql.get("SELECT value FROM meta WHERE key = 'catch_up_error'"),
        publicReads,
      };
    });

    expect(site.posted.map(({ body }) => body)).toStrictEqual([
      { changed: ['counters:main'], revision: 1 },
      { changed: ['counters:other'], revision: 2 },
      { changed: ['counters:main'], revision: 1 },
    ]);
    // Asked for after `main`'s change alone, and not after `other`'s, which it does not show.
    expect(kept.publicReads).toBe(2);
    expect(other.shown).toBe(2);
    expect(site.shown).toBe(1);
    expect(kept.error).toStrictEqual({ value: 'https://site.test/other: HTTP 500' });
  });

  it('checks again a minute on the page whose part of what is owed failed, and not a page whose part is done', async () => {
    const site = fakeSite({ '/other': 'counters:other' });
    const other = site.page('/other');
    site.deployment = 'dpl_new';
    const kept = await runInDurableObject(authority(), async (_instance, state) => {
      const sql = durableObjectSql(state.storage);
      const engine = new AuthorityEngine({ ...application, sql });
      const delivery = new SiteDelivery({
        delayMs: 60_000,
        engine,
        env,
        pages: [
          { path: '/public', resources: ['counters:main'] },
          { path: '/other', resources: ['counters:other'] },
        ],
        sql,
        storage: state.storage,
      });
      other.status = 500;
      await delivery.noteCaller({ deployment: 'dpl_new' });
      await delivery.run();
      const first = { posted: site.posted.length, publicReads: site.reads.length };
      const fresh = sql.get("SELECT value FROM meta WHERE key = 'catch_up_fresh'")?.['value'];
      const owed = typeof fresh === 'string' ? fresh : '[]';
      // A minute on, the other page answers; no render comes.
      other.status = 200;
      sql.run("UPDATE meta SET value = '0' WHERE key = 'catch_up_owed_at'");

      await delivery.run();
      return {
        first,
        fresh: sql.get("SELECT value FROM meta WHERE key = 'catch_up_fresh'"),
        owed,
      };
    });

    const owed = JSON.parse(kept.owed) as readonly {
      readonly deployment: string;
      readonly pages: readonly string[];
    }[];

    expect(kept.first.posted).toBe(1);
    // Owed still, its public page's part done.
    expect(owed.map(({ deployment, pages }) => ({ deployment, pages }))).toStrictEqual([
      { deployment: 'dpl_new', pages: ['/public'] },
    ]);
    // The public page, whose part was done, is neither asked for nor rendered again.
    expect(site.reads).toHaveLength(kept.first.publicReads);
    expect(site.posted.map(({ body }) => body)).toStrictEqual([
      { changed: ['counters:main'], revision: 0 },
      { changed: ['counters:other'], revision: 0 },
    ]);
    expect(kept.fresh).toBeUndefined();
  });

  it('looks at a page whose part of what is owed is done for what it is behind on, where a render asks', async () => {
    const site = fakeSite({ '/both': 'counters:other' });
    const both = site.page('/both');
    const fresh = await runInDurableObject(authority(), async (_instance, state) => {
      const sql = durableObjectSql(state.storage);
      const engine = new AuthorityEngine({ ...application, sql });
      const delivery = new SiteDelivery({
        delayMs: 60_000,
        engine,
        env,
        pages: [{ path: '/both', resources: ['counters:main', 'counters:other'] }],
        sql,
        storage: state.storage,
      });
      const { sessionId } = await engine.login('alice');
      for (const root of [COUNTER, OTHER]) {
        await countWith(engine, sessionId, root);
      }
      // Taken by the site already; the page was rendered between the two changes, and its part of
      // the check owed to a new deployment is done.
      await engine.acknowledge('site', 2);
      both.shown = 1;
      sql.run(
        "INSERT INTO meta VALUES ('catch_up_fresh', ?)",
        JSON.stringify([{ at: Date.now(), deployment: 'dpl_new', pages: ['/both'] }]),
      );

      // A render for an application that names no deployment, the first in five minutes.
      await delivery.noteCaller({});
      await delivery.run();
      return sql.get("SELECT value FROM meta WHERE key = 'catch_up_fresh'");
    });

    expect(site.posted.map(({ body }) => body)).toStrictEqual([
      { changed: ['counters:other'], revision: 2 },
    ]);
    expect(both.shown).toBe(2);
    expect(fresh).toBeUndefined();
  });

  it('delivers again the records a page is behind on, and none it shows as they are', async () => {
    const site = fakeSite({ '/both': 'counters:other' });
    const both = site.page('/both');
    await runInDurableObject(authority(), async (_instance, state) => {
      const sql = durableObjectSql(state.storage);
      const engine = new AuthorityEngine({ ...application, sql });
      const delivery = new SiteDelivery({
        delayMs: 60_000,
        engine,
        env,
        pages: [{ path: '/both', resources: ['counters:main', 'counters:other'] }],
        sql,
        storage: state.storage,
      });
      const { sessionId } = await engine.login('alice');
      for (const root of [COUNTER, OTHER]) {
        await countWith(engine, sessionId, root);
      }
      // Taken by the site already; the page was rendered between the two changes.
      await engine.acknowledge('site', 2);
      both.shown = 1;

      await delivery.noteCaller({ deployment: 'dpl_new' });
      await delivery.run();
    });

    expect(site.posted.map(({ body }) => body)).toStrictEqual([
      { changed: ['counters:other'], revision: 2 },
    ]);
    expect(both.shown).toBe(2);
  });

  it.each<[string, PublicPage, string]>([
    ['a path that is not one', { path: 'public', resources: ['counters:main'] }, 'starts with /'],
    ['no record', { path: '/public', resources: [] }, 'names no record'],
    [
      'a record of a table with no public field',
      { path: '/todos', resources: ['todos:t1'] },
      'todos:t1, which is no record',
    ],
    [
      'a record of no table the database declares',
      { path: '/public', resources: ['counter:main'] },
      'counter:main, which is no record',
    ],
  ])('refuses, as the Worker loads, a page that names %s', (_, page, message) => {
    expect(() =>
      authorityObject({ database: db, operations, programs }, { pages: [page] }),
    ).toThrow(message);
  });

  it('refuses, as the Worker loads, a path given twice, whose checks are kept by its path', () => {
    const pages: readonly PublicPage[] = [
      { path: '/public', resources: ['counters:main'] },
      { path: '/public', resources: ['counters:other'] },
    ];

    expect(() => authorityObject({ database: db, operations, programs }, { pages })).toThrow(
      '/public is given twice',
    );
  });
});

describe('where the change log goes', () => {
  it('goes to the site it is given', () => {
    expect(
      siteOf({ REACTIVE_ENGINE_TOKEN: 't', REACTIVE_SITE_URL: 'https://a.test//' }),
    ).toStrictEqual({ bypass: undefined, kind: 'site', origin: 'https://a.test', token: 't' });
  });

  it('takes no host of a platform’s for a site', () => {
    // A host a platform binds by a name of its own says nothing to the object: only the variable
    // the object reads names the site.
    const hosted: Record<string, string> = {
      VERCEL_URL: 'app.example.test',
      REACTIVE_ENGINE_TOKEN: 't',
    };

    expect(siteOf(hosted)).toMatchObject({
      kind: 'disabled',
      reason: expect.stringContaining('REACTIVE_SITE_URL'),
    });
  });

  it('sends a bypass in the header the environment names, and none without one', () => {
    const site = { REACTIVE_ENGINE_TOKEN: 't', REACTIVE_SITE_URL: 'https://a.test' };

    expect(
      siteOf({
        ...site,
        REACTIVE_ACCESS_BYPASS: 'b',
        REACTIVE_ACCESS_BYPASS_HEADER: 'x-test-bypass',
      }),
    ).toMatchObject({ bypass: { header: 'x-test-bypass', value: 'b' }, kind: 'site' });
    expect(siteOf({ ...site, REACTIVE_ACCESS_BYPASS: 'b' })).toMatchObject({
      bypass: undefined,
      kind: 'site',
    });
    expect(siteOf({ ...site, REACTIVE_ACCESS_BYPASS_HEADER: 'x-test-bypass' })).toMatchObject({
      bypass: undefined,
      kind: 'site',
    });
  });

  it('refuses a bypass header that is no header name, and says so', () => {
    expect(
      siteOf({
        REACTIVE_ACCESS_BYPASS: 'b',
        REACTIVE_ACCESS_BYPASS_HEADER: 'not a header',
        REACTIVE_ENGINE_TOKEN: 't',
        REACTIVE_SITE_URL: 'https://a.test',
      }),
    ).toMatchObject({
      kind: 'disabled',
      reason: expect.stringContaining('REACTIVE_ACCESS_BYPASS_HEADER'),
    });
  });

  it('goes nowhere without a site, a token, or a URL, and says which', () => {
    expect(siteOf({ REACTIVE_ENGINE_TOKEN: 't' })).toMatchObject({
      kind: 'disabled',
      reason: expect.stringContaining('REACTIVE_SITE_URL'),
    });
    expect(
      siteOf({ REACTIVE_ENGINE_TOKEN: ' ', REACTIVE_SITE_URL: 'https://a.test' }),
    ).toMatchObject({
      kind: 'disabled',
      reason: expect.stringContaining('REACTIVE_ENGINE_TOKEN'),
    });
    expect(siteOf({ REACTIVE_ENGINE_TOKEN: 't', REACTIVE_SITE_URL: 'not a url' })).toMatchObject({
      kind: 'disabled',
    });
  });

  it('keeps why it delivers nothing, and asks nothing of anyone', async () => {
    const site = fakeSite();
    const kept = await runInDurableObject(authority(), async (_instance, state) => {
      const sql = durableObjectSql(state.storage);
      const engine = new AuthorityEngine({ ...application, sql });
      const delivery = new SiteDelivery({
        delayMs: 1,
        engine,
        env: {},
        pages: [{ path: '/public', resources: ['counters:main'] }],
        sql,
        storage: state.storage,
      });
      await delivery.run();
      return sql.get("SELECT value FROM meta WHERE key = 'delivery_disabled'");
    });

    expect(kept).toStrictEqual({ value: expect.stringContaining('REACTIVE_SITE_URL') });
    expect(site.fetch).not.toHaveBeenCalled();
  });
});
