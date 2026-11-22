import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { signView } from '../src/authority/view-tokens.ts';
import type { AuthorityClient } from '../src/client/index.ts';
import type * as Authority from '../src/next/authority.ts';
import { chainAround, MAX_BODY_BYTES, throughChain } from '../src/next/chain.ts';
import { routeHandlers } from '../src/next/route.ts';
import {
  ADMISSION_HEADER,
  DELIVERY_KEY_ENV,
  DIRECT_HEADER,
  type MiddlewareEnvelope,
  ownValueOf,
  type PlainRouteRegistration,
  type RouteRegistration,
  routeKeyOf,
} from '../src/routing.ts';

/**
 * A route middleware chain's envelopes around one request, and the route a middleware route's
 * rewrite brings its requests to (`deliver`) — with the authority stood in for, and the site the
 * page is asked for again of stood in for by `fetch`.
 */

const hoisted = vi.hoisted(() => {
  const fetched: Request[] = [];
  /**
   * The headers the page answers its body, `page`, with: as a case says, an HTML page's else — or
   * its whole answer, made of the request it is asked with, where a case gives one (`answer`).
   */
  const page: {
    headers: Readonly<Record<string, string>>;
    answer: ((asked: Request) => Response) | undefined;
  } = { answer: undefined, headers: {} };
  // In place before the route's modules load, which take `fetch` as they are evaluated.
  vi.stubGlobal('fetch', (input: Request | URL | string, init?: RequestInit) => {
    const asked = new Request(input, init);
    fetched.push(asked);
    return Promise.resolve(page.answer?.(asked) ?? new Response('page', { headers: page.headers }));
  });
  return {
    client: { gate: vi.fn(), guardRoute: vi.fn(), sharedEvents: vi.fn() },
    fetched,
    page,
  };
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
/** The build's delivery key, as Next.js writes it into the route. */
const KEY = 'the-build-s-delivery-key_0123456789';

/** How many requests the root middleware's envelope was opened around. */
const counter = { issued: 0 };
/** The middleware variant's root and boards middleware, as the compile writes their envelopes. */
const envelopes: Readonly<Record<string, MiddlewareEnvelope>> = {
  '': {
    after: (locals, response) => {
      response.headers.set('X-V4-Request', String(locals['requestId']));
      response.headers.append('X-V4-Middleware', 'root');
    },
    before: () => {
      counter.issued += 1;
      return { requestId: `request-${String(counter.issued)}` };
    },
    id: '',
  },
  'boards/[projectId]': {
    after: (_locals, response) => {
      response.headers.append('X-V4-Middleware', 'boards');
    },
    id: 'boards/[projectId]',
  },
};

const BOARDS: RouteRegistration = {
  blocking: true,
  guarded: true,
  middleware: ['', 'boards/[projectId]'],
  page: 'boards/[projectId]/page.tsx',
  params: ['projectId'],
  props: { projectId: 'projectId' },
  root: 'components/public-board',
  route: '/boards/[projectId]',
  shared: true,
};

/** A route of the request's whose guards may answer a response of their own. */
const PUBLICATION: RouteRegistration = {
  ...BOARDS,
  answers: true,
  middleware: [''],
  page: 'projects/[projectId]/publication/page.tsx',
  root: 'components/publication-settings',
  route: '/projects/[projectId]/publication',
  shared: false,
};

/** A route of the request's whose guards let the request on or refuse it alone. */
const SETTINGS: RouteRegistration = {
  blocking: false,
  guarded: true,
  middleware: [''],
  page: 'projects/[projectId]/settings/page.tsx',
  params: ['projectId'],
  props: { projectId: 'projectId' },
  root: 'components/project-settings',
  route: '/projects/[projectId]/settings',
  shared: false,
};

/** A route of the request's no middleware of which has a guard: its envelopes alone. */
const NOTES: RouteRegistration = {
  blocking: false,
  middleware: [''],
  page: 'projects/[projectId]/notes/page.tsx',
  params: ['projectId'],
  props: { projectId: 'projectId' },
  root: 'components/project-notes',
  route: '/projects/[projectId]/notes',
  shared: false,
};

/** The authority's answer that the guard of the middleware `by` sent the request to sign in. */
function signInBy(by: string): unknown {
  return {
    ok: true,
    value: {
      body: '',
      by,
      headers: [
        ['cache-control', 'private, no-store'],
        ['location', '/sign-in'],
      ],
      kind: 'respond',
      status: 307,
    },
  };
}

/** A page of no reactive root under the app's middleware, and a guard of it. */
const ACCOUNT: PlainRouteRegistration = {
  file: 'account/[tab]/page.tsx',
  guarded: true,
  middleware: [''],
  params: ['tab'],
  plain: 'page',
  route: '/account/[tab]',
};

/** A route handler under the app's middleware, which has no guard. */
const ITEMS: PlainRouteRegistration = {
  file: 'api/items/route.ts',
  middleware: [''],
  params: [],
  plain: 'handler',
  route: '/api/items',
};

/** The projects index: a page of no reactive root whose route is all static, under a guard. */
const PROJECTS_INDEX: PlainRouteRegistration = {
  file: 'projects/page.tsx',
  guarded: true,
  middleware: [''],
  params: [],
  plain: 'page',
  route: '/projects',
};

/** A page of no reactive root whose route is all dynamic, `/boards/p1` among its paths. */
const SECTION_ITEM: PlainRouteRegistration = {
  file: '[section]/[id]/page.tsx',
  middleware: [''],
  params: ['section', 'id'],
  plain: 'page',
  route: '/[section]/[id]',
};

/** A route of the request's of dynamic segments alone, `route`, no middleware of which has a guard. */
function dynamicRoute(route: string): RouteRegistration {
  const params = route.split('/').slice(1);
  return { ...NOTES, page: `${params.join('/')}/page.tsx`, params, props: {}, route };
}

const handlers = routeHandlers({ envelopes, routes: [BOARDS, PUBLICATION, SETTINGS] });

const BOARD_PATH = ['deliver', routeKeyOf(BOARDS.route), 'p1'];
const PUBLICATION_PATH = ['deliver', routeKeyOf(PUBLICATION.route), 'p1'];

/**
 * A request the route's rewrite brought to the delivery route: the URL the browser asked for, as a
 * handler is handed it, and the route and its params in the catch-all's segments (`path`) — through
 * `through`'s handlers, the routes' and envelopes' above unless given.
 */
function delivered(
  url: string,
  path: readonly string[],
  init: RequestInit = {},
  through: ReturnType<typeof routeHandlers> = handlers,
): Promise<Response> {
  const handler = init.method === 'POST' ? through.POST : through.GET;
  return handler(new Request(`${ORIGIN}${url}`, init), {
    params: Promise.resolve({ path: [...path] }),
  });
}

/** An envelope that reads the request's body before `next`, as `await request.text()` does. */
function reading(id: string, read: string[]): MiddlewareEnvelope {
  return {
    before: async ({ request }) => {
      read.push(await request.text());
      return {};
    },
    id,
  };
}

/** A body of `length` bytes, streamed in chunks of 64 KiB, none of them saying how long it is. */
function streamOf(length: number): ReadableStream<Uint8Array> {
  const chunk = 65_536;
  let sent = 0;
  return new ReadableStream({
    pull: (controller) => {
      if (sent >= length) {
        controller.close();
        return;
      }
      const size = Math.min(chunk, length - sent);
      controller.enqueue(new Uint8Array(size));
      sent += size;
    },
  });
}

/** A POST of a streamed body, sent half duplex as `fetch` asks of a stream, which DOM's types omit. */
function posting(
  body: ReadableStream<Uint8Array>,
  headers: Readonly<Record<string, string>> = {},
): Request {
  const init = { body, duplex: 'half', headers, method: 'POST' };
  return new Request(ORIGIN, init);
}

/**
 * The page's answer as the platform's `fetch` hands it to a body of `page`, coded `coding`: its
 * status, its coding and length as the visitor is answered with them, and its body.
 */
async function answeredCoded(coding: string): Promise<readonly (number | string | null)[]> {
  hoisted.page.headers = {
    'content-encoding': coding,
    'content-length': '45',
    'content-type': 'text/html',
  };
  const response = await delivered('/projects/p1/publication', PUBLICATION_PATH);
  return [
    response.status,
    response.headers.get('content-encoding'),
    response.headers.get('content-length'),
    await response.text(),
  ];
}

/** A body that comes in `chunks`, each one of the stream's. */
function chunkedOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** What of `response`'s body is handed on, and whether it ended in a fault rather than its end. */
async function readWhole(
  response: Response,
): Promise<{ readonly failed: boolean; readonly text: string }> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const read = await reader?.read();
      if (read === undefined || read.done) {
        return { failed: false, text };
      }
      text += decoder.decode(read.value, { stream: true });
    }
  } catch {
    return { failed: true, text };
  }
}

