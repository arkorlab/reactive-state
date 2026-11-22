import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthorityClient } from '../src/client/index.ts';
import type * as Authority from '../src/next/authority.ts';
import type * as Deliver from '../src/next/deliver.ts';
import { DELETE as remove, GET as get, POST as post, routeHandlers } from '../src/next/route.ts';
import { SESSION_COOKIE } from '../src/program.ts';
import { refusal } from './support/page.ts';

/**
 * The route a compile writes (`<app>/api/reactive-state/[...path]/route.ts`): a root's event stream,
 * and the demo's sign-in and sign-out — with the authority stood in for.
 */

const hoisted = vi.hoisted(() => {
  return {
    client: {} as Record<string, ReturnType<typeof vi.fn>>,
    /** What the delivery of a route under middleware was handed: the request, and the segments. */
    delivered: [] as { readonly method: string; readonly segments: readonly string[] }[],
  };
});

vi.mock(import('next/headers'), () => {
  return {
    cookies: () => Promise.reject(new Error('Routes read the request.')),
  };
});
vi.mock(import('../src/next/authority.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal<typeof Authority>()),
    authority: () => hoisted.client as unknown as AuthorityClient,
  };
});
vi.mock(import('../src/next/deliver.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal<typeof Deliver>()),
    deliver: (asked: Request, _registry: Deliver.Registry, path: readonly string[]) => {
      hoisted.delivered.push({ method: asked.method, segments: path });
      return Promise.resolve(new Response('delivered', { status: 202 }));
    },
  };
});

const ORIGIN = 'http://localhost:3000';

function request(
  path: string,
  init: RequestInit & { readonly session?: string; readonly origin?: string } = {},
): Request {
  const { origin = ORIGIN, session, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('origin', origin);
  if (session !== undefined) {
    headers.set('cookie', `theme=dark; ${SESSION_COOKIE}=${session}`);
  }
  return new Request(`${ORIGIN}/api/reactive-state/${path}`, { ...rest, headers });
}

/**
 * The cookie a sign-in sets, asked over plain http by a proxy in front of the application that
 * says, where it does, what the browser used (`x-forwarded-proto`).
 */
async function cookieBehind(forwarded?: string): Promise<string | null> {
  const response = await post(
    new Request('http://localhost:3000/api/reactive-state/session', {
      body: JSON.stringify({ user: 'bob' }),
      headers: {
        host: 'app.example',
        origin: 'https://app.example',
        ...(forwarded !== undefined && { 'x-forwarded-proto': forwarded }),
      },
      method: 'POST',
    }),
    { params: Promise.resolve({ path: ['session'] }) },
  );
  return response.headers.get('set-cookie');
}

/** What an answer to a `HEAD` says: its status, its headers, and its body, which is none. */
function headOf(response: Response): readonly unknown[] {
  return [response.status, Object.fromEntries(response.headers), response.body];
}

/** What Next.js hands the catch-all's handler beside the request. */
function segments(...path: readonly string[]): { readonly params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path: [...path] }) };
}

