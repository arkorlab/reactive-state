import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { settle } from '../src/delivery/site.ts';

/**
 * A settle's time is the whole of what it takes, its requests and the waits between them: a wait
 * the time runs out in ends with it, and the page is asked for no more once the time is up — such
 * a request would have none of it left to be answered in, and the delivery behind the settle would
 * wait for it past the time it was given. The clock is faked, so that a request takes none of the
 * time and the settle's own steps alone move it.
 */

const PAGE = 'https://site.test/public';
/** The settle's time. */
const TIMEOUT_MS = 1000;
/** The wait between two requests: a minute, far past the settle's time. */
const POLL_MS = 60_000;

/** `fetch`, stubbed for this test to answer every request with the page at revision 2. */
function stale(): ReturnType<typeof vi.fn<typeof fetch>> {
  const stubbed = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response('<main data-revision="2">public</main>')),
  );
  vi.stubGlobal('fetch', stubbed);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return stubbed;
}

/**
 * A settle of the stale page for revision 3, on a clock that moves only as the test advances it;
 * what it was rejected with so far, none while it was not.
 */
function settling(): () => unknown {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  let given: unknown;
  void settle(PAGE, 3, { pollMs: POLL_MS, timeoutMs: TIMEOUT_MS }).catch((error: unknown) => {
    given = error;
  });
  return () => given;
}

describe('a settle whose time runs out within a wait', () => {
  it('gives up once its time is up, not once the wait would have been over', async () => {
    stale();
    const given = settling();

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);

    expect(given()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);

    expect(given()).toStrictEqual(new Error(`${PAGE} still shows revision 2, not 3`));
  });

  it('asks for the page no more once its time is up', async () => {
    const stubbed = stale();
    const given = settling();

    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(given()).toStrictEqual(new Error(`${PAGE} still shows revision 2, not 3`));
    expect(stubbed).toHaveBeenCalledTimes(1);
  });
});