describe('a route middleware chain', () => {
  it('runs parent before, child before, the response, child after, parent after', async () => {
    const order: string[] = [];
    const response = await throughChain(
      {
        envelopes: {
          '': {
            after: () => {
              order.push('root after');
            },
            before: () => {
              order.push('root before');
              return {};
            },
            id: '',
          },
          child: {
            after: () => {
              order.push('child after');
            },
            before: () => {
              order.push('child before');
              return {};
            },
            id: 'child',
          },
        },
        ids: ['', 'child'],
        params: {},
        request: new Request(ORIGIN),
      },
      () => {
        order.push('response');
        return Promise.resolve(new Response('body'));
      },
    );

    expect(order).toStrictEqual([
      'root before',
      'child before',
      'response',
      'child after',
      'root after',
    ]);
    await expect(response.text()).resolves.toBe('body');
  });

  it('asks for nothing below a middleware whose before throws', async () => {
    const downstream = vi.fn(() => Promise.resolve(new Response('body')));
    const failing: MiddlewareEnvelope = {
      before: () => {
        throw new Error('refused');
      },
      id: '',
    };

    await expect(
      throughChain(
        { envelopes: { '': failing }, ids: [''], params: {}, request: new Request(ORIGIN) },
        downstream,
      ),
    ).rejects.toThrow('refused');
    expect(downstream).not.toHaveBeenCalled();
  });

  it('hands every envelope and the response below them the body whole, however many read it', async () => {
    const read: string[] = [];
    const response = await throughChain(
      {
        envelopes: { '': reading('', read), child: reading('child', read) },
        ids: ['', 'child'],
        params: {},
        request: new Request(ORIGIN, { body: '{"title":"あとで"}', method: 'POST' }),
      },
      async (request) => new Response(await request.text()),
    );

    expect(read).toStrictEqual(['{"title":"あとで"}', '{"title":"あとで"}']);
    await expect(response.text()).resolves.toBe('{"title":"あとで"}');
  });

  it('hands each envelope and the response below them headers of their own, a request of a body or of none: what one sets reaches no other, nor the page', async () => {
    for (const init of [{ method: 'GET' }, { body: 'form', method: 'POST' }]) {
      const seen: string[] = [];
      const setting = (id: string): MiddlewareEnvelope => {
        return {
          before: ({ request }) => {
            seen.push(request.headers.get('x-set') ?? 'none');
            request.headers.set('x-set', id);
            return {};
          },
          id,
        };
      };
      const request = new Request(ORIGIN, init);
      await throughChain(
        {
          envelopes: { '': setting('root'), child: setting('child') },
          ids: ['', 'child'],
          params: {},
          request,
        },
        (below) => {
          seen.push(below.headers.get('x-set') ?? 'none');
          return Promise.resolve(new Response(null));
        },
      );

      expect(seen).toStrictEqual(['none', 'none', 'none']);
      expect(request.headers.get('x-set')).toBeNull();
    }
  });

  it('hands each envelope and the response below them a request given up as the request is', async () => {
    const read: string[] = [];
    const asked = new AbortController();
    const handed: AbortSignal[] = [];
    await throughChain(
      {
        envelopes: { '': reading('', read) },
        ids: [''],
        params: {},
        request: new Request(ORIGIN, { body: 'form', method: 'POST', signal: asked.signal }),
      },
      async (request) => {
        handed.push(request.signal);
        return new Response(await request.text());
      },
    );
    asked.abort();

    expect(read).toStrictEqual(['form']);
    expect(handed.map((signal) => signal.aborted)).toStrictEqual([true]);
  });

  it('refuses a body past its bound before any envelope runs, the one it declares unread (413)', async () => {
    const read: string[] = [];
    const downstream = vi.fn(() => Promise.resolve(new Response('body')));
    const chain = (request: Request): Promise<Response> => {
      return throughChain(
        { envelopes: { '': reading('', read) }, ids: [''], params: {}, request },
        downstream,
      );
    };
    const streamed = await chain(posting(streamOf(MAX_BODY_BYTES + 1)));
    // A body that says it is longer than the bound, and is not: never pulled before its refusal.
    const pulled = vi.fn();
    const short = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          pulled();
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const declared = await chain(posting(short, { 'content-length': String(MAX_BODY_BYTES + 1) }));

    expect([streamed.status, declared.status]).toStrictEqual([413, 413]);
    expect(pulled).not.toHaveBeenCalled();
    expect(read).toStrictEqual([]);
    expect(downstream).not.toHaveBeenCalled();
  });

  it('takes a body of its bound whole, and streams one through unread where no envelope is handed the request', async () => {
    const read: string[] = [];
    const lengthOf = async (request: Request): Promise<Response> =>
      new Response(String((await request.arrayBuffer()).byteLength));
    const held = await throughChain(
      {
        envelopes: { '': reading('', read) },
        ids: [''],
        params: {},
        request: posting(streamOf(MAX_BODY_BYTES)),
      },
      lengthOf,
    );
    const request = posting(streamOf(MAX_BODY_BYTES + 1));
    const handed: Request[] = [];
    const stamping: MiddlewareEnvelope = {
      after: (_locals, response) => {
        response.headers.set('X-V4-After', '1');
      },
      id: '',
    };
    const after = await throughChain(
      { envelopes: { '': stamping }, ids: [''], params: {}, request },
      async (below) => {
        handed.push(below);
        return lengthOf(below);
      },
    );

    await expect(held.text()).resolves.toBe(String(MAX_BODY_BYTES));
    expect(read.map((body) => body.length)).toStrictEqual([MAX_BODY_BYTES]);
    await expect(after.text()).resolves.toBe(String(MAX_BODY_BYTES + 1));
    expect(after.headers.get('X-V4-After')).toBe('1');
    expect(handed).toHaveLength(1);
    expect(handed[0]).toBe(request);
  });

  it('hands a body-reading envelope the body of a request that is no Request of the platform’s own', async () => {
    // As Next.js hands a route handler its own request, which workerd's Request takes as a URL.
    const foreign = {
      body: new Request(ORIGIN, { body: '{"a":1}', method: 'POST' }).body,
      headers: new Headers({ 'content-type': 'application/json' }),
      method: 'POST',
      redirect: 'follow',
      url: `${ORIGIN}/form`,
    } as unknown as Request;
    const read: unknown[] = [];
    const response = await throughChain(
      {
        envelopes: {
          '': {
            before: async ({ request }) => {
              read.push(await request.json());
              return {};
            },
            id: '',
          },
        },
        ids: [''],
        params: {},
        request: foreign,
      },
      async (request) => new Response(await request.text()),
    );

    expect(read).toStrictEqual([{ a: 1 }]);
    await expect(response.text()).resolves.toBe('{"a":1}');
  });

  it('names the middleware around a directory, outermost first', () => {
    expect(
      chainAround('api/reactive-state/[...path]', {
        '': envelopes[''] ?? { id: '' },
        api: { id: 'api' },
      }),
    ).toStrictEqual(['', 'api']);
  });

  it('runs a shared view’s stream inside the envelopes of the route its token names, with the params it names as written', async () => {
    const seen: unknown[] = [];
    const { GET: get } = routeHandlers({
      envelopes: {
        'boards/[projectId]': {
          before: ({ params }) => {
            seen.push(params);
            return {};
          },
          id: 'boards/[projectId]',
        },
      },
      routes: [BOARDS],
    });
    const claims = {
      build: 'b_1',
      epoch: 1,
      generation: 1,
      params: { projectId: 'ボード' },
      route: BOARDS.route,
      t: 'view',
    };
    const token = signView('test-view-signing-secret', claims);
    hoisted.client.sharedEvents.mockResolvedValue({ ok: true, value: new ReadableStream() });
    const response = await get(
      new Request(`${ORIGIN}/api/reactive-state/events?view=${encodeURIComponent(token)}`),
      { params: Promise.resolve({ path: ['events'] }) },
    );
    await response.body?.cancel();

    expect(seen).toStrictEqual([{ projectId: 'ボード' }]);
    expect(hoisted.client.sharedEvents).toHaveBeenCalledWith(token);
  });

  it('answers a `HEAD` of a shared view’s stream inside the envelopes of the route its token names with the headers its `GET` opens it with and no body, following nothing', async () => {
    const seen: unknown[] = [];
    const { HEAD: head } = routeHandlers({
      envelopes: {
        'boards/[projectId]': {
          before: ({ params }) => {
            seen.push(params);
            return {};
          },
          id: 'boards/[projectId]',
        },
      },
      routes: [BOARDS],
    });
    const claims = {
      build: 'b_1',
      epoch: 1,
      generation: 1,
      params: { projectId: 'p1' },
      route: BOARDS.route,
      t: 'view',
    };
    const token = signView('test-view-signing-secret', claims);
    hoisted.client.sharedEvents.mockReset();
    hoisted.client.sharedEvents.mockResolvedValue({
      ok: true,
      value: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
    });
    const response = await head(
      new Request(`${ORIGIN}/api/reactive-state/events?view=${encodeURIComponent(token)}`, {
        method: 'HEAD',
      }),
      { params: Promise.resolve({ path: ['events'] }) },
    );

    expect(seen).toStrictEqual([{ projectId: 'p1' }]);
    expect(hoisted.client.sharedEvents).toHaveBeenCalledExactlyOnceWith(token, true);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.body).toBeNull();
  });

  it('answers a request of the events path that is no read — a preflight, a write — inside the route’s own middleware, a `view` in its query or not', async () => {
    const { OPTIONS: preflight, POST: post } = handlers;
    const answered: (string | null)[] = [];
    for (const [handler, method] of [
      [preflight, 'OPTIONS'],
      [post, 'POST'],
    ] as const) {
      const response = await handler(
        new Request(`${ORIGIN}/api/reactive-state/events?view=v`, { method }),
        { params: Promise.resolve({ path: ['events'] }) },
      );
      answered.push(response.headers.get('X-V4-Middleware'));
    }

    expect(answered).toStrictEqual(['root', 'root']);
    expect(hoisted.client.sharedEvents).not.toHaveBeenCalled();
  });
});