describe('the route a compile writes', () => {
  beforeEach(() => {
    hoisted.client = {
      events: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(() => Promise.resolve({ ok: true, value: null })),
    };
  });

  describe('the event stream', () => {
    it('hands on the authority’s stream for the session and the subscription, uncached', async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: frame\ndata: {"revision":3}\n\n'));
          controller.close();
        },
      });
      hoisted.client['events']?.mockResolvedValue({ ok: true, value: stream });

      const response = await get(
        request('events?subscription=s%3A1', { session: 'session-a' }),
        segments('events'),
      );

      expect(hoisted.client['events']).toHaveBeenCalledExactlyOnceWith('session-a', 's:1');
      expect(response.status).toBe(200);
      expect(Object.fromEntries(response.headers)).toMatchObject({
        'cache-control': 'no-store, no-transform',
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
      });
      await expect(response.text()).resolves.toBe('event: frame\ndata: {"revision":3}\n\n');
    });

    it('ends the authority’s stream with the request', async () => {
      const cancelled = vi.fn();
      const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
      hoisted.client['events']?.mockResolvedValue({ ok: true, value: stream });
      const leaving = new AbortController();

      const response = await get(
        new Request(`${ORIGIN}/api/reactive-state/events?subscription=s`, {
          signal: leaving.signal,
        }),
      );
      const text = response.text();
      leaving.abort();

      await expect(text).rejects.toThrow(/aborted/u);

      await vi.waitFor(() => {
        expect(cancelled).toHaveBeenCalledTimes(1);
      });
    });

    it('answers a refusal every reconnection would meet as a stream that says `revoked`, and ends', async () => {
      hoisted.client['events']?.mockResolvedValue(
        refusal(401, 'UNAUTHENTICATED', 'Sign in first.'),
      );

      const refused = await get(request('events?subscription=s'), segments('events'));
      const unnamed = await get(request('events'), segments('events'));

      expect(refused.status).toBe(200);
      expect(refused.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      await expect(refused.text()).resolves.toBe(
        ': open\n\nevent: revoked\ndata: {"code":"UNAUTHENTICATED","error":"Sign in first."}\n\n',
      );
      expect(hoisted.client['events']).toHaveBeenCalledExactlyOnceWith(null, 's');
      expect(unnamed.status).toBe(400);
    });

    it('answers a `HEAD` of the stream with the headers its `GET` opens one with and no body, opening none — as the route’s own `HEAD`, and as the `GET` Next.js answers a `HEAD` by', async () => {
      const { HEAD: head } = routeHandlers({ envelopes: {}, routes: [] });
      const asked = (): Request =>
        request('events?subscription=s', { method: 'HEAD', session: 'session-a' });
      const answered = [
        await head(asked(), segments('events')),
        await get(asked(), segments('events')),
      ];
      const unnamed = await head(request('events', { method: 'HEAD' }), segments('events'));
      const opened = [
        200,
        {
          'cache-control': 'no-store, no-transform',
          'content-type': 'text/event-stream; charset=utf-8',
          'x-accel-buffering': 'no',
        },
        null,
      ];

      expect(hoisted.client['events']).not.toHaveBeenCalled();
      expect(answered.map((response) => headOf(response))).toStrictEqual([opened, opened]);
      expect(unnamed.status).toBe(400);
    });

    it('answers a refusal a reconnection may pass, as an authority that did not answer, as one', async () => {
      hoisted.client['events']?.mockResolvedValue(
        refusal(503, 'AUTHORITY_UNAVAILABLE', 'The authority did not answer.'),
      );

      const refused = await get(request('events?subscription=s'), segments('events'));

      expect(refused.status).toBe(503);
      await expect(refused.json()).resolves.toStrictEqual({
        code: 'AUTHORITY_UNAVAILABLE',
        error: 'The authority did not answer.',
      });
    });
  });

  describe('signing in and out', () => {
    it('opens a session, sets its cookie, and ends the one the browser had', async () => {
      hoisted.client['login']?.mockResolvedValue({
        ok: true,
        value: { sessionId: 'session-b', userId: 'bob' },
      });

      const response = await post(
        request('session', {
          body: JSON.stringify({ user: 'bob' }),
          method: 'POST',
          session: 'session-a',
        }),
        segments('session'),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({ user: { id: 'bob' } });
      expect(response.headers.get('set-cookie')).toBe(
        `${SESSION_COOKIE}=session-b; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
      );
      expect(hoisted.client['login']).toHaveBeenCalledExactlyOnceWith('bob');
      expect(hoisted.client['logout']).toHaveBeenCalledExactlyOnceWith('session-a');
    });

    it('ends the session it opened where the one the browser had could not be ended, and sets no cookie', async () => {
      hoisted.client['login']?.mockResolvedValue({
        ok: true,
        value: { sessionId: 'session-b', userId: 'bob' },
      });
      hoisted.client['logout']
        ?.mockResolvedValueOnce(refusal(503, 'AUTHORITY_UNAVAILABLE', 'No answer.'))
        .mockResolvedValueOnce({ ok: true, value: null });

      const response = await post(
        request('session', {
          body: JSON.stringify({ user: 'bob' }),
          method: 'POST',
          session: 'session-a',
        }),
        segments('session'),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(hoisted.client['logout']?.mock.calls).toStrictEqual([['session-a'], ['session-b']]);
    });

    it('refuses another origin, a body that is not JSON, and no user', async () => {
      const foreign = await post(
        request('session', {
          body: '{"user":"bob"}',
          method: 'POST',
          origin: 'https://evil.example',
        }),
        segments('session'),
      );
      const broken = await post(
        request('session', { body: '{', method: 'POST' }),
        segments('session'),
      );
      const nobody = await post(
        request('session', { body: '{}', method: 'POST' }),
        segments('session'),
      );

      expect([foreign.status, broken.status, nobody.status]).toStrictEqual([403, 400, 400]);
      expect(hoisted.client['login']).not.toHaveBeenCalled();
    });

    it('takes the origin of the host the browser addressed, as a proxy in front names it', async () => {
      hoisted.client['login']?.mockResolvedValue({
        ok: true,
        value: { sessionId: 'session-b', userId: 'bob' },
      });
      const body = JSON.stringify({ user: 'bob' });

      const addressed = await post(
        new Request('http://localhost:3000/api/reactive-state/session', {
          body,
          headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
          method: 'POST',
        }),
        segments('session'),
      );
      const proxied = await post(
        new Request('http://localhost:3000/api/reactive-state/session', {
          body,
          headers: {
            host: 'internal:8080',
            origin: 'https://app.example',
            'x-forwarded-host': 'app.example, edge.example',
          },
          method: 'POST',
        }),
        segments('session'),
      );
      const elsewhere = await post(
        new Request('http://localhost:3000/api/reactive-state/session', {
          body,
          headers: { host: '127.0.0.1:3000', origin: 'http://localhost:3000' },
          method: 'POST',
        }),
        segments('session'),
      );

      expect([addressed.status, proxied.status, elsewhere.status]).toStrictEqual([200, 200, 403]);
    });

    it('marks the cookie `Secure` where a proxy in front says the browser used https', async () => {
      hoisted.client['login']?.mockResolvedValue({
        ok: true,
        value: { sessionId: 'session-b', userId: 'bob' },
      });

      await expect(cookieBehind('https')).resolves.toMatch(/; Secure$/u);
      await expect(cookieBehind('https, http')).resolves.toMatch(/; Secure$/u);
      await expect(cookieBehind('http')).resolves.not.toMatch(/Secure/u);
      await expect(cookieBehind()).resolves.not.toMatch(/Secure/u);
    });

    it('signs out, clearing the cookie whatever the authority answers', async () => {
      hoisted.client['logout']?.mockResolvedValueOnce(
        refusal(401, 'UNAUTHENTICATED', 'It had ended.'),
      );

      const ended = await remove(
        request('session', { method: 'DELETE', session: 'session-a' }),
        segments('session'),
      );
      const signedOut = await remove(request('session', { method: 'DELETE' }), segments('session'));

      expect(ended.status).toBe(401);
      expect(ended.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=; Path=/`);
      expect(signedOut.status).toBe(200);
      expect(signedOut.headers.get('set-cookie')).toContain('Max-Age=0');
    });

    it('signs the browser out where the authority did not answer, and answers that it did not', async () => {
      hoisted.client['logout']?.mockResolvedValueOnce(
        refusal(503, 'AUTHORITY_UNAVAILABLE', 'No answer.'),
      );

      const response = await remove(
        request('session', { method: 'DELETE', session: 'session-a' }),
        segments('session'),
      );

      // The session is left to end at the authority as it expires, within the day a cookie lasts.
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
      expect(response.headers.get('set-cookie')).toBe(
        `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      );
      expect(hoisted.client['logout']).toHaveBeenCalledExactlyOnceWith('session-a');
    });
  });

  describe('a method a route handler may be asked with beside its own', () => {
    const handlers = routeHandlers({ envelopes: {}, routes: [] });

    it.each(['OPTIONS', 'PATCH', 'PUT'] as const)(
      'delivers a route under middleware asked with %s, as with any other method',
      async (method) => {
        hoisted.delivered = [];
        const response = await handlers[method](
          request('deliver/key/p1', { method }),
          segments('deliver', 'key', 'p1'),
        );

        expect(response.status).toBe(202);
        expect(hoisted.delivered).toStrictEqual([{ method, segments: ['key', 'p1'] }]);
      },
    );

    it('answers it of its own paths as Next.js answers a handler without it: 405, and its own methods for `OPTIONS`', async () => {
      const { OPTIONS: options, PATCH: patch, PUT: put } = handlers;
      const replaced = await put(request('session', { method: 'PUT' }), segments('session'));
      const patched = await patch(request('events', { method: 'PATCH' }), segments('events'));
      const asked = await options(request('events', { method: 'OPTIONS' }), segments('events'));

      expect(replaced.status).toBe(405);
      expect(patched.status).toBe(405);
      expect(asked.status).toBe(204);
      expect(asked.headers.get('allow')).toBe('DELETE, GET, HEAD, OPTIONS, POST');
    });
  });

  describe('what else the route answers', () => {
    it('serves nothing else, and each path by its own methods alone', async () => {
      const elsewhere = await get(request('elsewhere'), segments('elsewhere'));
      const writeToStream = await post(request('events', { method: 'POST' }), segments('events'));
      const readSession = await get(request('session'), segments('session'));

      expect(elsewhere.status).toBe(404);
      expect(writeToStream.status).toBe(405);
      expect(writeToStream.headers.get('allow')).toBe('GET');
      expect(readSession.headers.get('allow')).toBe('POST, DELETE');
    });

    it('reads its path from the URL where it is handed no segments', async () => {
      hoisted.client['events']?.mockResolvedValue(refusal(503, 'AUTHORITY_UNAVAILABLE', 'No.'));

      const response = await get(request('events?subscription=s'));

      expect(response.status).toBe(503);
    });
  });
});
