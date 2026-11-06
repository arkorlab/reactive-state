import { env } from 'cloudflare:workers';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { sharedEventStream, sharedEventText } from '../../src/authority/shared-events.ts';
import {
  GENERATION_HEADER,
  type SharedEvent,
  type SharedRenderRequest,
} from '../../src/routing.ts';
import { BUILD } from '../support/program.ts';
import { authority, type AuthorityStub, signIn, valueOf, write } from './helpers.ts';

/**
 * A shared view in the Durable Object: the route its Worker registers (`/counters/[id]`, a counter's
 * count for every visitor) rendered with no session, kept with what it read in the object's own
 * storage, evaluated again behind a commit that changed it — in the commit's own transaction, before
 * the write is answered — and answered at its gate: refused where its root refuses, a prefetch let
 * through where it is shown, a page past what a row of the storage holds rendered for each request;
 * its artifacts asked of the site the Worker binds, a stand-in the test answers for through a
 * stubbed `fetch`; and its event stream, as the object hands it over, read by a reader that is
 * behind.
 */

const ROUTE = '/counters/[id]';

/** The counter `main`'s view, as its route's page asks for it. */
const MAIN: SharedRenderRequest = { build: BUILD, props: { id: 'main' }, route: ROUTE };
/** The route the Worker registers under its guard, whose paths no test here but its own asks for. */
const GUARDED = '/guarded/[id]';
/** The counter `main`'s view of `GUARDED`, as its page asks for it. */
const GUARDED_MAIN: SharedRenderRequest = { ...MAIN, route: GUARDED };
/** How often the object asks for an artifact before it gives the generation up. */
const ATTEMPTS = 3;
/** More than the 2 MB a row of the object's SQLite holds. */
const PAST_A_ROW = 2_500_000;
/** How often the event stream of the test's own says it is alive while it says nothing else. */
const HEARTBEAT_MS = 10;

