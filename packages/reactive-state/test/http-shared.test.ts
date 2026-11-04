import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AuthorityEngine } from '../src/authority/engine.ts';
import { handleShared } from '../src/authority/http-shared.ts';
import { type Authority, startAuthority } from '../src/authority/index.ts';
import { sharedEventText } from '../src/authority/shared-events.ts';
import {
  type ComponentProgram,
  INTERNAL_HEADER,
  PROTOCOL_VERSION,
  type RenderScope,
} from '../src/program.ts';
import {
  GATE_DEPLOYMENT_HEADER,
  GATE_ROUTE_HEADER,
  GENERATION_HEADER,
  type MiddlewareProgram,
  type SharedEvent,
  type SiteShape,
} from '../src/routing.ts';
import { nextPageParam } from './support/next-page.ts';
import { application, BUILD as APP_BUILD } from './support/program.ts';
import { open, viewTokenOf } from './support/shared-fixture.ts';

/**
 * A shared view's routes on the Node authority (`http-shared.ts`): asked directly of a request and
 * a response that stand in for a client's, against the engine-only application of
 * `support/shared-fixture.ts`; and over HTTP, as the edge's route gate asks them, of the test
 * application with a route of its own.
 */

/** The header the edge's gate tells the authority the visitor's URL in. */
const GATE_URL_HEADER = 'x-upwind-gate-url';
/** How often the Node authority's shared stream says it is alive while it says nothing else. */
const HEARTBEAT_MS = 15_000;

/**
 * Each field a shared cache reads in place of `Cache-Control`, as each one's documentation writes it:
 * RFC 9213's, Cloudflare's, Vercel's, Netlify's and Akamai's targeted fields, Akamai's older one, the
 * W3C's `Surrogate-Control` (Fastly's, among others), and nginx's.
 */
const SHARED_CACHE_FIELDS: readonly string[] = [
  'CDN-Cache-Control',
  'Cloudflare-CDN-Cache-Control',
  'Vercel-CDN-Cache-Control',
  'Netlify-CDN-Cache-Control',
  'Akamai-Cache-Control',
  'Edge-Control',
  'Surrogate-Control',
  'X-Accel-Expires',
];

/**
 * A route every visitor is turned away from by its guard, with a redirect of its own: two cookies,
 * and a lifetime of its own besides, for the browser and for every shared cache — which no answer
 * of the gate's keeps.
 */
