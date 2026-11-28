import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { OperationCall } from '../../src/program.ts';
import { type AuthorityStub, valueOf } from './helpers.ts';
import { APART_MODULE, apart, apartGate, ZC_MIGRATION, zcProgram } from './zero-config-fixture.ts';

/**
 * A server operation of an application whose every table is the application's own (D1) runs apart
 * from the authority's queue in its Durable Object: a render is answered while the operation
 * awaits, and a resend of its id waits for the run and answers its receipt.
 */

const db = env.REACTIVE_D1;
const ROOT = { build: zcProgram.buildId, component: zcProgram.component, props: {} };
/** How long a test's session lives. */
const LIFETIME_MS = 60_000;
/**
 * How long a call that should be answered at once is given, and how long one that should wait is.
 */
const WAIT = { answeredMs: 3000, blockedMs: 300 } as const;

/** What `promise` settles to, or `'waiting'` if it has not within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'waiting'> {
  return Promise.race([
    promise,
    new Promise<'waiting'>((resolve) => {
      setTimeout(() => {
        resolve('waiting');
      }, ms);
    }),
  ]);
}

/** Waits until the operation's code runs, and has read. */
async function started(): Promise<void> {
  await vi.waitFor(() => {
    expect(apart.started).toBe(true);
  });
}

/** The call of the operation that awaits, under an operation id of its own. */
function callOf(): OperationCall {
  return {
    args: [],
    build: zcProgram.buildId,
    module: APART_MODULE,
    name: 'slow',
    operationId: crypto.randomUUID(),
  };
}

/** The application's object, its table made by its own migration, and a session of its own. */
async function opened() {
  await db.exec(ZC_MIGRATION);
  const stub = env.APART.getByName(crypto.randomUUID()) as unknown as AuthorityStub;
  onTestFinished(() => {
    apart.open = true;
  });
  const session = { expires: Date.now() + LIFETIME_MS, id: 'apart', user: 'alice' };
  return { session, stub };
}

describe('a server operation apart from the queue, in a Durable Object', () => {
  beforeEach(async () => {
    apartGate();
    for (const table of ['zc_tasks', '_rs_changes', '_rs_meta']) {
      await db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  });

  it('answers a render while the operation awaits', async () => {
    const { session, stub } = await opened();
    const running = stub.operate(session, callOf());
    await started();

    const rendered = await within(stub.render(session, ROOT), WAIT.answeredMs);
    apart.open = true;

    expect(rendered).not.toBe('waiting');
    await expect(running).resolves.toMatchObject({ ok: true, value: { result: 'done' } });
  });

  it('runs one operation id once when it is sent twice at once', async () => {
    const { session, stub } = await opened();
    const sent = callOf();

    const first = stub.operate(session, sent);
    await started();
    const second = stub.operate(session, sent);
    await within(second, WAIT.blockedMs);
    apart.open = true;
    const answers = [valueOf(await first), valueOf(await second)];

    expect(apart.runs).toBe(1);
    expect(answers[0]).toMatchObject({ deduplicated: false, result: 'done' });
    expect(answers[1]).toStrictEqual({ ...answers[0], deduplicated: true });
  });
});
