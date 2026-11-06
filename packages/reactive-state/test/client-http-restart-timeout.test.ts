import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { httpClient } from '../src/client/index.ts';

/** What the client answers for a call that ran out of time. */
const TOO_SLOW = {
  code: 'AUTHORITY_UNAVAILABLE',
  message: 'The authority did not answer in time.',
  ok: false,
  status: 503,
};

/** An authority's address; `fetch` is stubbed, and reaches nothing. */
const URL = 'http://127.0.0.1:1';

/**
 * `fetch` as Node answers it for a port nothing listens on: the connection refused — but a request
 * whose signal has aborted is never sent, and answers the signal's reason, as the Fetch standard
 * has it. What it answers with are the signals it was handed, in order.
 */
function refusing(): readonly AbortSignal[] {
  const signals: AbortSignal[] = [];
  const refused = vi.fn<typeof fetch>((_input, init) => {
    const signal = init?.signal ?? undefined;
    if (signal !== undefined) {
      signals.push(signal);
    }
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason as DOMException);
    }
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
    });
    return Promise.reject(new TypeError('fetch failed', { cause }));
  });
  vi.stubGlobal('fetch', refused);
  return signals;
}

/**
 * A development loop, whose authority is starting again: the client tries the refused port again,
 * waiting between its tries on a timer that runs only as the test runs it. `AbortSignal.timeout`
 * keeps its own time, which is not faked.
 */
function developing(): void {
  vi.stubEnv('NODE_ENV', 'development');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
}

/** Once the signal of the first request made has aborted: the call's own time is up. */
async function timedOut(signals: readonly AbortSignal[]): Promise<void> {
  const [signal] = signals;
  if (signal === undefined) {
    throw new Error('The call made no request.');
  }
  if (!signal.aborted) {
    await new Promise((resolve) => {
      signal.addEventListener('abort', resolve, { once: true });
    });
  }
}

/** What `answer` has settled with once what is under way has run, or that it has not. */
async function settled<T>(answer: Promise<T>): Promise<T | 'pending'> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  return Promise.race([answer, Promise.resolve('pending' as const)]);
}

describe('httpClient, while a development authority starts again', () => {
  it('answers a call once its time is up, though it waits to try again', async () => {
    developing();
    const signals = refusing();
    const client = httpClient({ timeoutMs: 20, token: 'token', url: URL });

    const answer = client.login('alice');
    await timedOut(signals);

    await expect(settled(answer)).resolves.toStrictEqual(TOO_SLOW);
  });

  it('answers an event stream’s opening once its time is up, though it waits to try again', async () => {
    developing();
    refusing();
    const client = httpClient({ timeoutMs: 150, token: 'token', url: URL });

    const answer = client.events('s1', 'subscription');
    // Refused at 0 and at 100: the wait for the third try would end at 200.
    await vi.advanceTimersByTimeAsync(150);

    await expect(settled(answer)).resolves.toStrictEqual(TOO_SLOW);
  });
});
