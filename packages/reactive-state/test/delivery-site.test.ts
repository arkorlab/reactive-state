import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { answeredBy, pageShown, postJson, settle, shownRevisionOf } from '../src/delivery/site.ts';

const SITE = 'https://site.test';

/** `fetch`, stubbed for this test to answer with `answers` in turn, the last one from then on. */
function answering(
  ...answers: readonly (() => Response)[]
): ReturnType<typeof vi.fn<typeof fetch>> {
  let next = 0;
  const stubbed = vi.fn<typeof fetch>(() => {
    const answer = answers[Math.min(next, answers.length - 1)];
    next += 1;
    return Promise.resolve(answer?.() ?? new Response(null, { status: 500 }));
  });
  vi.stubGlobal('fetch', stubbed);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return stubbed;
}

function page(revision: number): () => Response {
  return () => new Response(`<main data-revision="${String(revision)}">public</main>`);
}

/**
 * A page that renders two records in caches of their own, each marked with its record: `main` at
 * revision 5, and `other` at `other`.
 */
function apart(other: number): () => Response {
  return () => {
    return new Response(
      '<section data-resource="counters:main" data-revision="5">main</section>' +
        `<section data-revision="${String(other)}" data-resource="counters:other">other</section>`,
    );
  };
}

describe('a change delivered to a site', () => {
  it('posts JSON with the headers it is given, and names the status the site refused it with', async () => {
    const stubbed = answering(
      () => new Response('{}'),
      () => new Response('{}', { status: 500 }),
    );
    const request = { headers: { 'x-reactive-internal': 'token' }, timeoutMs: 1000 };

    await postJson(
      `${SITE}/api/internal/changes`,
      { changed: ['counters:main'], revision: 1 },
      request,
    );

    const init = stubbed.mock.calls[0]?.[1];

    expect(init?.body).toBe('{"changed":["counters:main"],"revision":1}');
    expect(init?.headers).toStrictEqual({
      'Content-Type': 'application/json',
      'x-reactive-internal': 'token',
    });
    await expect(postJson(`${SITE}/api/internal/changes`, {}, request)).rejects.toThrow(
      `${SITE}/api/internal/changes: HTTP 500`,
    );
  });

  it('reads the revision a page renders, -1 for none, and refuses a page that failed', async () => {
    answering(
      page(7),
      () => new Response('<main>no revision</main>'),
      () => new Response('gone', { status: 404 }),
    );
    const request = { timeoutMs: 1000 };

    await expect(pageShown(`${SITE}/public`, request)).resolves.toStrictEqual({
      deployment: undefined,
      page: 7,
      records: new Map(),
    });
    await expect(pageShown(`${SITE}/public`, request)).resolves.toMatchObject({ page: -1 });
    await expect(pageShown(`${SITE}/public`, request)).rejects.toThrow(`${SITE}/public: HTTP 404`);
  });

  it('reads the deployment a page and the changes route say they came from, and none where they say none', async () => {
    answering(
      () => new Response('<main data-revision="2"><p data-deployment="dpl_new">public</p></main>'),
      () => Response.json({ deployment: 'dpl_new', revalidated: [] }),
      () => Response.json({ revalidated: [] }),
      () => new Response('taken'),
    );
    const request = { timeoutMs: 1000 };
    const changes = `${SITE}/api/internal/changes`;

    await expect(pageShown(`${SITE}/public`, request)).resolves.toMatchObject({
      deployment: 'dpl_new',
      page: 2,
    });
    expect(answeredBy(await postJson(changes, {}, request))).toBe('dpl_new');
    expect(answeredBy(await postJson(changes, {}, request))).toBeUndefined();
    expect(answeredBy(await postJson(changes, {}, request))).toBeUndefined();
  });

  it('reads the revision of a tag whose quoted attribute holds a `>`, as HTML lets it', async () => {
    answering(() => new Response('<section title="1 > 0" data-revision="5">public</section>'));

    await expect(pageShown(`${SITE}/public`, { timeoutMs: 1000 })).resolves.toMatchObject({
      page: 5,
    });
  });

  it('reads markers quoted either way, or not at all, as HTML lets an attribute be written', async () => {
    const html =
      "<main data-revision='5' data-deployment='dpl_single'>" +
      '<section data-resource=\'counters:main\' data-revision="7">main</section>' +
      '<section DATA-RESOURCE=counters:other data-revision = 3>other</section></main>';
    answering(() => new Response(html));

    const shown = await pageShown(`${SITE}/public`, { timeoutMs: 1000 });

    expect(shown).toMatchObject({ deployment: 'dpl_single', page: 5 });
    expect(shownRevisionOf(shown, 'counters:main')).toBe(7);
    expect(shownRevisionOf(shown, 'counters:other')).toBe(3);
  });

  it('reads a marker that is an attribute of its own alone, its character references read', async () => {
    const html =
      '<!-- <main data-revision="9"> -->' +
      '<main title=\'data-revision="8"\' data-revision="2">' +
      '<section data-resource="todos:a&amp;b&#x27;c" data-revision="4">todo</section></main>';
    answering(() => new Response(html));

    const shown = await pageShown(`${SITE}/public`, { timeoutMs: 1000 });

    expect(shown.page).toBe(2);
    expect(shownRevisionOf(shown, "todos:a&b'c")).toBe(4);
  });

  it('reads no tag in the text of an element HTML reads as text, as a script’s', async () => {
    const html =
      '<SCRIPT>const sample = \'<i data-revision="99">\';</script >' +
      '<style>b::after { content: "<b data-revision=98>"; }</style>' +
      '<title>A <main data-revision="97"> page</title>' +
      '<main data-revision="1">public</main>';
    answering(() => new Response(html));

    await expect(pageShown(`${SITE}/public`, { timeoutMs: 1000 })).resolves.toMatchObject({
      page: 1,
    });
  });

  it('reads the revision of each record a page renders apart, and the page’s own for the rest', async () => {
    answering(apart(3));

    const shown = await pageShown(`${SITE}/public`, { timeoutMs: 1000 });

    expect(shownRevisionOf(shown, 'counters:main')).toBe(5);
    expect(shownRevisionOf(shown, 'counters:other')).toBe(3);
    expect(shownRevisionOf(shown, 'counters:third')).toBe(-1);
  });

  it('waits for the records that changed, each in the rendering that shows it, and for no other', async () => {
    // The first settle is answered at once; the second waits for its record's rendering.
    const stubbed = answering(apart(3), apart(3), apart(4));

    await settle(`${SITE}/public`, 4, { pollMs: 1, records: ['counters:main'], timeoutMs: 1000 });
    await settle(`${SITE}/public`, 4, { pollMs: 1, records: ['counters:other'], timeoutMs: 1000 });

    expect(stubbed).toHaveBeenCalledTimes(3);
  });

  it('asks for the page until it shows the revision, and then no more', async () => {
    const stubbed = answering(page(2), page(3), page(4));

    await settle(`${SITE}/public`, 3, { pollMs: 1, timeoutMs: 1000 });

    expect(stubbed).toHaveBeenCalledTimes(2);
  });

  it('gives up on a page that does not show the revision in time, saying what it showed', async () => {
    answering(page(2));

    await expect(settle(`${SITE}/public`, 3, { pollMs: 1, timeoutMs: 20 })).rejects.toThrow(
      `${SITE}/public still shows revision 2, not 3`,
    );
  });

  it('gives up on a request that hangs once it took a request’s time, long before its own', async () => {
    // A page that never answers: each request waits until it is given up on.
    const hanging = vi.fn<typeof fetch>(async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('given up', { cause: init.signal?.reason }));
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal('fetch', hanging);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const started = Date.now();

    await expect(
      settle(`${SITE}/public`, 1, { requestTimeoutMs: 50, timeoutMs: 60_000 }),
    ).rejects.toThrow('given up');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(hanging).toHaveBeenCalledExactlyOnceWith(
      `${SITE}/public`,
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('fails at once on a page that answers with a failure, rather than asking until its time is up', async () => {
    const stubbed = answering(() => new Response('down', { status: 503 }));
    const started = Date.now();

    await expect(settle(`${SITE}/public`, 1, { timeoutMs: 60_000 })).rejects.toThrow(
      `${SITE}/public: HTTP 503`,
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(stubbed).toHaveBeenCalledExactlyOnceWith(
      `${SITE}/public`,
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('stops at once when its caller does, without asking again', async () => {
    const stubbed = answering(page(2));
    const stopping = new AbortController();
    const started = Date.now();
    const settled = settle(`${SITE}/public`, 3, {
      pollMs: 60_000,
      signal: stopping.signal,
      timeoutMs: 120_000,
    });

    stopping.abort();

    // Rejected with the abort, wherever it found the settle: in a request, or between two.
    await expect(settled).rejects.toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(stubbed).toHaveBeenCalledExactlyOnceWith(
      `${SITE}/public`,
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  /**
   * A timer still to fire keeps a Durable Object from being evicted until it does: each request's
   * time limit is cleared with the request, where `AbortSignal.timeout` would stay for the whole of
   * it. The Durable Object's own suites see one left behind as an eviction held up.
   */
  it('leaves no timer behind once a request is answered', async () => {
    answering(() => new Response('{}'), page(1));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });

    await postJson(`${SITE}/api/internal/changes`, {}, { timeoutMs: 30_000 });
    await settle(`${SITE}/public`, 1, { timeoutMs: 30_000 });

    expect(vi.getTimerCount()).toBe(0);
  });
});