const TURNED_AWAY = '/turned-away/[id]';
const turnedAway: MiddlewareProgram = {
  buildId: APP_BUILD,
  guard: () => {
    return {
      body: '',
      headers: [
        ['Location', '/sign-in'],
        ['Set-Cookie', 'first=1; Path=/'],
        ['Set-Cookie', 'second=2; Path=/'],
        ['Cache-Control', 'public, max-age=3600'],
        ...SHARED_CACHE_FIELDS.map((name) => [name, 'max-age=3600'] as const),
      ],
      status: 307,
    };
  },
  id: 'turned-away',
  protocolVersion: PROTOCOL_VERSION,
};
/** The route's root, which no visitor reaches. */
const unreached: ComponentProgram = {
  buildId: APP_BUILD,
  component: 'components/unreached',
  evaluate: (_props: Readonly<Record<string, unknown>>, $: RenderScope) => $.h('p', null, 'in'),
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

/** A page every visitor is shown alike, whose root reads nothing. */
const HELLO = '/hello/[id]';
const hello: ComponentProgram = {
  buildId: APP_BUILD,
  component: 'components/hello',
  evaluate: (_props: Readonly<Record<string, unknown>>, $: RenderScope) => $.h('p', null, 'hello'),
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};
/** Where the site serves its routes: under `/docs`, each path ending with a slash. */
const DOCS: SiteShape = { basePath: '/docs', trailingSlash: true };
/** What a rule of the hello page's `headers()` lays on a request that sends no `x-visitor`. */
const VISITOR_RULE: readonly [string, string] = ['x-frame-options', 'DENY'];

/**
 * The hello page as a site of `DOCS` serves it to the authority's request for an artifact, its root
 * rendered as its root entry renders it — of `deployment`, where it names one, as Next.js names it
 * on a page (`x-nextjs-deployment-id`) — with what a rule of `next.config`'s `headers()` lays on a
 * request that sends no `x-visitor` (its `missing`), as the authority's own does not
 * (`VISITOR_RULE`); nothing at any other path.
 */
async function servedPage(
  authority: Authority,
  request: IncomingMessage,
  response: ServerResponse,
  deployment?: string,
): Promise<void> {
  const asked = /^\/docs\/hello\/(?<id>[^/]+)\/$/u.exec(request.url ?? '');
  const generation = request.headers[GENERATION_HEADER];
  if (typeof generation !== 'string' || asked?.groups === undefined) {
    response.writeHead(404).end();
    return;
  }
  const answer = await authority.engine.renderShared(null, {
    build: APP_BUILD,
    generation,
    props: { id: nextPageParam(asked.groups['id'] ?? '') },
    route: HELLO,
  });
  const type = request.headers['rsc'] === '1' ? 'text/x-component' : 'text/html';
  const named = deployment === undefined ? {} : { 'x-nextjs-deployment-id': deployment };
  const ruled =
    request.headers['x-visitor'] === undefined ? Object.fromEntries([VISITOR_RULE]) : {};
  response
    .writeHead(200, { 'content-type': type, ...named, ...ruled })
    .end(JSON.stringify(answer.result.tree));
}

/**
 * An authority of the hello page, and its site of `DOCS` — of `deployment`, where it names one —
 * which it is told of as the host tells it its site; with the path of each request the site was
 * asked, in order, and the edge's question of the visitor's URL `url` — as its route gate asks one,
 * of the page's route, with any more of the protocol's `headers`.
 */
async function helloAuthority(deployment?: string): Promise<{
  readonly authority: Authority;
  readonly asked: readonly string[];
  readonly ask: (url: string, headers?: Readonly<Record<string, string>>) => Promise<Response>;
}> {
  const authority = await startAuthority({
    ...application,
    programs: [...application.programs, hello],
    routes: [
      {
        blocking: true,
        middleware: [],
        page: 'hello/[id]/page.tsx',
        params: ['id'],
        props: { id: 'id' },
        root: hello.component,
        route: HELLO,
        shared: true,
      },
    ],
  });
  onTestFinished(authority.close);
  const asked: string[] = [];
  const site = createServer((request, response) => {
    asked.push(request.url ?? '');
    void servedPage(authority, request, response, deployment).catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => {
    site.listen(0, '127.0.0.1', resolve);
  });
  onTestFinished(() => {
    site.closeAllConnections();
    site.close();
  });
  // The host, as it tells the authority its site: where that site serves its routes besides.
  authority.site(`http://127.0.0.1:${String((site.address() as AddressInfo).port)}`, DOCS);
  const ask = async (
    url: string,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<Response> => {
    return fetch(`${authority.url}/internal/gate`, {
      headers: {
        ...headers,
        [GATE_ROUTE_HEADER]: HELLO,
        [GATE_URL_HEADER]: url,
        [INTERNAL_HEADER]: authority.token,
      },
    });
  };
  return { ask, asked, authority };
}

/**
 * A request or a response as the route reads one: whether it is gone, what was written to it, and
 * its `close`.
 */
// eslint-disable-next-line unicorn/prefer-event-target -- a Node request and response are EventEmitters, which the route listens to
class Side extends EventEmitter {
  destroyed = false;
  readonly socket = { destroyed: false };
  readonly written: string[] = [];
  ended = false;
  /** Whether the client has yet to take what was written, as a `write` answers it. */
  full = false;

  writeHead(): this {
    return this;
  }

  write(chunk: string): boolean {
    this.written.push(chunk);
    return !this.full;
  }

  end(): void {
    this.ended = true;
  }

  /** The client took what was written: the response drains. */
  drain(): void {
    this.full = false;
    this.emit('drain');
  }

  /** The client leaves: the connection gone, and closed. */
  leave(): void {
    this.destroyed = true;
    this.socket.destroyed = true;
    this.emit('close');
  }
}

describe('a shared view’s routes on the Node authority', () => {
  it('opens no event stream for a client that left while its following was looked up', async () => {
    const { engine } = await open();
    const token = await viewTokenOf(engine, 'p1');
    const req = new Side();
    const res = new Side();
    const streams = new Set<ServerResponse>();
    const handled = handleShared({
      engine,
      method: 'GET',
      req: req as unknown as IncomingMessage,
      res: res as unknown as ServerResponse,
      streams,
      url: new URL(`http://authority.test/api/shared/events?view=${encodeURIComponent(token)}`),
    });
    // The client leaves while the following waits its turn in the engine's queue.
    req.leave();
    res.leave();

    await expect(handled).resolves.toBe(true);
    expect(res.written).toStrictEqual([]);
    expect(res.ended).toBe(true);
    expect(streams.size).toBe(0);
    // Nothing follows the view: it is kept no longer than any other.
    await expect(engine.stats()).resolves.toMatchObject({ sharedStreams: 0 });
  });

  it('owes a client that is behind only what its page still acts on, written as its response drains, and no heartbeat meanwhile', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const listeners = new Set<(event: SharedEvent) => void>();
    const following = {
      listen: (listener: (event: SharedEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      missed: [],
      stop: () => {
        listeners.clear();
      },
    };
    const emit = (event: SharedEvent): void => {
      for (const listener of listeners) {
        listener(event);
      }
    };
    const req = new Side();
    const res = new Side();
    onTestFinished(() => {
      req.leave();
      res.leave();
    });
    await handleShared({
      engine: { followShared: () => Promise.resolve(following) } as unknown as AuthorityEngine,
      method: 'GET',
      req: req as unknown as IncomingMessage,
      res: res as unknown as ServerResponse,
      streams: new Set(),
      url: new URL('http://authority.test/api/shared/events?view=v'),
    });
    // The client takes nothing more: what is written next waits for it, and what comes after it is
    // owed — every generation of the epoch, heartbeats, a denial and what follows it.
    res.full = true;
    for (let generation = 1; generation <= 1000; generation += 1) {
      emit({ epoch: 1, generation, kind: 'ready' });
    }
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 4);
    emit({ epoch: 2, kind: 'denied' });
    emit({ epoch: 2, generation: 1001, kind: 'ready' });

    expect(res.written).toStrictEqual([
      ': open\n\n',
      sharedEventText({ epoch: 1, generation: 1, kind: 'ready' }),
    ]);

    res.drain();

    expect(res.written.slice(2)).toStrictEqual([
      sharedEventText({ epoch: 2, kind: 'denied' }) +
        sharedEventText({ epoch: 2, generation: 1001, kind: 'ready' }),
    ]);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    expect(res.written.slice(3)).toStrictEqual([': heartbeat\n\n']);
  });

  it('answers the edge’s gate with each header a guard repeats, and no lifetime but its own', async () => {
    const authority = await startAuthority({
      ...application,
      middleware: { 'turned-away': turnedAway },
      programs: [...application.programs, unreached],
      routes: [
        {
          blocking: true,
          guarded: true,
          middleware: ['turned-away'],
          page: 'turned-away/[id]/page.tsx',
          params: ['id'],
          props: { id: 'id' },
          root: unreached.component,
          route: TURNED_AWAY,
          shared: true,
        },
      ],
    });
    onTestFinished(authority.close);

    const answer = await fetch(`${authority.url}/internal/gate`, {
      headers: {
        [GATE_ROUTE_HEADER]: TURNED_AWAY,
        [GATE_URL_HEADER]: 'https://site.test/turned-away/main',
        [INTERNAL_HEADER]: authority.token,
      },
      redirect: 'manual',
    });

    expect(answer.status).toBe(307);
    expect(answer.headers.get('location')).toBe('/sign-in');
    expect(answer.headers.getSetCookie()).toStrictEqual(['first=1; Path=/', 'second=2; Path=/']);
    expect(answer.headers.get('cache-control')).toBe('private, no-store');
    // None of what a shared cache would read in its place, and keep the session's answer by.
    expect(SHARED_CACHE_FIELDS.filter((name) => answer.headers.has(name))).toStrictEqual([]);
  });

  it('answers the edge’s first question of a site under a base path from the view, told where the site serves its routes', async () => {
    const { ask } = await helloAuthority();

    const answer = await ask('https://site.test/docs/hello/x/');

    expect(answer.status).toBe(200);
    await expect(answer.text()).resolves.toContain('hello');
  });

  it('answers a failing If-Match or an old If-Unmodified-Since as Next.js answers them of a page: with the artifact, or the 304 an If-None-Match beside it asks for', async () => {
    const { ask } = await helloAuthority();
    const url = 'https://site.test/docs/hello/x/';
    const etag = (await ask(url)).headers.get('etag') ?? '';
    const preconditions = {
      'if-match': '"no-such-tag"',
      'if-unmodified-since': 'Thu, 01 Jan 1970 00:00:00 GMT',
    };

    const failing = await ask(url, preconditions);
    const both = await ask(url, { ...preconditions, 'if-none-match': etag });

    expect(etag).not.toBe('');
    expect([failing.status, failing.headers.get('etag')]).toStrictEqual([200, etag]);
    await expect(failing.text()).resolves.toContain('hello');
    expect(both.status).toBe(304);
  });

  it('answers the edge’s question of a deployment with an artifact that deployment made, and lets one that names none through', async () => {
    const { ask, asked } = await helloAuthority('dpl_hello');

    const answer = await ask('https://site.test/docs/hello/x/', {
      [GATE_DEPLOYMENT_HEADER]: 'dpl_hello',
    });
    // An edge older than this, which names no deployment: no artifact of one is answered to it.
    const unnamed = await ask('https://site.test/docs/hello/x/');

    expect(answer.status).toBe(200);
    expect(unnamed.status).toBe(204);
    expect(asked).toHaveLength(2);
  });

  it('answers the edge’s question and the delivery route’s with the page’s own headers alone, none a rule laid on the authority’s request that does not hold for the visitor', async () => {
    const { ask, authority } = await helloAuthority();

    // The edge's question, of a visitor that sends `x-visitor`: the rule holds for it not.
    const asked = await ask('https://site.test/docs/hello/x/', { 'x-visitor': '1' });
    // The delivery route's, as its Function asks it, of the same visitor.
    const delivered = await fetch(`${authority.url}/api/gate`, {
      body: JSON.stringify({
        headers: { 'x-visitor': '1' },
        method: 'GET',
        route: HELLO,
        url: '/docs/hello/x/',
      }),
      headers: { 'content-type': 'application/json', [INTERNAL_HEADER]: authority.token },
      method: 'POST',
    });
    const answer = (await delivered.json()) as { readonly headers: readonly [string, string][] };

    expect(asked.status).toBe(200);
    expect(asked.headers.has(VISITOR_RULE[0])).toBe(false);
    expect(answer.headers.map(([name]) => name)).not.toContain(VISITOR_RULE[0]);
  });

  it('reads the edge’s question of a param as Next.js hands it to the page, asking for the page at it — a slash in it one segment — and lets one no page is handed through', async () => {
    const { ask, asked } = await helloAuthority();

    // `..`, however encoded, is a step of the visitor's path, never a param: the page above's.
    for (const url of [
      'https://site.test/docs/hello/%2E%2E/',
      'https://site.test/docs/hello/../',
    ]) {
      const passed = await ask(url);

      expect(passed.status).toBe(204);
    }

    expect(asked).toStrictEqual([]);

    const answer = await ask('https://site.test/docs/hello/a%2Fb/');

    expect(answer.status).toBe(200);
    expect(asked).toStrictEqual(['/docs/hello/a%2Fb/', '/docs/hello/a%2Fb/']);
  });
});
