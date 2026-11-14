import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { getJson, pageShown, settle } from '../src/delivery/site.ts';

/**
 * An answer refused for its status is given up whole, at once: its body, which nothing reads, is
 * canceled before the request is. The request's time limit and its caller's signal go with the
 * request (`within`): a body left to come in would hold its connection past both, for as long as
 * the server went on sending it, and one read whole would hold the request until it ended — a
 * page's failure would fail its settle only once the request's time ran out, and as a timeout.
 */

const CURSOR = 'https://authority.test/internal/delivery?consumer=site';
const PAGE = 'https://site.test/public';

/**
 * `fetch`, stubbed for this test to answer 503 with a body that never ends, as one a server goes
 * on sending, errored once its request is aborted, as the platform's is; whether it was canceled.
 */
function failing(): () => boolean {
  let canceled = false;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>((_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        cancel: () => {
          canceled = true;
        },
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode('{"error":'));
          init?.signal?.addEventListener(
            'abort',
            () => {
              controller.error(init.signal?.reason);
            },
            { once: true },
          );
        },
      });
      return Promise.resolve(new Response(body, { status: 503 }));
    }),
  );
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return () => canceled;
}

describe('a JSON request answered with a failure', () => {
  it('cancels the body it does not read, and names the status', async () => {
    const canceled = failing();

    await expect(getJson(CURSOR, { timeoutMs: 60_000 })).rejects.toThrow(`${CURSOR}: HTTP 503`);
    expect(canceled()).toBe(true);
  });
});

describe('a page answered with a failure', () => {
  it('fails a read of it at once, naming the status, its body canceled unread', async () => {
    const canceled = failing();

    await expect(pageShown(PAGE, { timeoutMs: 1000 })).rejects.toThrow(`${PAGE}: HTTP 503`);
    expect(canceled()).toBe(true);
  });

  it('fails a settle on it at once, naming the status, its body canceled unread', async () => {
    const canceled = failing();

    await expect(settle(PAGE, 1, { requestTimeoutMs: 1000, timeoutMs: 60_000 })).rejects.toThrow(
      `${PAGE}: HTTP 503`,
    );
    expect(canceled()).toBe(true);
  });
});
