import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { changeCaptureSql } from '../../src/cloudflare/d1-store.ts';
import type { AuthorityObject } from '../../src/cloudflare/object.ts';
import { textOf } from '../support/frames.ts';
import { externalDatabase, externalProgram } from './external-store-fixture.ts';
import { type AuthorityStub, valueOf } from './helpers.ts';

const CLOCK = { tick: 1000, lifetime: 60_000 } as const;
const ROOT = { build: externalProgram.buildId, component: externalProgram.component, props: {} };

/** The test's D1 records, under a name separate from the adapter's own suites. */
async function prepare(): Promise<void> {
  await env.REACTIVE_D1.exec('DROP TABLE IF EXISTS external_items');
  await env.REACTIVE_D1.exec('DROP TABLE IF EXISTS _rs_changes');
  await env.REACTIVE_D1.exec('DROP TABLE IF EXISTS _rs_meta');
  await env.REACTIVE_D1.exec('CREATE TABLE external_items (id TEXT PRIMARY KEY, title TEXT)');
  const ddl = changeCaptureSql(externalDatabase, 'remote', { items: { name: 'external_items' } });
  await env.REACTIVE_D1.batch(ddl.map((sql) => env.REACTIVE_D1.prepare(sql)));
  await env.REACTIVE_D1.prepare('INSERT INTO external_items VALUES (?, ?)')
    .bind('one', 'first')
    .run();
}

/** One authority, its clock advanced before manually running its shared alarm. */
async function opened() {
  await prepare();
  // Ahead of workerd's own clock, by which it runs alarms: none the test arms comes due by itself.
  let now = Date.now() + 3_600_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const stub = env.EXTERNAL_AUTHORITY.getByName(crypto.randomUUID()) as unknown as AuthorityStub &
    Pick<AuthorityObject, 'poke'>;
  onTestFinished(async () => {
    clock.mockRestore();
    await runInDurableObject(stub, async (_object, state) => {
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(stub);
  });
  const session = { expires: now + CLOCK.lifetime, id: 'external-test', user: 'alice' };
  const alarm = async () =>
    runInDurableObject(stub, async (_object, state) => state.storage.getAlarm());
  return {
    advance: () => {
      now += CLOCK.tick;
    },
    alarm,
    now: () => now,
    render: async () => valueOf(await stub.render(session, ROOT)),
    stub,
  };
}

describe('external stores in a Durable Object', () => {
  it('reads its store from env and follows retained renderings on the shared alarm', async () => {
    const { advance, alarm, render, stub } = await opened();
    valueOf(await stub.poke());

    expect(textOf((await render()).tree)).toBe('first');

    await vi.waitFor(async () => {
      await expect(alarm()).resolves.not.toBeNull();
    });
    const before = (await stub.stats()).revision;
    await env.REACTIVE_D1.prepare('UPDATE external_items SET title = ? WHERE id = ?')
      .bind('second', 'one')
      .run();
    advance();

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    expect((await stub.stats()).revision).toBeGreaterThan(before);
    expect(textOf((await render()).tree)).toBe('second');

    await vi.waitFor(async () => {
      await expect(alarm()).resolves.not.toBeNull();
    });
    await runInDurableObject(stub, (_object, state) => {
      const rows = state.storage.sql
        .exec('SELECT id FROM records WHERE tbl = ?', 'items')
        .toArray();

      expect(rows).toStrictEqual([]);
    });
  });

  it('rearms an unavailable store without preventing delivery from taking its own log', async () => {
    const { advance, alarm, now, render, stub } = await opened();
    valueOf(await stub.poke());
    await render();
    await vi.waitFor(async () => {
      await expect(alarm()).resolves.not.toBeNull();
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {
      /* The test asserts this failure below. */
    });
    onTestFinished(() => {
      errors.mockRestore();
    });
    await env.REACTIVE_D1.exec('DROP TABLE _rs_changes');
    advance();

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    expect(errors).toHaveBeenCalledWith(expect.stringContaining('could not be ingested'));

    // The next poll is armed once the handler's writes are confirmed, a turn after it returns.
    await vi.waitFor(async () => {
      await expect(alarm()).resolves.toBeGreaterThan(now());
    });

    await runInDurableObject(stub, (_object, state) => {
      const row = state.storage.sql
        .exec<{ revision: number }>('SELECT revision FROM deliveries WHERE consumer = ?', 'site')
        .one();

      expect(row.revision).toBeGreaterThan(0);
    });
  });
});
