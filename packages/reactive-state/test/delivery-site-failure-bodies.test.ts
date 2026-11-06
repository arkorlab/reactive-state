import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { getJson } from '../src/delivery/site.ts';

/**
 * An answer `getJson` refuses for its status is given up whole: its body, which nothing reads, is
 * canceled before the request is. The request's time limit and its caller's signal go with the
 * request (`within`), and a body left to come in would hold its connection past both, for as long
 * as the server went on sending it.
 */

const CURSOR = 'https://authority.test/internal/delivery?consumer=site';

describe('a JSON request answered with a failure', () => {
  it('cancels the body it does not read, and names the status', async () => {
    let canceled = false;
    // A body that never ends, as one a server goes on sending.
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        canceled = true;
      },
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode('{"error":'));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => Promise.resolve(new Response(body, { status: 503 }))),
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    await expect(getJson(CURSOR, { timeoutMs: 60_000 })).rejects.toThrow(`${CURSOR}: HTTP 503`);
    expect(canceled).toBe(true);
  });
});
