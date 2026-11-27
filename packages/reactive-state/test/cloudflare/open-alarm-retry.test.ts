import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { type AuthorityStub, inObject } from './helpers.ts';
import { armFails, ZC_MIGRATION, zcProgram } from './zero-config-fixture.ts';

/**
 * An object of an application of one call whose storage fails to arm the alarm of its first prune as
 * it starts. The alarm is what prunes the log from then on, and what asks for the log again where it
 * could not be made, unless a delivery or an external store arms one: an object that never tries
 * again prunes nothing for as long as it lives, while the application's writes fill the log. The
 * arming is tried again at the next call that asks for the log, whether or not the log is made.
 */

const db = env.REACTIVE_D1;
/** How long a test's session lives. */
const LIFETIME_MS = 60_000;
/** A route no page serves: a call that asks for the log, and answers none of a page. */
const ROUTE = { build: zcProgram.buildId, props: {}, route: '/none' } as const;

/** A session of Alice's, which lives as long as a test does. */
function sessionOf() {
  return { expires: Date.now() + LIFETIME_MS, id: 'zero-config', user: 'alice' };
}

/**
 * An object of its own, started as its storage fails to arm an alarm — what it says of it, with it
 * — and one whose alarm is deleted as the test ends.
 */
async function startedFailing() {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {
    // What the object says, asserted by the tests.
  });
  const stub = env.ARM_FAILS.getByName(crypto.randomUUID()) as unknown as AuthorityStub;
  armFails.on = true;
  onTestFinished(async () => {
    armFails.on = false;
    errors.mockRestore();
    await inObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  });
  await stub.stats();
  armFails.on = false;
  return { errors, stub };
}

/** A call that asks for the log: of a route no page serves. */
async function asked(stub: AuthorityStub): Promise<void> {
  await inObject(stub, async (instance) => instance.renderShared(sessionOf(), ROUTE));
}

/** When the object's alarm is armed for, or `null`. */
async function alarmOf(stub: AuthorityStub): Promise<number | null> {
  return inObject(stub, async (_instance, state) => state.storage.getAlarm());
}

describe('the alarm of the first prune an object failed to arm as it started', () => {
  beforeEach(async () => {
    for (const table of ['zc_tasks', '_rs_changes', '_rs_meta']) {
      await db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  });

  it('is armed at the next call that asks for the log, which was made as it started', async () => {
    await db.exec(ZC_MIGRATION);
    const { errors, stub } = await startedFailing();

    expect(errors).toHaveBeenCalledWith(expect.stringContaining('could not be armed'));
    await expect(alarmOf(stub)).resolves.toBeNull();

    await asked(stub);

    await expect(alarmOf(stub)).resolves.not.toBeNull();
  });

  it('is armed as the log is made, at a call after both failed as the object started', async () => {
    // No table: the log cannot be made, and the alarm cannot be armed.
    const { errors, stub } = await startedFailing();

    expect(errors).toHaveBeenCalledWith(expect.stringContaining('could not be armed'));
    await expect(alarmOf(stub)).resolves.toBeNull();

    await db.exec(ZC_MIGRATION);
    await asked(stub);

    await expect(alarmOf(stub)).resolves.not.toBeNull();
    await expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").first('n'),
    ).resolves.toBeGreaterThan(0);
  });

  it('is tried again while the storage fails, and no more once it is armed', async () => {
    await db.exec(ZC_MIGRATION);
    const { errors, stub } = await startedFailing();
    armFails.on = true;
    await asked(stub);
    armFails.on = false;

    expect(errors.mock.calls.filter(([said]) => String(said).includes('armed'))).toHaveLength(2);
    await expect(alarmOf(stub)).resolves.toBeNull();

    await asked(stub);
    const arming = await inObject(stub, async (instance, state) => {
      const spy = vi.spyOn(state.storage, 'setAlarm');
      try {
        await instance.renderShared(sessionOf(), ROUTE);
        await instance.renderShared(sessionOf(), ROUTE);
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    });

    await expect(alarmOf(stub)).resolves.not.toBeNull();
    expect(arming).toBe(0);
  });
});
