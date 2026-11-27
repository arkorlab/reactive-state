import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { type AuthorityStub, inObject } from './helpers.ts';
import { ZC_MIGRATION, zcProgram } from './zero-config-fixture.ts';

/**
 * An object of an application of one call whose alarm cannot be armed as its log is made. The first
 * prune's alarm is armed where the log is made, which `blockConcurrencyWhile` runs as the object
 * starts: a failure of it thrown there resets the object (Cloudflare's documented behaviour of a
 * callback that throws), and thrown in a call that asked for the log fails that call. The log is made
 * all the same, so the failure is said and the call goes on.
 */

const db = env.REACTIVE_D1;
/** How long a test's session lives. */
const LIFETIME_MS = 60_000;

describe('the alarm the object arms where it makes its log', () => {
  beforeEach(async () => {
    for (const table of ['zc_tasks', '_rs_changes', '_rs_meta']) {
      await db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  });

  it('is said of a storage that fails it, and fails none of the calls that asked for the log', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {
      // What the object says, asserted below.
    });
    onTestFinished(() => {
      errors.mockRestore();
    });
    const stub = env.ZERO_CONFIG.getByName(crypto.randomUUID()) as unknown as AuthorityStub;
    const session = { expires: Date.now() + LIFETIME_MS, id: 'zero-config', user: 'alice' };
    // The object started, and its log made not: no table is there yet.
    await stub.stats();
    await db.exec(ZC_MIGRATION);

    const answered = await inObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      const arming = vi.spyOn(state.storage, 'setAlarm').mockRejectedValue(new Error('storage'));
      try {
        return await instance.renderShared(session, {
          build: zcProgram.buildId,
          props: {},
          route: '/none',
        });
      } finally {
        arming.mockRestore();
        await state.storage.deleteAlarm();
      }
    });

    expect(answered.ok).toBe(false);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('alarm'));
    await expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").first('n'),
    ).resolves.toBeGreaterThan(0);
  });
});
