import { beforeEach, describe, expect, it, vi } from 'vitest';

import { signView } from '../src/authority/view-tokens.ts';
import type { AuthorityClient } from '../src/client/index.ts';
import type * as Authority from '../src/next/authority.ts';
import { MAX_BODY_BYTES } from '../src/next/chain.ts';
import { routeHandlers } from '../src/next/route.ts';
import type { RouteRegistration } from '../src/routing.ts';

const hoisted = vi.hoisted(() => ({ calls: [] as string[], sharedEvents: vi.fn() }));

vi.mock(import('next/headers'), () => ({ cookies }));
vi.mock(import('../src/next/authority.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal<typeof Authority>()),
    authority: () => ({ sharedEvents: hoisted.sharedEvents }) as unknown as AuthorityClient,
  };
});

const ROUTE: RouteRegistration = {
  blocking: true,
  middleware: ['boards/[projectId]'],
  page: 'boards/[projectId]/page.tsx',
  params: ['projectId'],
  props: { projectId: 'projectId' },
  root: 'components/board',
  route: '/boards/[projectId]',
  shared: true,
};
const handlers = routeHandlers({
  envelopes: {
    'boards/[projectId]': {
      before: ({ params }) => {
        hoisted.calls.push(`before:${String(params['projectId'])}`);
        return {};
      },
      after: (_locals, response) => {
        hoisted.calls.push('after');
        response.headers.set('set-cookie', 'envelope=ran');
      },
      id: 'boards/[projectId]',
    },
  },
  routes: [ROUTE],
});
const { GET: get, HEAD: head } = handlers;
const CLAIMS = {
  build: 'b_view',
  epoch: 1,
  generation: 1,
  params: { projectId: 'attacker-chosen' },
  route: ROUTE.route,
  t: 'view',
};
const TOKEN = signView('test-view-signing-secret', CLAIMS);
const FORGED = `${TOKEN.split('.', 1)[0] ?? ''}.signature`;
const CONTEXT = { params: Promise.resolve({ path: ['events'] }) };

/** A route reads the supplied request, never Next's ambient cookies. */
function cookies(): Promise<never> {
  return Promise.reject(new Error('Routes read the request.'));
}

/** A view's stream request, with an unsigned but otherwise well-shaped claim. */
function request(method: 'GET' | 'HEAD', view = TOKEN): Request {
  return new Request(`https://example.test/api/reactive-state/events?view=${view}`, { method });
}

/** The exact existing RPC arguments for an authenticated read or a nonfollowing HEAD. */
function eventArguments(method: 'GET' | 'HEAD', view: string): readonly [string, true?] {
  return method === 'HEAD' ? [view, true] : [view];
}

/** A finite stream that keeps a successful mock from retaining any following or timer. */
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

describe('a shared stream token before route envelope selection', () => {
  beforeEach(() => {
    hoisted.calls.length = 0;
    hoisted.sharedEvents.mockReset();
  });

  it.each(['GET', 'HEAD'] as const)(
    'runs no claimed envelope when the authority rejects a forged %s token',
    async (method) => {
      hoisted.sharedEvents.mockImplementation(() => {
        hoisted.calls.push('authority');
        return Promise.resolve({
          code: 'FORBIDDEN',
          message: 'Forbidden.',
          ok: false,
          status: 403,
        });
      });

      const response = await handlers[method](request(method, FORGED), CONTEXT);
      await response.text();

      expect(hoisted.calls).toStrictEqual(['authority']);
      expect(hoisted.sharedEvents).toHaveBeenCalledExactlyOnceWith(
        ...eventArguments(method, FORGED),
      );
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.body === null || method === 'GET').toBe(true);
    },
  );

  it('authenticates the existing GET call before either envelope effect', async () => {
    hoisted.sharedEvents.mockImplementation(() => {
      hoisted.calls.push('authority');
      return Promise.resolve({ ok: true, value: emptyStream() });
    });

    const response = await get(request('GET'), CONTEXT);
    await response.text();

    expect(hoisted.calls).toStrictEqual(['authority', 'before:attacker-chosen', 'after']);
    expect(hoisted.sharedEvents).toHaveBeenCalledExactlyOnceWith(TOKEN);
  });

  it('authenticates HEAD once and returns no stream body inside its valid envelopes', async () => {
    hoisted.sharedEvents.mockImplementation(() => {
      hoisted.calls.push('authority');
      return Promise.resolve({ ok: true, value: emptyStream() });
    });

    const response = await head(request('HEAD'), CONTEXT);

    expect(hoisted.sharedEvents).toHaveBeenCalledExactlyOnceWith(TOKEN, true);
    expect(hoisted.calls).toStrictEqual(['authority', 'before:attacker-chosen', 'after']);
    expect(response.body).toBeNull();
    expect(response.headers.get('set-cookie')).toBe('envelope=ran');
  });

  it.each(['before', 'after'] as const)(
    'cancels the authenticated GET stream when an envelope %s throws',
    async (part) => {
      const cancelled = vi.fn();
      hoisted.sharedEvents.mockResolvedValue({
        ok: true,
        value: new ReadableStream<Uint8Array>({ cancel: cancelled }),
      });
      const failure = new Error('The envelope failed.');
      const { GET: rejected } = routeHandlers({
        envelopes: {
          'boards/[projectId]': {
            before: () => {
              if (part === 'before') throw failure;
              return {};
            },
            after: () => {
              if (part === 'after') throw failure;
            },
            id: 'boards/[projectId]',
          },
        },
        routes: [ROUTE],
      });

      await expect(rejected(request('GET'), CONTEXT)).rejects.toBe(failure);

      expect(hoisted.sharedEvents).toHaveBeenCalledExactlyOnceWith(TOKEN);
      expect(cancelled).toHaveBeenCalledExactlyOnceWith(undefined);
    },
  );

  it('cancels the authenticated stream when the chain rejects an oversized body', async () => {
    const cancelled = vi.fn();
    hoisted.sharedEvents.mockResolvedValue({
      ok: true,
      value: new ReadableStream<Uint8Array>({ cancel: cancelled }),
    });
    const asked = request('GET');
    asked.headers.set('content-length', String(MAX_BODY_BYTES + 1));
    // The adapter-supplied body exercises the chain's terminal refusal before downstream.
    Object.defineProperty(asked, 'body', { value: new ReadableStream<Uint8Array>() });

    const response = await get(asked, CONTEXT);

    expect(response.status).toBe(413);
    expect(hoisted.calls).toStrictEqual([]);
    expect(cancelled).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('retains accepted route params and the valid GET response envelope', async () => {
    hoisted.sharedEvents.mockResolvedValue({ ok: true, value: emptyStream() });

    const response = await get(request('GET'), CONTEXT);
    await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('set-cookie')).toBe('envelope=ran');
    expect(hoisted.calls).toStrictEqual(['before:attacker-chosen', 'after']);
  });
});
