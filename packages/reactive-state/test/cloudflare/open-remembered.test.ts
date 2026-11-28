import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { SessionId } from '../../src/client/contract.ts';
import type { AuthorityObject } from '../../src/cloudflare/object.ts';
import { type AuthorityStub, inObject, valueOf } from './helpers.ts';
import { hung, ZC_MIGRATION, zcProgram } from './zero-config-fixture.ts';

/**
 * An object that made its database's change log for this build makes it again as it starts beside
 * its calls, not before them: the log is there, so a first render reads what it reads as it would
 * any time, and what a D1 that answers late (or not at all) would cost is no cost of a page's first
 * byte. An object that never made it waits for it, as the first start of a database must.
 */

const db = env.REACTIVE_D1;
const ROOT = { build: zcProgram.buildId, component: zcProgram.component, props: {} };
/** How long a test's session lives. */
const LIFETIME_MS = 60_000;
/** How long the start waits for a log, at most, which a start that waits would take. */
const OPEN_WAIT_MS = 10_000;
/** Far less than that: a call that does not wait for the log answers within it, loaded or not. */
const PROMPT_MS = 4000;

/** An object of the hung start's namespace, its alarm deleted as the test ends. */
function objectOf(): AuthorityStub {
  const stub = env.HUNG_START.getByName(crypto.randomUUID()) as unknown as AuthorityStub;
  onTestFinished(async () => {
    await inObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  });
  return stub;
}

/**
 * How long a render takes of a new start of `stub`'s object, which finds the storage the one before
 * left and none of its memory, as Cloudflare starts an object it evicted: made in the object, over
 * its own state, as an eviction cannot be told to a test.
 */
async function restarted(
  stub: AuthorityStub,
  session: SessionId,
): Promise<{ took: number; revision: number }> {
  return inObject(stub, async (instance, state) => {
    const Start = instance.constructor as new (
      ctx: DurableObjectState,
      environment: typeof env,
    ) => AuthorityObject;
    const fresh = new Start(state, env);
    const started = Date.now();
    const rendered = valueOf(await fresh.render(session, ROOT));
    return { revision: rendered.frame.revision, took: Date.now() - started };
  });
}

describe('the change log of an object that made it before', () => {
  beforeEach(async () => {
    for (const table of ['zc_tasks', '_rs_changes', '_rs_meta']) {
      await db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    await db.exec(ZC_MIGRATION);
    hung.mode = 'make';
    hung.made = 0;
    onTestFinished(() => {
      hung.mode = 'hang';
    });
  });

  it(
    'is made again beside the first calls of its next start, which wait for none of it',
    { timeout: 40_000 },
    async () => {
      const stub = objectOf();
      const session = { expires: Date.now() + LIFETIME_MS, id: 'zero-config', user: 'alice' };
      valueOf(await stub.render(session, ROOT));
      // D1 answers the making of the log no more, as of a start in the middle of a deploy.
      hung.mode = 'hang';

      const { revision, took } = await restarted(stub, session);

      expect(took).toBeLessThan(PROMPT_MS);
      expect(revision).toBe(0);
    },
  );

  it(
    'arms the alarm that prunes it where a runtime calls the start’s callback before the constructor ends',
    { timeout: 40_000 },
    async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      onTestFinished(() => {
        errors.mockRestore();
      });
      const stub = objectOf();
      const session = { expires: Date.now() + LIFETIME_MS, id: 'zero-config', user: 'alice' };
      valueOf(await stub.render(session, ROOT));

      const armed = await inObject(stub, async (instance, state) => {
        // Of no alarm a start before left armed: only the start's own callback can arm one here.
        await state.storage.deleteAlarm();
        // workerd calls `blockConcurrencyWhile`'s callback after the constructor ends; the object
        // does not rest on that, so a runtime that calls it at once finds all it reads made.
        const atOnce = vi
          .spyOn(state, 'blockConcurrencyWhile')
          .mockImplementation(async (callback) => callback());
        const Start = instance.constructor as new (
          ctx: DurableObjectState,
          environment: typeof env,
        ) => AuthorityObject;
        const fresh = new Start(state, env);
        atOnce.mockRestore();
        await vi.waitFor(async () => {
          await expect(state.storage.getAlarm()).resolves.not.toBeNull();
        });
        return valueOf(await fresh.render(session, ROOT));
      });

      expect(armed.frame.revision).toBe(0);
      expect(errors).not.toHaveBeenCalledWith(expect.stringContaining('could not be armed'));
    },
  );

  it(
    'is taken for unmade where its making again fails, and asked for by the next call as it was',
    { timeout: 40_000 },
    async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      onTestFinished(() => {
        errors.mockRestore();
      });
      const stub = objectOf();
      const session = { expires: Date.now() + LIFETIME_MS, id: 'zero-config', user: 'alice' };
      valueOf(await stub.render(session, ROOT));
      hung.mode = 'fail';
      hung.made = 0;

      const made = await inObject(stub, async (instance, state) => {
        const Start = instance.constructor as new (
          ctx: DurableObjectState,
          environment: typeof env,
        ) => AuthorityObject;
        const fresh = new Start(state, env);
        valueOf(await fresh.render(session, ROOT));
        await vi.waitFor(() => {
          expect(errors).toHaveBeenCalledWith(expect.stringContaining('made again'));
        });
        const failed = hung.made;
        hung.mode = 'make';
        valueOf(await fresh.render(session, ROOT));
        return { failed, retried: hung.made };
      });

      expect(made.retried).toBeGreaterThan(made.failed);
    },
  );

  it(
    'is waited for at the first start of an object, where D1 answers no more',
    { timeout: 40_000 },
    async () => {
      hung.mode = 'hang';
      const stub = objectOf();
      const session = { expires: Date.now() + LIFETIME_MS, id: 'zero-config', user: 'alice' };
      const started = Date.now();

      valueOf(await stub.render(session, ROOT));

      expect(Date.now() - started).toBeGreaterThanOrEqual(OPEN_WAIT_MS - 500);
    },
  );
});
