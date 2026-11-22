import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthorityClient } from '../src/client/index.ts';
import type * as Authority from '../src/next/authority.ts';
import { routeHandlers } from '../src/next/route.ts';
import {
  DELIVERY_KEY_ENV,
  GENERATION_HEADER,
  type MiddlewareEnvelope,
  type RouteRegistration,
  routeKeyOf,
} from '../src/routing.ts';

/**
 * A generation's token on a request whose `Connection` names headers of the hop: the request is the
 * authority's own for an artifact, handed to the page outside the route's envelopes, only where the
 * page is asked with the token — the page is asked without what `Connection` names. The authority
 * and the site the page is asked of are stood in for.
 */

const hoisted = vi.hoisted(() => {
  const fetched: Request[] = [];
  // In place before the route's modules load, which take `fetch` as they are evaluated.
  vi.stubGlobal('fetch', (input: Request | URL | string, init?: RequestInit) => {
    fetched.push(new Request(input, init));
    return Promise.resolve(new Response('page', { headers: { 'content-type': 'text/html' } }));
  });
  return { client: { gate: vi.fn(), guardRoute: vi.fn() }, fetched };
});

vi.mock(import('next/headers'), () => {
  return {
    cookies: () => Promise.reject(new Error('Routes read the request.')),
    headers: () => Promise.reject(new Error('Routes read the request.')),
  };
});
vi.mock(import('../src/next/authority.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal<typeof Authority>()),
    authority: () => hoisted.client as unknown as AuthorityClient,
  };
});

const ORIGIN = 'http://localhost:3000';
const KEY = 'the-build-s-delivery-key_0123456789';

/** How many requests the app's middleware's envelope was opened around. */
const counter = { opened: 0 };
const envelopes: Readonly<Record<string, MiddlewareEnvelope>> = {
  '': {
    after: (_locals, response) => {
      response.headers.set('x-envelope', 'after');
    },
    before: () => {
      counter.opened += 1;
      return {};
    },
    id: '',
  },
};

/** A route every visitor shares, under the app's middleware. */
const BOARDS: RouteRegistration = {
  blocking: true,
  middleware: [''],
  page: 'boards/[projectId]/page.tsx',
  params: ['projectId'],
  props: { projectId: 'projectId' },
  root: 'components/public-board',
  route: '/boards/[projectId]',
  shared: true,
};

const { GET: get } = routeHandlers({ envelopes, routes: [BOARDS] });

/** A read of the board the route's rewrite brought, with `headers`. */
function delivered(headers: Readonly<Record<string, string>>): Promise<Response> {
  return get(new Request(`${ORIGIN}/boards/p1`, { headers }), {
    params: Promise.resolve({ path: ['deliver', routeKeyOf(BOARDS.route), 'p1'] }),
  });
}

describe('a generation’s token on a request whose `Connection` names headers', () => {
  beforeEach(() => {
    hoisted.client.gate.mockReset();
    hoisted.client.guardRoute.mockReset();
    hoisted.fetched.length = 0;
    counter.opened = 0;
    vi.stubEnv(DELIVERY_KEY_ENV, KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A gate that lets the token through as a generation's, and any other read on to the page. */
  function gate(): void {
    hoisted.client.gate.mockImplementation(
      (question: { readonly headers: Readonly<Record<string, string>> }) => {
        return Promise.resolve({
          ok: true,
          value: Object.hasOwn(question.headers, GENERATION_HEADER)
            ? { generation: true, kind: 'pass' }
            : { kind: 'pass' },
        });
      },
    );
  }

  it.each(['x-reactive-generation', 'keep-alive, X-Reactive-Generation'])(
    'is no authority’s request’s where `Connection: %s` takes it off the page’s: the read is delivered in its envelopes, as any visitor’s',
    async (connection) => {
      gate();

      const response = await delivered({ connection, [GENERATION_HEADER]: 'g.token' });
      const [page] = hoisted.fetched;

      await expect(response.text()).resolves.toBe('page');
      expect(page?.headers.get(GENERATION_HEADER)).toBeNull();
      // Inside the middleware's envelope, and kept by no shared cache: one visitor's answer.
      expect(counter.opened).toBe(1);
      expect(response.headers.get('x-envelope')).toBe('after');
      expect(response.headers.get('cache-control')).toBe('private');
      // The gate is asked the visitor's question alone, and nothing of the token.
      expect(
        hoisted.client.gate.mock.calls.map((call) => {
          return (call[0] as { readonly method: string }).method;
        }),
      ).toStrictEqual(['GET']);
    },
  );

  it('is the authority’s request’s where the page is asked with it, whatever else `Connection` names: handed to the page with no envelope', async () => {
    gate();

    const response = await delivered({
      connection: 'keep-alive, x-hop',
      [GENERATION_HEADER]: 'g.token',
      'x-hop': 'named',
    });
    const [page] = hoisted.fetched;

    await expect(response.text()).resolves.toBe('page');
    expect(page?.headers.get(GENERATION_HEADER)).toBe('g.token');
    expect(page?.headers.get('x-hop')).toBeNull();
    expect(counter.opened).toBe(0);
    expect(response.headers.get('x-envelope')).toBeNull();
    expect(response.headers.get('cache-control')).toBeNull();
  });
});