describe('a shared view in the Durable Object', () => {
  it('asks its site for a generation’s artifact with a signal that lets go of the request', async () => {
    // The requests for the counter `other`'s page: no other test's object asks for it.
    const asked: (RequestInit | undefined)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input, init) => {
        if (new Request(input).url.endsWith('/counters/other')) {
          asked.push(init);
        }
        return Promise.resolve(new Response(null, { status: 503 }));
      }),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {
      // What the object logs of the requests the site refused, kept out of the output.
    });
    onTestFinished(() => {
      logged.mockRestore();
      vi.unstubAllGlobals();
    });
    const stub = authority();
    valueOf(await stub.renderShared(null, { ...MAIN, props: { id: 'other' } }));

    // Every request the object makes of the generation's document is refused, and given up.
    await vi.waitFor(
      async () => {
        expect((await stub.stats()).generationFailures).toBe(ATTEMPTS);
      },
      { timeout: 5000 },
    );

    expect(asked).toHaveLength(ATTEMPTS);
    expect(asked.map((init) => init?.signal instanceof AbortSignal)).toStrictEqual([
      true,
      true,
      true,
    ]);
  });

  it('renders the route’s root for every visitor, and anew once a commit changed what it read', async () => {
    const stub = authority();
    const shown = valueOf(await stub.renderShared(null, MAIN));

    expect(shown.kind).toBe('shared');
    expect(JSON.stringify(shown.result.tree)).toContain('count: 0');

    const alice = await signIn(stub, 'alice');
    valueOf(await write(stub, alice));
    const after = valueOf(await stub.renderShared(alice, MAIN));

    expect(after.kind).toBe('shared');
    expect(JSON.stringify(after.result.tree)).toContain('count: 1');
  });

  it('holds for a reader of its events that is behind only what the page still acts on, and no heartbeat', async () => {
    const listeners = new Set<(event: SharedEvent) => void>();
    const followed = {
      listen: (listener: (event: SharedEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      missed: [{ epoch: 1, generation: 1, kind: 'ready' } as const],
    };
    const reader = sharedEventStream(followed, HEARTBEAT_MS).getReader();
    onTestFinished(async () => {
      await reader.cancel();
    });
    const decoder = new TextDecoder();
    const next = async (): Promise<string> => decoder.decode((await reader.read()).value);
    // Nothing read meanwhile: every generation of the epoch, heartbeats, a denial and what follows it.
    for (let generation = 2; generation <= 1000; generation += 1) {
      for (const listener of listeners) {
        listener({ epoch: 1, generation, kind: 'ready' });
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, HEARTBEAT_MS * 5);
    });
    for (const listener of listeners) {
      listener({ epoch: 2, kind: 'denied' });
      listener({ epoch: 2, generation: 1001, kind: 'ready' });
    }

    await expect(next()).resolves.toBe(': open\n\n');
    await expect(next()).resolves.toBe(
      sharedEventText({ epoch: 2, kind: 'denied' }) +
        sharedEventText({ epoch: 2, generation: 1001, kind: 'ready' }),
    );
    await expect(next()).resolves.toBe(': heartbeat\n\n');
  });

  it('refuses at its gate a view its root refuses, and lets a prefetch of one it shows through', async () => {
    const stub = authority();

    await expect(
      stub.gate({ headers: {}, method: 'GET', route: ROUTE, url: '/counters/missing' }),
    ).resolves.toMatchObject({ ok: true, value: { kind: 'respond', status: 403 } });
    await expect(
      stub.gate({
        headers: { 'next-router-prefetch': '1', rsc: '1' },
        method: 'GET',
        route: ROUTE,
        url: '/counters/main',
      }),
    ).resolves.toStrictEqual({ ok: true, value: { kind: 'pass' } });
  });

  it('reads a param at its gate as Next.js hands it to the page, the view’s page asked for at it, and makes no view of one no page is handed', async () => {
    const stub = authority();
    // The guarded counters' page — whose paths no other test here asks for, a request another's
    // object makes after its test ended reaching none of this — rendered of the param Next.js hands
    // it, decoded and encoded again (`support/next-page.ts`), through a stub made in the object's
    // request.
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        const { pathname } = new URL(request.url);
        if (!pathname.startsWith('/guarded/')) {
          return new Response(null, { status: 404 });
        }
        asked.push(pathname);
        const id = encodeURIComponent(decodeURIComponent(pathname.split('/').at(-1) ?? ''));
        const generation = request.headers.get(GENERATION_HEADER);
        const page = env.AUTHORITY.get(stub.id) as unknown as AuthorityStub;
        const answer = await page.renderShared(null, {
          ...GUARDED_MAIN,
          props: { id },
          ...(generation !== null && { generation }),
        });
        const type = request.headers.get('rsc') === '1' ? 'text/x-component' : 'text/html';
        return answer.ok
          ? Response.json(answer.value, { headers: { 'content-type': type } })
          : new Response(null, { status: 404 });
      }),
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    // `..` and `.`, however encoded, are steps of the path to the URL parser, never a param.
    for (const url of ['/guarded/..', '/guarded/%2E%2E', '/guarded/.']) {
      await expect(
        stub.gate({ headers: {}, method: 'GET', route: GUARDED, url }),
      ).resolves.toStrictEqual({ ok: true, value: { kind: 'pass' } });
    }

    // A page's render of one — another page's — is of no view: its root rendered for the request as
    // any root is, its guard run of the param as the page gave it, which refuses a counter there is
    // not; and so is one of props besides the param, text or not, which its guard lets through.
    await expect(
      stub.renderShared(null, { ...GUARDED_MAIN, props: { id: '..' } }),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: 'session', result: { status: 'forbidden' } },
    });
    await expect(
      stub.renderShared(null, { ...GUARDED_MAIN, props: { id: 'main', label: ['wide', 2] } }),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: 'session', result: { status: 'rendered' } },
    });
    await expect(stub.stats()).resolves.toMatchObject({ sharedViews: 0 });
    expect(asked).toStrictEqual([]);

    // `m%61in` is `main`, as the page is handed it: main's view, its page asked for at `main` —
    // the spelling its artifacts answer alone; another is the page's to render as it is spelled.
    await expect(
      stub.gate({ headers: {}, method: 'GET', route: GUARDED, url: '/guarded/main' }),
    ).resolves.toMatchObject({ ok: true, value: { kind: 'respond', status: 200 } });
    await expect(
      stub.gate({ headers: {}, method: 'GET', route: GUARDED, url: '/guarded/m%61in' }),
    ).resolves.toStrictEqual({ ok: true, value: { kind: 'pass' } });
    expect(asked).toStrictEqual(['/guarded/main', '/guarded/main']);
  });

  it('lets a generation’s token through for its own view’s artifact alone, while it is asked for — never of another view, nor once its request is over', async () => {
    const stub = authority();
    // The guarded counter `main`'s page — whose paths no other test here asks for — rendered for the
    // generation it is asked for, through a stub made in the object's request; and, while that
    // request is under way, its token asked of the missing counter's view, which its guard refuses.
    const tokens: string[] = [];
    const elsewhere: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (!request.url.endsWith('/guarded/main')) {
          return new Response(null, { status: 404 });
        }
        const generation = request.headers.get(GENERATION_HEADER) ?? '';
        const page = env.AUTHORITY.get(stub.id) as unknown as AuthorityStub;
        tokens.push(generation);
        elsewhere.push(
          await page.gate({
            headers: { [GENERATION_HEADER]: generation },
            method: 'GET',
            route: GUARDED,
            url: '/guarded/missing',
          }),
        );
        const answer = await page.renderShared(null, { ...GUARDED_MAIN, generation });
        const type = request.headers.get('rsc') === '1' ? 'text/x-component' : 'text/html';
        return answer.ok
          ? Response.json(answer.value, { headers: { 'content-type': type } })
          : new Response(null, { status: 404 });
      }),
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const asking = async (headers: Readonly<Record<string, string>>): Promise<unknown> =>
      stub.gate({ headers, method: 'GET', route: GUARDED, url: '/guarded/main' });

    await expect(asking({})).resolves.toMatchObject({ ok: true, value: { status: 200 } });
    expect(tokens).toHaveLength(2);
    // The missing counter's view as any request of it is answered: refused by its guard.
    expect(elsewhere).toMatchObject(tokens.map(() => ({ ok: true, value: { status: 403 } })));

    // Replayed once its request is over: answered from the view's artifact, as any request is.
    for (const token of tokens) {
      await expect(asking({ [GENERATION_HEADER]: token })).resolves.toMatchObject({
        ok: true,
        value: { kind: 'respond', status: 200 },
      });
    }
  });

  it('answers an artifact only to a question of the deployment that made it, and lets one that names none through', async () => {
    const stub = authority();
    // The guarded counter `main`'s page — whose paths no other test here asks for — rendered for the
    // generation it is asked for, through a stub made in the object's request, as the deployment
    // `dpl_one` of the site answers it.
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (!request.url.endsWith('/guarded/main')) {
          return new Response(null, { status: 404 });
        }
        const generation = request.headers.get(GENERATION_HEADER) ?? '';
        const page = env.AUTHORITY.get(stub.id) as unknown as AuthorityStub;
        const answer = await page.renderShared(null, { ...GUARDED_MAIN, generation });
        const type = request.headers.get('rsc') === '1' ? 'text/x-component' : 'text/html';
        return answer.ok
          ? Response.json(answer.value, {
              headers: { 'content-type': type, 'x-nextjs-deployment-id': 'dpl_one' },
            })
          : new Response(null, { status: 404 });
      }),
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const asking = async (deployment?: string): Promise<unknown> => {
      return stub.gate({
        headers: {},
        method: 'GET',
        route: GUARDED,
        url: '/guarded/main',
        ...(deployment !== undefined && { deployment }),
      });
    };

    await expect(asking('dpl_one')).resolves.toMatchObject({ ok: true, value: { status: 200 } });
    // Another deployment's, within the hold, and one of an edge that names none: let through.
    await expect(asking('dpl_two')).resolves.toStrictEqual({ ok: true, value: { kind: 'pass' } });
    await expect(asking()).resolves.toStrictEqual({ ok: true, value: { kind: 'pass' } });
  });

  it('asks for an artifact in no coding, and refuses one workerd’s fetch read as it came, as a failed request', async () => {
    const stub = authority();
    // The guarded counter `other`'s page — whose paths no other test here asks for — rendered for
    // the generation it is asked for, through a stub made in the object's request, and deflated: a
    // coding workerd's `fetch` reads as it came, whatever the request asked for.
    const accepted: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (!request.url.endsWith('/guarded/other')) {
          return new Response(null, { status: 404 });
        }
        accepted.push(request.headers.get('accept-encoding'));
        const generation = request.headers.get(GENERATION_HEADER) ?? '';
        const page = env.AUTHORITY.get(stub.id) as unknown as AuthorityStub;
        const answer = await page.renderShared(null, {
          ...GUARDED_MAIN,
          generation,
          props: { id: 'other' },
        });
        const type = request.headers.get('rsc') === '1' ? 'text/x-component' : 'text/html';
        const deflated = new Blob([JSON.stringify(answer)])
          .stream()
          .pipeThrough(new CompressionStream('deflate'));
        return new Response(deflated, {
          headers: { 'content-encoding': 'deflate', 'content-type': type },
        });
      }),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {
      // What the object logs of the answers it refused, kept out of the output.
    });
    onTestFinished(() => {
      logged.mockRestore();
      vi.unstubAllGlobals();
    });

    await expect(
      stub.gate({ headers: {}, method: 'GET', route: GUARDED, url: '/guarded/other' }),
    ).resolves.toMatchObject({ ok: true, value: { kind: 'respond', status: 503 } });
    expect(accepted).toStrictEqual(Array.from({ length: ATTEMPTS }, () => 'identity'));
    await expect(stub.stats()).resolves.toMatchObject({
      artifactReads: 0,
      generationFailures: ATTEMPTS,
    });
  });

  it('tries a followed view whose next generation the site failed to answer again behind a backoff, and tells its page once the site answers', async () => {
    const stub = authority();
    // The guarded counter `main`'s page, rendered for the generation it is asked for through a stub
    // made in the object's request — or 503 while the site is down.
    const site = { down: false };
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        if (site.down || !request.url.endsWith('/guarded/main')) {
          return new Response(null, { status: 503 });
        }
        const generation = request.headers.get(GENERATION_HEADER) ?? '';
        const page = env.AUTHORITY.get(stub.id) as unknown as AuthorityStub;
        const answer = await page.renderShared(null, { ...GUARDED_MAIN, generation });
        const type = request.headers.get('rsc') === '1' ? 'text/x-component' : 'text/html';
        return Response.json(answer, { headers: { 'content-type': type } });
      }),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {
      // What the object logs of the requests the site refused, kept out of the output.
    });
    onTestFinished(() => {
      logged.mockRestore();
      vi.unstubAllGlobals();
    });

    await expect(
      stub.gate({ headers: {}, method: 'GET', route: GUARDED, url: '/guarded/main' }),
    ).resolves.toMatchObject({ ok: true, value: { status: 200 } });

    const shown = valueOf(await stub.renderShared(null, GUARDED_MAIN));
    const reader = valueOf(
      await stub.sharedEvents(shown.kind === 'shared' ? shown.view.token : ''),
    ).getReader();
    const decoder = new TextDecoder();
    let heard = '';
    const reading = (async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            return;
          }
          heard += decoder.decode(value, { stream: true });
        }
      } catch {
        // Cancelled as the test finishes: workerd rejects the read under way.
      }
    })();
    onTestFinished(async () => {
      await reader.cancel();
      await reading;
    });

    // A commit the view shows, whose generation the site fails to answer, every attempt.
    site.down = true;
    valueOf(await write(stub, await signIn(stub, 'alice')));
    await vi.waitFor(
      async () => {
        expect((await stub.stats()).generationFailures).toBe(ATTEMPTS);
      },
      { timeout: 5000 },
    );
    site.down = false;

    // Tried again with nobody asking, once the backoff has passed: its page told of it.
    await vi.waitFor(
      () => {
        expect(heard).toContain(sharedEventText({ epoch: 1, generation: 2, kind: 'ready' }));
      },
      { timeout: 5000 },
    );
  });

  it('renders every route for each request in an application that shares no view, its gate letting each through', async () => {
    const stub = env.UNSHARED.getByName(
      `unshared-${crypto.randomUUID()}`,
    ) as unknown as AuthorityStub;

    await expect(stub.renderShared(null, MAIN)).resolves.toMatchObject({
      ok: true,
      value: { kind: 'session' },
    });
    await expect(
      stub.gate({ headers: {}, method: 'GET', route: ROUTE, url: '/counters/main' }),
    ).resolves.toStrictEqual({ ok: true, value: { kind: 'pass' } });
    await expect(stub.stats()).resolves.toMatchObject({ sharedEvaluations: 0, sharedViews: 0 });
  });

  it('renders for each request a view whose page is past what a row of its storage holds, never a 503 for good', async () => {
    const stub = authority();
    const other: SharedRenderRequest = { ...MAIN, props: { id: 'other' } };
    // The counter `other`'s page, rendered for the generation it is asked for, as the route's page
    // renders it — through a stub made in the object's request that asks for the page, since workerd
    // refuses the test's own, another request's — and past what a row of the object's SQLite holds.
    // No other test's object asks for it; a page asked for of any other is not there.
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const asked = new Request(input, init);
        if (!asked.url.endsWith('/counters/other')) {
          return new Response(null, { status: 404 });
        }
        const generation = asked.headers.get(GENERATION_HEADER);
        const page = env.AUTHORITY.get(stub.id) as unknown as AuthorityStub;
        await page.renderShared(null, { ...other, ...(generation !== null && { generation }) });
        const type = asked.headers.get('rsc') === '1' ? 'text/x-component' : 'text/html';
        return new Response('x'.repeat(PAST_A_ROW), { headers: { 'content-type': type } });
      }),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {
      // What the object logs of the view it made the request's, kept out of the output.
    });
    onTestFinished(() => {
      logged.mockRestore();
      vi.unstubAllGlobals();
    });

    await expect(
      stub.gate({ headers: {}, method: 'GET', route: ROUTE, url: '/counters/other' }),
    ).resolves.toStrictEqual({ ok: true, value: { kind: 'pass' } });
    await expect(stub.renderShared(null, other)).resolves.toMatchObject({
      ok: true,
      value: { kind: 'session' },
    });
  });
});