describe('a middleware route, delivered', () => {
  beforeEach(() => {
    hoisted.client.gate.mockReset();
    hoisted.client.guardRoute.mockReset();
    // The guards of a route of the request's let a request on unless a test says otherwise.
    hoisted.client.guardRoute.mockResolvedValue({ ok: true, value: { kind: 'pass' } });
    hoisted.fetched.length = 0;
    hoisted.page.headers = { 'content-type': 'text/html' };
    hoisted.page.answer = undefined;
    counter.issued = 0;
    vi.stubEnv(DELIVERY_KEY_ENV, KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('answers a shared route from its gate, a new envelope on each request', async () => {
    hoisted.client.gate.mockResolvedValue({
      ok: true,
      value: {
        body: btoa('<html>board</html>'),
        headers: [['content-type', 'text/html']],
        kind: 'respond',
        status: 200,
      },
    });
    const first = await delivered('/boards/p1', BOARD_PATH);
    const second = await delivered('/boards/p1', BOARD_PATH);

    await expect(first.text()).resolves.toBe('<html>board</html>');
    await expect(second.text()).resolves.toBe('<html>board</html>');
    expect(first.headers.get('X-V4-Middleware')).toBe('boards, root');
    expect(first.headers.get('X-V4-Request')).not.toBe(second.headers.get('X-V4-Request'));
    expect(hoisted.client.gate).toHaveBeenCalledWith({
      headers: {},
      method: 'GET',
      route: '/boards/[projectId]',
      site: { basePath: '', trailingSlash: false },
      url: '/boards/p1',
    });
    expect(hoisted.client.guardRoute).not.toHaveBeenCalled();
    expect(hoisted.fetched).toHaveLength(0);
  });

  it('answers a shared route’s gate decided by a guard inside the envelopes the source’s would be in: a refusal in none, a guard’s own response in those outside its middleware, the root’s refusal in every one', async () => {
    const forbidden = {
      body: btoa('Forbidden'),
      headers: [['cache-control', 'private, no-store']],
      kind: 'respond',
      status: 403,
    };
    hoisted.client.gate
      .mockResolvedValueOnce({
        ok: true,
        value: { ...forbidden, by: 'boards/[projectId]', refused: true },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          body: '',
          by: 'boards/[projectId]',
          headers: [['location', '/boards/p2']],
          kind: 'respond',
          status: 308,
        },
      })
      .mockResolvedValueOnce({ ok: true, value: forbidden })
      .mockResolvedValueOnce({
        code: 'AUTHORITY_UNAVAILABLE',
        message: 'down',
        ok: false,
        status: 503,
      });
    const answered: (readonly [number, string | null, boolean])[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await delivered('/boards/p1', BOARD_PATH);
      answered.push([
        response.status,
        response.headers.get('X-V4-Middleware'),
        response.headers.has('X-V4-Request'),
      ]);
    }

    expect(answered).toStrictEqual([
      [403, null, false],
      [308, 'root', true],
      [403, 'boards, root', true],
      [503, null, false],
    ]);
    expect(hoisted.fetched).toHaveLength(0);
  });

  it('asks the guards of a read its gate lets through, of a shared route with a guard, before the page — a prefetch’s too, whose headers are the visitor’s to send — and answers the response a guard answered itself', async () => {
    hoisted.client.gate.mockResolvedValue({ ok: true, value: { kind: 'pass' } });
    const redirect = {
      ok: true,
      value: { body: '', headers: [['location', '/sign-in']], kind: 'respond', status: 307 },
    };
    hoisted.client.guardRoute.mockResolvedValueOnce(redirect).mockResolvedValueOnce(redirect);
    const redirected = await delivered('/boards/p1', BOARD_PATH, { headers: { rsc: '1' } });
    const prefetched = await delivered('/boards/p1', BOARD_PATH, {
      headers: { 'next-router-prefetch': '1', rsc: '1' },
    });
    const passed = await delivered('/boards/p1', BOARD_PATH, {
      headers: { 'next-router-segment-prefetch': '/_tree', rsc: '1' },
    });

    for (const response of [redirected, prefetched]) {
      expect([response.status, response.headers.get('location')]).toStrictEqual([307, '/sign-in']);
    }

    await expect(passed.text()).resolves.toBe('page');
    expect(hoisted.client.guardRoute.mock.calls).toStrictEqual([
      [null, { admit: true, route: BOARDS.route, url: '/boards/p1' }],
      [null, { admit: true, route: BOARDS.route, url: '/boards/p1' }],
      [null, { admit: true, route: BOARDS.route, url: '/boards/p1' }],
    ]);
    // Only the prefetch the guards let on asked for the page.
    expect(hoisted.fetched).toHaveLength(1);
  });

  it('asks for the page again past the rewrite for a route of the request’s, the query kept but the delivery route’s own param', async () => {
    const response = await delivered(
      '/projects/p1/publication?tab=one&nxtPromo=spring&nxtPpath=deliver&nxtIpath=deliver',
      PUBLICATION_PATH,
      { headers: { cookie: 'reactive_session=abc', rsc: '1' } },
    );

    await expect(response.text()).resolves.toBe('page');
    expect(response.headers.get('X-V4-Middleware')).toBe('root');

    const [page] = hoisted.fetched;

    // A visitor's own key of the platform's prefix is the page's: only the catch-all's is not.
    expect(page?.url).toBe(`${ORIGIN}/projects/p1/publication?tab=one&nxtPromo=spring`);
    expect(hoisted.client.guardRoute).toHaveBeenCalledWith('abc', {
      admit: true,
      route: PUBLICATION.route,
      url: '/projects/p1/publication?tab=one&nxtPromo=spring',
    });
    expect(page?.headers.get('x-reactive-direct')).toBe(KEY);
    expect(page?.headers.get('cookie')).toBe('reactive_session=abc');
    expect(page?.headers.get('rsc')).toBe('1');
  });

  it('withholds from the page, the gate and the guards a visitor’s own key that Next.js reads as one of the route’s params, however escaped', async () => {
    const response = await delivered(
      '/projects/p1/publication?nxtPprojectId=p2&tab=one&nxtIprojectId=p3&nxtP%70rojectId=p4&nxtPromo=spring',
      PUBLICATION_PATH,
      { headers: { cookie: 'reactive_session=abc' } },
    );

    await expect(response.text()).resolves.toBe('page');

    const [page] = hoisted.fetched;

    // The page's `projectId` is the path's, which the guards were asked of: `p1`, never p2–p4.
    expect(page?.url).toBe(`${ORIGIN}/projects/p1/publication?tab=one&nxtPromo=spring`);
    expect(hoisted.client.guardRoute).toHaveBeenCalledWith('abc', {
      admit: true,
      route: PUBLICATION.route,
      url: '/projects/p1/publication?tab=one&nxtPromo=spring',
    });
  });

  it('asks for the page, and its gate or its guards, with the query as the visitor spelled it but the delivery route’s own param, however escaped: none of it decoded and written again', async () => {
    // A signature over the query, a malformed escape, a `+`, an empty component, a bare key — and
    // the catch-all's param escaped, which Next.js reads as the catch-all's all the same.
    const query = 'sig=a%20b%2fc&nxtPpath=deliver&x=%ZZ&y=1+2&&nxtIpath=deliver&nxtP%70ath=a&z';
    const spelled = '?sig=a%20b%2fc&x=%ZZ&y=1+2&&z';
    hoisted.client.gate.mockResolvedValue({ ok: true, value: { kind: 'pass' } });
    await delivered(`/boards/p1?${query}`, BOARD_PATH);
    await delivered(`/projects/p1/publication?${query}`, PUBLICATION_PATH, {
      headers: { cookie: 'reactive_session=abc' },
    });

    expect(hoisted.fetched.map((page) => page.url)).toStrictEqual([
      `${ORIGIN}/boards/p1${spelled}`,
      `${ORIGIN}/projects/p1/publication${spelled}`,
    ]);
    expect(hoisted.client.gate).toHaveBeenCalledWith(
      expect.objectContaining({ url: `/boards/p1${spelled}` }),
    );
    expect(hoisted.client.guardRoute).toHaveBeenCalledWith('abc', {
      admit: true,
      route: PUBLICATION.route,
      url: `/projects/p1/publication${spelled}`,
    });
  });

  it('delivers a POST to the page whole, though the envelopes around it read its body', async () => {
    const read: string[] = [];
    const reads = routeHandlers({
      envelopes: { '': reading('', read), projects: reading('projects', read) },
      routes: [{ ...PUBLICATION, middleware: ['', 'projects'] }],
    });
    const response = await delivered(
      '/projects/p1/publication',
      PUBLICATION_PATH,
      { body: 'title=%E3%81%82', headers: { 'next-action': 'a1' }, method: 'POST' },
      reads,
    );
    const [page] = hoisted.fetched;

    expect(response.status).toBe(200);
    expect(read).toStrictEqual(['title=%E3%81%82', 'title=%E3%81%82']);
    expect(page?.method).toBe('POST');
    expect(page?.headers.get('next-action')).toBe('a1');
    await expect(page?.text()).resolves.toBe('title=%E3%81%82');
  });

  it('answers a route of the request’s with the response its guard answered, inside the envelopes of the middleware around that guard’s alone', async () => {
    const nested = routeHandlers({
      envelopes,
      routes: [{ ...PUBLICATION, middleware: ['', 'boards/[projectId]'] }],
    });
    hoisted.client.guardRoute
      .mockResolvedValueOnce(signInBy('boards/[projectId]'))
      .mockResolvedValueOnce(signInBy('boards/[projectId]'))
      .mockResolvedValueOnce(signInBy(''));
    const redirected = await delivered(
      '/projects/p1/publication?tab=one',
      PUBLICATION_PATH,
      { headers: { cookie: 'reactive_session=abc' } },
      nested,
    );
    const posted = await delivered(
      '/projects/p1/publication',
      PUBLICATION_PATH,
      { body: 'form', method: 'POST' },
      nested,
    );
    const outermost = await delivered('/projects/p1/publication', PUBLICATION_PATH, {}, nested);

    expect([
      redirected.status,
      redirected.headers.get('location'),
      redirected.headers.get('cache-control'),
    ]).toStrictEqual([307, '/sign-in', 'private, no-store']);
    // The boards middleware's after never runs, as its guard never called `next`: the root's does.
    expect(redirected.headers.get('X-V4-Middleware')).toBe('root');
    expect(redirected.headers.get('X-V4-Request')).toBe('request-1');
    expect(posted.status).toBe(307);
    // Answered by the root's own guard: no after part is around it.
    expect([
      outermost.status,
      outermost.headers.get('X-V4-Middleware'),
      outermost.headers.get('X-V4-Request'),
    ]).toStrictEqual([307, null, null]);
    expect(hoisted.client.guardRoute.mock.calls).toStrictEqual([
      ['abc', { admit: true, route: PUBLICATION.route, url: '/projects/p1/publication?tab=one' }],
      [null, { admit: true, route: PUBLICATION.route, url: '/projects/p1/publication' }],
      [null, { admit: true, route: PUBLICATION.route, url: '/projects/p1/publication' }],
    ]);
    // Neither the page nor a Server Action posted to it ran.
    expect(hoisted.fetched).toHaveLength(0);
  });

  it('makes a guard’s response of its body, and of none for a status that has none', async () => {
    hoisted.client.guardRoute.mockResolvedValueOnce({
      ok: true,
      value: { body: btoa('gone'), headers: [], kind: 'respond', status: 410 },
    });
    hoisted.client.guardRoute.mockResolvedValueOnce({
      ok: true,
      value: { body: '', headers: [], kind: 'respond', status: 204 },
    });
    const gone = await delivered('/projects/p1/publication', PUBLICATION_PATH);
    const none = await delivered('/projects/p1/publication', PUBLICATION_PATH);

    expect(gone.status).toBe(410);
    await expect(gone.text()).resolves.toBe('gone');
    expect(none.status).toBe(204);
    expect(hoisted.fetched).toHaveLength(0);
  });

  it('asks the guards of a read of a route of the request’s before its page, and answers the generic 403 around no after part where one refuses it or the question is refused, 503 where the authority cannot answer; the page only where they let it on', async () => {
    const outcomes = [
      { ok: true, value: { kind: 'pass' } },
      { ok: true, value: { kind: 'refused' } },
      { code: 'UNAUTHENTICATED', message: 'Sign in first.', ok: false, status: 401 },
      { code: 'INVALID_ROUTE', message: 'The URL is not of the route.', ok: false, status: 400 },
      { code: 'AUTHORITY_UNAVAILABLE', message: 'down', ok: false, status: 503 },
    ];
    const answered: (readonly [number, string | null, string | null])[] = [];
    for (const outcome of outcomes) {
      hoisted.client.guardRoute.mockResolvedValueOnce(outcome);
      const response = await delivered('/projects/p1/publication', PUBLICATION_PATH);
      answered.push([
        response.status,
        response.headers.get('cache-control'),
        response.headers.get('X-V4-Middleware'),
      ]);
    }

    // A guard's refusal, or one that could not run, the source's throws past every after part.
    expect(answered).toStrictEqual([
      [200, 'private', 'root'],
      [403, 'private, no-store', null],
      [403, 'private, no-store', null],
      [403, 'private, no-store', null],
      [503, 'private, no-store', null],
    ]);
    expect(hoisted.fetched).toHaveLength(1);
  });

  it('asks the guards of a write before the page of a route a middleware of which has a guard, shared or not, and answers the generic 403 where one refuses it, the page never asked', async () => {
    hoisted.client.guardRoute.mockResolvedValue({ ok: true, value: { kind: 'refused' } });
    const posted = {
      body: 'form',
      headers: { cookie: 'reactive_session=abc', 'next-action': 'a1' },
      method: 'POST',
    };
    // A shared route's, and one of a route of the request's no guard of which may answer.
    const shared = await delivered('/boards/p1', BOARD_PATH, posted);
    const settings = await delivered(
      '/projects/p1/settings',
      ['deliver', routeKeyOf(SETTINGS.route), 'p1'],
      posted,
    );

    expect([shared.status, shared.headers.get('cache-control')]).toStrictEqual([
      403,
      'private, no-store',
    ]);
    // A refusal is thrown past every after part in the source: none is around it.
    expect(shared.headers.get('X-V4-Middleware')).toBeNull();
    expect(settings.status).toBe(403);
    expect(hoisted.client.guardRoute.mock.calls).toStrictEqual([
      ['abc', { admit: true, route: BOARDS.route, url: '/boards/p1' }],
      ['abc', { admit: true, route: SETTINGS.route, url: '/projects/p1/settings' }],
    ]);
    expect(hoisted.client.gate).not.toHaveBeenCalled();
    expect(hoisted.fetched).toHaveLength(0);
  });

  it('hands a write to a route no middleware of which has a guard to the page, shared or not, asking the authority nothing', async () => {
    hoisted.client.guardRoute.mockResolvedValue({ ok: true, value: { kind: 'refused' } });
    const board: RouteRegistration = {
      ...NOTES,
      page: 'notes/[projectId]/page.tsx',
      route: '/notes/[projectId]',
      shared: true,
    };
    const open = routeHandlers({ envelopes, routes: [NOTES, board] });
    const posted = {
      body: 'form',
      headers: { cookie: 'reactive_session=abc', 'next-action': 'a1' },
      method: 'POST',
    };
    const notes = await delivered(
      '/projects/p1/notes',
      ['deliver', routeKeyOf(NOTES.route), 'p1'],
      posted,
      open,
    );
    const shared = await delivered(
      '/notes/p1',
      ['deliver', routeKeyOf(board.route), 'p1'],
      posted,
      open,
    );

    expect([notes.status, shared.status]).toStrictEqual([200, 200]);
    expect(notes.headers.get('X-V4-Middleware')).toBe('root');
    expect(hoisted.client.guardRoute).not.toHaveBeenCalled();
    expect(hoisted.client.gate).not.toHaveBeenCalled();
    expect(hoisted.fetched.map((page) => page.method)).toStrictEqual(['POST', 'POST']);
  });

  it('asks the guards of every request of a route of no reactive root, reads included, and answers the generic 403 where one refuses it, the page never asked', async () => {
    hoisted.client.guardRoute.mockResolvedValue({ ok: true, value: { kind: 'refused' } });
    const plain = routeHandlers({ envelopes, routes: [ACCOUNT] });
    const path = ['deliver', routeKeyOf(ACCOUNT.route), 'a'];
    const read = await delivered(
      '/account/a?x=1',
      path,
      { headers: { cookie: 'reactive_session=abc' } },
      plain,
    );
    const { HEAD: head, OPTIONS: options } = plain;
    const headed = await head(new Request(`${ORIGIN}/account/a`, { method: 'HEAD' }), {
      params: Promise.resolve({ path }),
    });
    // A preflight is asked of the guards like any request: a guard cannot see the method.
    const preflight = await options(
      new Request(`${ORIGIN}/account/a`, {
        headers: { 'access-control-request-method': 'POST', origin: 'https://elsewhere.test' },
        method: 'OPTIONS',
      }),
      { params: Promise.resolve({ path }) },
    );

    expect([read.status, read.headers.get('cache-control')]).toStrictEqual([
      403,
      'private, no-store',
    ]);
    expect(read.headers.get('X-V4-Middleware')).toBeNull();
    expect([headed.status, preflight.status]).toStrictEqual([403, 403]);
    expect(hoisted.client.guardRoute.mock.calls).toStrictEqual([
      ['abc', { route: ACCOUNT.route, url: '/account/a?x=1' }],
      [null, { route: ACCOUNT.route, url: '/account/a' }],
      [null, { route: ACCOUNT.route, url: '/account/a' }],
    ]);
    expect(hoisted.fetched).toHaveLength(0);
  });

  it('hands a request of a route of no reactive root its guards let on to the page, and answers a guard’s own response, 503 where the authority cannot answer and 403 where it refuses the question, each inside the envelopes the source’s would be in', async () => {
    const outcomes = [
      { ok: true, value: { kind: 'pass' } },
      {
        ok: true,
        value: {
          body: btoa('Sign in'),
          by: 'account',
          headers: [['location', '/sign-in']],
          kind: 'respond',
          status: 307,
        },
      },
      { code: 'AUTHORITY_UNAVAILABLE', message: 'down', ok: false, status: 503 },
      { code: 'UNAUTHENTICATED', message: 'Sign in first.', ok: false, status: 401 },
    ];
    const account: MiddlewareEnvelope = {
      after: (_locals, response) => {
        response.headers.append('X-V4-Middleware', 'account');
      },
      id: 'account',
    };
    const plain = routeHandlers({
      envelopes: { ...envelopes, account },
      routes: [{ ...ACCOUNT, middleware: ['', 'account'] }],
    });
    const answered: (readonly [number, string | null])[] = [];
    for (const outcome of outcomes) {
      hoisted.client.guardRoute.mockResolvedValueOnce(outcome);
      const response = await delivered(
        '/account/a',
        ['deliver', routeKeyOf(ACCOUNT.route), 'a'],
        {},
        plain,
      );
      answered.push([response.status, response.headers.get('X-V4-Middleware')]);
    }

    // The page inside every envelope; the account guard's own response inside the root's alone, its
    // own after coming after the `next` it never called; a refusal and a failure inside none.
    expect(answered).toStrictEqual([
      [200, 'account, root'],
      [307, 'root'],
      [503, null],
      [403, null],
    ]);
    expect(
      hoisted.fetched.map((page) => [page.url, page.headers.get('x-reactive-direct')]),
    ).toStrictEqual([[`${ORIGIN}/account/a`, KEY]]);
  });

  it('hands every request of a route of no reactive root whose middleware has no guard to the page, a route handler’s of any method, asking the authority nothing', async () => {
    hoisted.client.guardRoute.mockResolvedValue({ ok: true, value: { kind: 'refused' } });
    const plain = routeHandlers({ envelopes, routes: [ITEMS] });
    const path = ['deliver', routeKeyOf(ITEMS.route)];
    const read = await delivered('/api/items', path, {}, plain);
    const posted = await delivered('/api/items', path, { body: '{}', method: 'POST' }, plain);
    const { DELETE: remove } = plain;
    const deleted = await remove(new Request(`${ORIGIN}/api/items`, { method: 'DELETE' }), {
      params: Promise.resolve({ path }),
    });

    expect([read.status, posted.status, deleted.status]).toStrictEqual([200, 200, 200]);
    expect(deleted.headers.get('X-V4-Middleware')).toBe('root');
    expect(hoisted.client.guardRoute).not.toHaveBeenCalled();
    expect(hoisted.client.gate).not.toHaveBeenCalled();
    expect(hoisted.fetched.map((page) => page.method)).toStrictEqual(['GET', 'POST', 'DELETE']);
  });

  it('asks for the page given up as the request is, a visitor’s or the authority’s for an artifact', async () => {
    const asked = new AbortController();
    const plain = routeHandlers({ envelopes, routes: [ITEMS] });
    await delivered(
      '/api/items',
      ['deliver', routeKeyOf(ITEMS.route)],
      { body: 'form', method: 'POST', signal: asked.signal },
      plain,
    );
    const [page] = hoisted.fetched;
    const before = page?.signal.aborted;
    asked.abort();

    expect([before, page?.signal.aborted]).toStrictEqual([false, true]);
  });

  it('answers a visitor what no shared cache may keep, whatever the page says of it: its envelopes and its guards were the request’s', async () => {
    // Each field a shared cache reads in place of `Cache-Control`, as its documentation writes it.
    const shared = [
      'CDN-Cache-Control',
      'Cloudflare-CDN-Cache-Control',
      'Vercel-CDN-Cache-Control',
      'Netlify-CDN-Cache-Control',
      'Akamai-Cache-Control',
      'Edge-Control',
      'Surrogate-Control',
      'X-Accel-Expires',
    ];
    hoisted.page.headers = {
      'cache-control': 's-maxage=31536000, Public, stale-while-revalidate=60',
      'content-type': 'text/html',
      ...Object.fromEntries(shared.map((name) => [name, 'max-age=60'])),
    };
    const plain = routeHandlers({ envelopes, routes: [ITEMS] });
    const response = await delivered('/api/items', ['deliver', routeKeyOf(ITEMS.route)], {}, plain);

    expect(response.headers.get('cache-control')).toBe('private, stale-while-revalidate=60');
    expect(shared.filter((name) => response.headers.has(name))).toStrictEqual([]);
    expect(response.headers.get('X-V4-Middleware')).toBe('root');
  });

  it('reads the page’s `Cache-Control` as RFC 9111 lists it: a directive whole where a quoted string in it holds a comma, a shared cache’s taken off by its name in any case', async () => {
    hoisted.page.headers = {
      'cache-control': String.raw`private="Set-Cookie, X-User", no-cache="X-A, X-\"B, C\"", S-MAXAGE=60,, max-age=60`,
      'content-type': 'text/html',
    };
    const plain = routeHandlers({ envelopes, routes: [ITEMS] });
    const response = await delivered('/api/items', ['deliver', routeKeyOf(ITEMS.route)], {}, plain);

    expect(response.headers.get('cache-control')).toBe(
      String.raw`private, no-cache="X-A, X-\"B, C\"", max-age=60`,
    );
  });

  it('hands a write its guards let on to the page, and answers 503 where the authority cannot answer and the generic 403 where it refuses the question', async () => {
    const outcomes = [
      { ok: true, value: { kind: 'pass' } },
      { code: 'AUTHORITY_UNAVAILABLE', message: 'down', ok: false, status: 503 },
      { code: 'UNAUTHENTICATED', message: 'Sign in first.', ok: false, status: 401 },
    ];
    const statuses: number[] = [];
    for (const outcome of outcomes) {
      hoisted.client.guardRoute.mockResolvedValueOnce(outcome);
      const response = await delivered('/boards/p1', BOARD_PATH, { body: 'form', method: 'POST' });
      statuses.push(response.status);
    }

    expect(statuses).toStrictEqual([200, 503, 403]);
    expect(hoisted.fetched.map((page) => page.method)).toStrictEqual(['POST']);
  });

  it('answers 503 where the gate cannot be asked, and 404 for a route it does not know', async () => {
    hoisted.client.gate.mockResolvedValue({
      code: 'AUTHORITY_UNAVAILABLE',
      message: 'down',
      ok: false,
      status: 503,
    });

    expect((await delivered('/boards/p1', BOARD_PATH)).status).toBe(503);
    expect((await delivered('/nowhere', ['deliver', routeKeyOf('/nowhere')])).status).toBe(404);
    expect((await delivered('/boards/p1', [...BOARD_PATH, 'extra'])).status).toBe(404);
  });

  it('hands the authority’s request for an artifact to the page with no envelope, its token kept, once the gate lets the token through', async () => {
    hoisted.client.gate.mockResolvedValue({ ok: true, value: { generation: true, kind: 'pass' } });
    const response = await delivered('/boards/p1', BOARD_PATH, {
      headers: {
        [ADMISSION_HEADER]: 'forged-admission',
        rsc: '1',
        'x-reactive-generation': 'g.token',
      },
    });
    const [page] = hoisted.fetched;

    expect(response.headers.get('X-V4-Middleware')).toBeNull();
    expect(counter.issued).toBe(0);
    // Asked of the generation's name alone, as a `HEAD`: a `pass` of the token's, not a prefetch's.
    expect(hoisted.client.gate.mock.calls).toStrictEqual([
      [
        {
          headers: { 'x-reactive-generation': 'g.token' },
          method: 'HEAD',
          route: BOARDS.route,
          site: { basePath: '', trailingSlash: false },
          url: '/boards/p1',
        },
      ],
    ]);
    expect(page?.headers.get('x-reactive-direct')).toBe(KEY);
    expect(page?.headers.get('x-reactive-generation')).toBe('g.token');
    expect(page?.headers.get(ADMISSION_HEADER)).toBeNull();
  });

  it('delivers a read naming a generation the gate does not let through in its envelopes, as any request, the name taken off', async () => {
    // The token's question answered as a visitor's read is, then the visitor's prefetch let on.
    hoisted.client.gate
      .mockResolvedValueOnce({
        ok: true,
        value: { body: null, headers: [], kind: 'respond', status: 200 },
      })
      .mockResolvedValueOnce({ ok: true, value: { kind: 'pass' } });
    const response = await delivered('/boards/p1', BOARD_PATH, {
      headers: { 'next-router-prefetch': '1', rsc: '1', 'x-reactive-generation': 'forged' },
    });
    const [page] = hoisted.fetched;

    await expect(response.text()).resolves.toBe('page');
    expect(response.headers.get('X-V4-Middleware')).toBe('boards, root');
    expect(counter.issued).toBe(1);
    expect(hoisted.client.gate.mock.calls).toStrictEqual([
      [
        {
          headers: { 'x-reactive-generation': 'forged' },
          method: 'HEAD',
          route: BOARDS.route,
          site: { basePath: '', trailingSlash: false },
          url: '/boards/p1',
        },
      ],
      [
        {
          headers: { 'next-router-prefetch': '1', rsc: '1' },
          method: 'GET',
          route: BOARDS.route,
          site: { basePath: '', trailingSlash: false },
          url: '/boards/p1',
        },
      ],
    ]);
    expect(page?.headers.get('x-reactive-direct')).toBe(KEY);
    expect(page?.headers.get('x-reactive-generation')).toBeNull();
  });

  it('delivers a read naming a generation in its envelopes where the gate lets every read of the view on, not the token', async () => {
    // A view found to be the request's: the gate lets every request on, the forged token's too.
    hoisted.client.gate.mockResolvedValue({ ok: true, value: { kind: 'pass' } });
    const response = await delivered('/boards/p1', BOARD_PATH, {
      headers: { 'x-reactive-generation': 'forged' },
    });
    const [page] = hoisted.fetched;

    await expect(response.text()).resolves.toBe('page');
    expect(response.headers.get('X-V4-Middleware')).toBe('boards, root');
    expect(page?.headers.get('x-reactive-generation')).toBeNull();
  });

  it('delivers a read naming a generation of a route no visitor shares in its envelopes, the name taken off, asking no gate', async () => {
    const response = await delivered(
      '/projects/p1/settings',
      ['deliver', routeKeyOf(SETTINGS.route), 'p1'],
      { headers: { 'x-reactive-generation': 'g.token' } },
    );
    const [page] = hoisted.fetched;

    await expect(response.text()).resolves.toBe('page');
    expect(response.headers.get('X-V4-Middleware')).toBe('root');
    expect(hoisted.client.gate).not.toHaveBeenCalled();
    expect(page?.headers.get('x-reactive-generation')).toBeNull();
  });

  it('delivers a write that names a generation in its envelopes, the name taken off', async () => {
    const response = await delivered('/projects/p1/publication', PUBLICATION_PATH, {
      body: 'form',
      headers: { 'x-reactive-generation': 'g.token' },
      method: 'POST',
    });
    const [page] = hoisted.fetched;

    expect(response.headers.get('X-V4-Middleware')).toBe('root');
    expect(page?.method).toBe('POST');
    expect(page?.headers.get('x-reactive-generation')).toBeNull();
  });

  it('delivers nothing in a build no adapter gave a delivery key', async () => {
    vi.stubEnv(DELIVERY_KEY_ENV, '');

    expect((await delivered('/projects/p1/publication', PUBLICATION_PATH)).status).toBe(503);
    expect(hoisted.fetched).toHaveLength(0);
  });

  it('asks for the page of a route an application’s own rewrite brought from another path at the route’s path, a catch-all’s segments in it', async () => {
    const files: RouteRegistration = {
      ...PUBLICATION,
      params: ['projectId', 'rest'],
      route: '/files/[projectId]/[[...rest]]',
    };
    const { GET: get } = routeHandlers({ envelopes, routes: [files] });
    const path = ['deliver', routeKeyOf(files.route), 'p 1', 'a', 'b'];
    await get(new Request(`${ORIGIN}/latest?q=1`), {
      params: Promise.resolve({ path }),
    });

    expect(hoisted.fetched[0]?.url).toBe(`${ORIGIN}/files/p%201/a/b?q=1`);
  });

  it('reads a route’s params off the delivery path by their places, whatever the route names them', async () => {
    const seen: unknown[] = [];
    const placed: RouteRegistration = {
      ...NOTES,
      middleware: ['placed'],
      page: '[$x]/[param0]/page.tsx',
      params: ['$x', 'param0'],
      props: {},
      route: '/[$x]/[param0]',
    };
    const before: MiddlewareEnvelope['before'] = ({ params }) => {
      seen.push(params);
      return {};
    };
    const through = routeHandlers({
      envelopes: { placed: { before, id: 'placed' } },
      routes: [placed],
    });

    const response = await delivered(
      '/a/b',
      ['deliver', routeKeyOf(placed.route), 'a', 'b'],
      {},
      through,
    );

    await expect(response.text()).resolves.toBe('page');
    expect(seen).toStrictEqual([{ $x: 'a', param0: 'b' }]);
  });

  it('hands the middleware each param as Next.js hands a page one, decoded and encoded again, and asks for the page by the visitor’s spelling of it', async () => {
    const seen: unknown[] = [];
    const placed: RouteRegistration = {
      ...NOTES,
      middleware: ['placed'],
      page: '[x]/[y]/page.tsx',
      params: ['x', 'y'],
      props: {},
      route: '/[x]/[y]',
    };
    const before: MiddlewareEnvelope['before'] = ({ params }) => {
      seen.push(params);
      return {};
    };
    const through = routeHandlers({
      envelopes: { placed: { before, id: 'placed' } },
      routes: [placed],
    });

    await delivered(
      '/caf%c3%a9/a%2Fb',
      ['deliver', routeKeyOf(placed.route), 'café', 'a/b'],
      {},
      through,
    );

    expect(seen).toStrictEqual([{ x: 'caf%C3%A9', y: 'a%2Fb' }]);
    expect(hoisted.fetched.map((page) => page.url)).toStrictEqual([`${ORIGIN}/caf%c3%a9/a%2Fb`]);
  });

  it('spells a static segment of the route as a browser spells its folder’s name, a `#` or a `?` in it never a path cut short', async () => {
    const odd: RouteRegistration = {
      ...NOTES,
      page: 'a#b/[id]/c?d/page.tsx',
      route: '/a#b/[id]/c?d',
    };
    const { GET: get } = routeHandlers({ envelopes, routes: [odd] });
    await get(new Request(`${ORIGIN}/latest`), {
      params: Promise.resolve({ path: ['deliver', routeKeyOf(odd.route), 'p1'] }),
    });

    expect(hoisted.fetched.map((page) => page.url)).toStrictEqual([`${ORIGIN}/a%23b/p1/c%3Fd`]);
  });

  it('reads a param named `__proto__` off the delivery path as one of its own, and asks for the page by it', async () => {
    const seen: unknown[] = [];
    const pinned: RouteRegistration = {
      ...NOTES,
      middleware: ['pinned'],
      page: 'pins/[__proto__]/page.tsx',
      params: ['__proto__'],
      props: {},
      route: '/pins/[__proto__]',
    };
    const before: MiddlewareEnvelope['before'] = ({ params }) => {
      seen.push(ownValueOf(params, '__proto__') ?? 'none of its own');
      return {};
    };
    const { GET: get } = routeHandlers({
      envelopes: { pinned: { before, id: 'pinned' } },
      routes: [pinned],
    });

    const response = await get(new Request(`${ORIGIN}/pinned`), {
      params: Promise.resolve({ path: ['deliver', routeKeyOf(pinned.route), 'a b'] }),
    });

    await expect(response.text()).resolves.toBe('page');
    expect(seen).toStrictEqual(['a%20b']);
    expect(hoisted.fetched[0]?.url).toBe(`${ORIGIN}/pins/a%20b`);
  });

  it('tells the gate of a shared route where the site serves its routes, as the build does', async () => {
    vi.stubEnv('__NEXT_ROUTER_BASEPATH', '/docs');
    vi.stubEnv('__NEXT_TRAILING_SLASH', 'true');
    hoisted.client.gate.mockResolvedValue({
      ok: true,
      value: {
        body: btoa('<html>board</html>'),
        headers: [['content-type', 'text/html']],
        kind: 'respond',
        status: 200,
      },
    });
    const response = await delivered('/docs/boards/p1/', BOARD_PATH);

    await expect(response.text()).resolves.toBe('<html>board</html>');
    expect(hoisted.client.gate).toHaveBeenCalledWith({
      headers: {},
      method: 'GET',
      route: BOARDS.route,
      site: { basePath: '/docs', trailingSlash: true },
      url: '/docs/boards/p1/',
    });
  });

  it('asks for a route’s page, and its gate, at the slash form the visitor asked for where the site makes no trailing-slash redirect, as what reads the path renders of it', async () => {
    vi.stubEnv('__NEXT_TRAILING_SLASH', 'true');
    vi.stubEnv('__NEXT_MANUAL_TRAILING_SLASH', 'true');
    hoisted.client.gate.mockResolvedValue({ ok: true, value: { kind: 'pass' } });
    for (const url of ['/boards/p1', '/boards/p1/']) {
      await delivered(url, BOARD_PATH);
    }

    const asked = hoisted.client.gate.mock.calls.map(
      (call) => (call[0] as { readonly url: string }).url,
    );

    expect(asked).toStrictEqual(['/boards/p1', '/boards/p1/']);
    expect(hoisted.fetched.map((page) => new URL(page.url).pathname)).toStrictEqual([
      '/boards/p1',
      '/boards/p1/',
    ]);
  });

  it('asks for a route’s page, and its guards, at the form of its path Next.js serves under `trailingSlash`: a last segment that names a file without the slash, one of no dot with it, one of a dot of no file’s without it', async () => {
    vi.stubEnv('__NEXT_TRAILING_SLASH', 'true');
    const rss: PlainRouteRegistration = { ...ITEMS, guarded: true, route: '/rss.xml' };
    const files: PlainRouteRegistration = {
      ...ITEMS,
      guarded: true,
      params: ['name'],
      route: '/files/[name]',
    };
    const plain = routeHandlers({ envelopes, routes: [rss, files] });
    const asked = [
      ['/rss.xml', [routeKeyOf(rss.route)]],
      ['/files/a.txt', [routeKeyOf(files.route), 'a.txt']],
      ['/files/abc/', [routeKeyOf(files.route), 'abc']],
      ['/files/v1.2-beta/', [routeKeyOf(files.route), 'v1.2-beta']],
    ] as const;
    for (const [url, path] of asked) {
      await delivered(
        url,
        ['deliver', ...path],
        { headers: { cookie: 'reactive_session=abc' } },
        plain,
      );
    }
    const served = ['/rss.xml', '/files/a.txt', '/files/abc/', '/files/v1.2-beta'];

    expect(hoisted.fetched.map((page) => page.url)).toStrictEqual(
      served.map((path) => `${ORIGIN}${path}`),
    );
    expect(hoisted.client.guardRoute.mock.calls).toStrictEqual([
      ['abc', { route: rss.route, url: '/rss.xml' }],
      ['abc', { route: files.route, url: '/files/a.txt' }],
      ['abc', { route: files.route, url: '/files/abc' }],
      ['abc', { route: files.route, url: '/files/v1.2-beta' }],
    ]);
  });

  it('asks for a static route’s own page, and its guards with its own path, whatever case or escapes of its path brought the request', async () => {
    const plain = routeHandlers({ envelopes, routes: [PROJECTS_INDEX] });
    const path = ['deliver', routeKeyOf(PROJECTS_INDEX.route)];
    for (const url of ['/PROJECTS?x=1', '/%70rojects?x=1', '/Proj%65cts?x=1']) {
      await delivered(url, path, { headers: { cookie: 'reactive_session=abc' } }, plain);
    }
    const asked = ['abc', { route: PROJECTS_INDEX.route, url: '/projects?x=1' }];

    // Next.js looks a page up by its path's spelling: `/PROJECTS` is `/[section]`'s, where an
    // application has that route.
    expect(hoisted.fetched.map((page) => page.url)).toStrictEqual(
      Array.from({ length: 3 }, () => `${ORIGIN}/projects?x=1`),
    );
    expect(hoisted.client.guardRoute.mock.calls).toStrictEqual(
      Array.from({ length: 3 }, () => asked),
    );
  });

  it('asks the gate of a shared route, and for its page where the gate lets the request on, with the route’s own path whatever case the visitor’s path has', async () => {
    hoisted.client.gate.mockResolvedValue({ ok: true, value: { kind: 'pass' } });
    const response = await delivered('/BOARDS/p1?x=1', BOARD_PATH);

    await expect(response.text()).resolves.toBe('page');
    expect(hoisted.client.gate).toHaveBeenCalledWith({
      headers: {},
      method: 'GET',
      route: BOARDS.route,
      site: { basePath: '', trailingSlash: false },
      url: '/boards/p1?x=1',
    });
    expect(hoisted.fetched.map((page) => page.url)).toStrictEqual([`${ORIGIN}/boards/p1?x=1`]);
  });

  it('hands the page of a route of the request’s, and a route handler, the route’s own path whatever case the visitor’s path has', async () => {
    const plain = routeHandlers({ envelopes, routes: [ITEMS] });
    await delivered('/PROJECTS/p1/Publication', PUBLICATION_PATH);
    await delivered('/API/Items?x=1', ['deliver', routeKeyOf(ITEMS.route)], {}, plain);

    expect(hoisted.fetched.map((page) => page.url)).toStrictEqual([
      `${ORIGIN}/projects/p1/publication`,
      `${ORIGIN}/api/items?x=1`,
    ]);
  });

  it('spells each param as the visitor’s path spelled it where that decodes to it, another route’s static segment escaped among them, and as a browser would where the visitor’s path has none', async () => {
    const plain = routeHandlers({ envelopes, routes: [SECTION_ITEM] });
    const publication = ['deliver', routeKeyOf(PUBLICATION.route)];
    // `/boards/p1` would be `/boards/[projectId]`'s page, not `/[section]/[id]`'s.
    await delivered(
      '/%62oards/p%31',
      ['deliver', routeKeyOf(SECTION_ITEM.route), 'boards', 'p1'],
      {},
      plain,
    );
    await delivered('/projects/a%40b/publication', [...publication, 'a@b']);
    await delivered('/projects/p2/publication', [...publication, 'p1']);
    // An application's own rewrite brought this one, from a path of none of the route's segments.
    await delivered('/latest', [...publication, 'a@b:c d/é?#%25^|']);

    expect(hoisted.fetched.map((page) => page.url)).toStrictEqual([
      `${ORIGIN}/%62oards/p%31`,
      `${ORIGIN}/projects/a%40b/publication`,
      `${ORIGIN}/projects/p1/publication`,
      `${ORIGIN}/projects/a@b:c%20d%2F%C3%A9%3F%23%2525%5E|/publication`,
    ]);
  });

  it('answers 404 for a param no path spells — a step of the path, none, a string not well formed — and asks for nothing', async () => {
    const statuses: number[] = [];
    for (const param of ['..', '.', '', '\u{D800}']) {
      const response = await delivered('/latest', [
        'deliver',
        routeKeyOf(PUBLICATION.route),
        param,
      ]);
      statuses.push(response.status);
    }

    expect(statuses).toStrictEqual([404, 404, 404, 404]);
    expect(hoisted.fetched).toHaveLength(0);
    expect(hoisted.client.guardRoute).not.toHaveBeenCalled();
  });

  it('answers 404 to a visitor asking for the delivery route itself, under the site’s base path however a URL spells it, past the segments Next.js matches its route by however escaped, and asks for nothing', async () => {
    vi.stubEnv('__NEXT_ROUTER_BASEPATH', '/ドキュメント');
    const encoded = `/${encodeURIComponent('ドキュメント')}`;
    const statuses: number[] = [];
    for (const url of [
      `${encoded}/api/reactive-state/deliver/x/p1?q=1`,
      '/ドキュメント/api/reactive-state/deliver/x/p1',
      `${encoded}/api/reactive-state/%64eliver/x/p1`,
      // As upwind's runtime matches a dynamic route: in any case.
      `${encoded}/API/Reactive-State/deliver/x/p1`,
    ]) {
      const response = await delivered(url, PUBLICATION_PATH, {
        headers: { cookie: 'reactive_session=abc' },
      });
      statuses.push(response.status);
    }
    vi.stubEnv('__NEXT_ROUTER_BASEPATH', '');
    statuses.push((await delivered('/api/reactive-state/deliver/x/p1', BOARD_PATH)).status);

    expect(statuses).toStrictEqual([404, 404, 404, 404, 404]);
    expect(hoisted.fetched).toHaveLength(0);
    expect(hoisted.client.guardRoute).not.toHaveBeenCalled();
    expect(hoisted.client.gate).not.toHaveBeenCalled();
  });

  it('answers a request a rewrite brought of a route of dynamic segments alone as that route’s, though its path spells the compile’s route’s segments otherwise, which Next.js matches as written, or has none after them', async () => {
    const [three, two] = [dynamicRoute('/[a]/[b]/[c]'), dynamicRoute('/[a]/[b]')];
    const through = routeHandlers({ envelopes, routes: [three, two] });
    const asked = [
      ['/api/%72eactive-state/events', three, ['api', 'reactive-state', 'events']],
      ['/%61pi/reactive-state/events', three, ['api', 'reactive-state', 'events']],
      ['/api/reactive-state', two, ['api', 'reactive-state']],
    ] as const;
    const answered: number[] = [];
    for (const [url, route, values] of asked) {
      const path = ['deliver', routeKeyOf(route.route), ...values];
      answered.push((await delivered(url, path, {}, through)).status);
    }

    expect(answered).toStrictEqual([200, 200, 200]);
    expect(hoisted.fetched.map((page) => page.url)).toStrictEqual(
      asked.map(([url]) => `${ORIGIN}${url}`),
    );
  });

  it('asks for the page where the site serves the route’s own path, under its base path and in its trailing-slash form, whatever case the visitor’s path has', async () => {
    vi.stubEnv('__NEXT_ROUTER_BASEPATH', '/docs');
    vi.stubEnv('__NEXT_TRAILING_SLASH', 'true');
    const response = await delivered('/docs/PROJECTS/p1/Publication/?q=1', PUBLICATION_PATH, {
      headers: { cookie: 'reactive_session=abc' },
    });

    await expect(response.text()).resolves.toBe('page');
    expect(hoisted.fetched.map((page) => page.url)).toStrictEqual([
      `${ORIGIN}/docs/projects/p1/publication/?q=1`,
    ]);
    // The authority reads the route's params off the route's own path.
    expect(hoisted.client.guardRoute).toHaveBeenCalledWith('abc', {
      admit: true,
      route: PUBLICATION.route,
      url: '/projects/p1/publication?q=1',
    });
  });

  it('asks the guards of a route of the request’s with the route’s own path, the site’s base path and trailing slash taken off what the visitor asked for', async () => {
    vi.stubEnv('__NEXT_ROUTER_BASEPATH', '/docs');
    vi.stubEnv('__NEXT_TRAILING_SLASH', 'true');
    hoisted.client.guardRoute.mockResolvedValue({
      ok: true,
      value: {
        body: null,
        headers: [['location', '/docs/sign-in/']],
        kind: 'respond',
        status: 307,
      },
    });
    const response = await delivered(
      '/docs/projects/p%201/publication/?tab=one',
      ['deliver', routeKeyOf(PUBLICATION.route), 'p 1'],
      {
        headers: { cookie: 'reactive_session=abc' },
      },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/docs/sign-in/');
    expect(hoisted.client.guardRoute).toHaveBeenCalledWith('abc', {
      admit: true,
      route: PUBLICATION.route,
      url: '/projects/p%201/publication?tab=one',
    });
    expect(hoisted.fetched).toHaveLength(0);
  });

  it('answers 404 to a request past the rewrite that names the delivery route itself, and asks for nothing', async () => {
    const response = await delivered('/api/reactive-state/deliver/x/p1', PUBLICATION_PATH, {
      headers: { 'x-reactive-direct': KEY },
    });

    expect(response.status).toBe(404);
    expect(hoisted.fetched).toHaveLength(0);
    expect(hoisted.client.guardRoute).not.toHaveBeenCalled();
  });

  it('asks the guards of a read before the page of a route whose guards can only let it on or refuse it, as of one whose guards may answer, and the authority nothing of a route no middleware of which has a guard', async () => {
    hoisted.client.guardRoute.mockResolvedValue({ ok: true, value: { kind: 'refused' } });
    const guarded = await delivered('/projects/p1/settings', [
      'deliver',
      routeKeyOf(SETTINGS.route),
      'p1',
    ]);
    const unguarded = routeHandlers({ envelopes, routes: [NOTES] });
    const free = await delivered(
      '/projects/p1/notes',
      ['deliver', routeKeyOf(NOTES.route), 'p1'],
      {},
      unguarded,
    );

    expect(guarded.status).toBe(403);
    expect(hoisted.client.guardRoute).toHaveBeenCalledExactlyOnceWith(null, {
      admit: true,
      route: SETTINGS.route,
      url: '/projects/p1/settings',
    });
    await expect(free.text()).resolves.toBe('page');
    expect(hoisted.fetched.map((page) => page.url)).toStrictEqual([`${ORIGIN}/projects/p1/notes`]);
  });

  it('answers the page’s body as Node’s fetch decoded it, without the coding it undid nor its length, and a fault for one of a coding it keeps, which no reading for the build’s key sees into', async () => {
    await expect(answeredCoded('gzip')).resolves.toStrictEqual([200, null, null, 'page']);
    await expect(answeredCoded('GZIP, br')).resolves.toStrictEqual([200, null, null, 'page']);
    await expect(answeredCoded('zstd')).resolves.toStrictEqual([200, null, null, 'page']);
    await expect(answeredCoded('compress')).resolves.toStrictEqual([500, null, null, '']);
  });

  it('asks for the page with the visitor’s `Accept-Encoding` as it came but for `zstd`, as the page’s code would read it asked directly', async () => {
    await delivered('/projects/p1/publication', PUBLICATION_PATH, {
      headers: { 'accept-encoding': 'zstd, deflate;q=0.5, gzip' },
    });
    await delivered('/projects/p1/publication', PUBLICATION_PATH, {});

    expect(hoisted.fetched.map((page) => page.headers.get('accept-encoding'))).toStrictEqual([
      'deflate;q=0.5, gzip',
      null,
    ]);
  });

  it('answers a fault that names nothing, never the page’s answer, where the page hands back the build’s key in a header’s name or value or its status text', async () => {
    const plain = routeHandlers({ envelopes, routes: [ITEMS] });
    const reflecting: readonly ((key: string) => ResponseInit)[] = [
      (key) => ({ headers: { 'x-echo': key } }),
      (key) => ({ headers: { 'set-cookie': `seen=${key}; Path=/` } }),
      (key) => ({ headers: { [`x-${key}`]: '1' } }),
      (key) => ({ statusText: key }),
    ];
    const answered: (readonly [number, string, boolean])[] = [];
    for (const init of reflecting) {
      hoisted.page.answer = (asked) =>
        new Response('page', init(asked.headers.get(DIRECT_HEADER) ?? ''));
      const response = await delivered(
        '/api/items',
        ['deliver', routeKeyOf(ITEMS.route)],
        {},
        plain,
      );
      const held = [...response.headers].some(([name, value]) => `${name}${value}`.includes(KEY));
      answered.push([response.status, await response.text(), held]);
    }

    expect(answered).toStrictEqual(reflecting.map(() => [500, '', false]));
  });

  it('ends the page’s body at the build’s key it hands back, the key found across the chunks it comes in, none of it handed on — to a visitor and to the authority’s request for an artifact alike', async () => {
    const plain = routeHandlers({ envelopes, routes: [ITEMS] });
    hoisted.page.answer = (asked) => {
      const key = asked.headers.get(DIRECT_HEADER) ?? '';
      return new Response(chunkedOf(['<p>before ', key.slice(0, 9), `${key.slice(9)} after</p>`]));
    };
    hoisted.client.gate.mockResolvedValue({ ok: true, value: { generation: true, kind: 'pass' } });
    const read = await readWhole(
      await delivered('/api/items', ['deliver', routeKeyOf(ITEMS.route)], {}, plain),
    );
    const made = await readWhole(
      await delivered('/boards/p1', BOARD_PATH, {
        headers: { 'x-reactive-generation': 'g.token' },
      }),
    );

    expect([read, made]).toStrictEqual([
      { failed: true, text: '<p>before ' },
      { failed: true, text: '<p>before ' },
    ]);
  });

  it('hands on the page’s body whole where it holds only the start of the build’s key, between chunks or at its end', async () => {
    const plain = routeHandlers({ envelopes, routes: [ITEMS] });
    const body = ['a ', KEY.slice(0, 5), ' b ', KEY.slice(0, 9)];
    hoisted.page.answer = () => new Response(chunkedOf(body));
    const response = await delivered('/api/items', ['deliver', routeKeyOf(ITEMS.route)], {}, plain);

    await expect(readWhole(response)).resolves.toStrictEqual({
      failed: false,
      text: body.join(''),
    });
  });

  it('answers the page’s body as workerd’s fetch decoded it, gzip or br alone, and a fault for one of any other coding', async () => {
    const agent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Cloudflare-Workers');
    onTestFinished(() => {
      agent.mockRestore();
    });

    await expect(answeredCoded('br')).resolves.toStrictEqual([200, null, null, 'page']);
    await expect(answeredCoded('br, br')).resolves.toStrictEqual([500, null, null, '']);
    await expect(answeredCoded('deflate')).resolves.toStrictEqual([500, null, null, '']);
  });
});
