import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { routeHandlers } from '../src/next/route.ts';
import {
  DELIVERY_KEY_ENV,
  type MiddlewareEnvelope,
  type PlainRouteRegistration,
  routeKeyOf,
} from '../src/routing.ts';

/**
 * The page asked for again through the platform's own `fetch` — Node's, undici's, which this suite
 * leaves as it is — of a request that carries the headers of the hop it came by: undici refuses a
 * request of some of them outright (`Keep-Alive`, `Transfer-Encoding`, `Upgrade`, `Expect`), and
 * none of them is the page's to be handed.
 */

vi.mock(import('next/headers'), () => {
  return {
    cookies: () => Promise.reject(new Error('Routes read the request.')),
    headers: () => Promise.reject(new Error('Routes read the request.')),
  };
});

const KEY = 'the-build-s-delivery-key_0123456789';

/** What the page was asked for with: its method, its headers, and its body. */
interface Asked {
  readonly method: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

const asked: Asked[] = [];

/** The site the page is asked for again of: it answers each request `page`, and keeps what it was. */
const site = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk: string) => {
    body += chunk;
  });
  request.on('end', () => {
    asked.push({ body, headers: request.headers, method: request.method ?? '' });
    response.end('page');
  });
});

/** A route handler under the app's middleware, which has no guard: nothing the authority is asked. */
const ITEMS: PlainRouteRegistration = {
  file: 'api/items/route.ts',
  middleware: [''],
  params: [],
  plain: 'handler',
  route: '/api/items',
};

/** The app's middleware: it reads the body before `next`, so the chain makes a request of it. */
const READING: MiddlewareEnvelope = {
  before: async ({ request }) => {
    await request.text();
    return {};
  },
  id: '',
};

/** The headers of the hop a request came by, beside one of its own (`x-kept`). */
const HOP: Readonly<Record<string, string>> = {
  connection: 'keep-alive, x-hop',
  'content-length': '3',
  expect: '100-continue',
  host: 'visitor.example',
  'keep-alive': 'timeout=5',
  'proxy-connection': 'keep-alive',
  te: 'trailers',
  trailer: 'x-check',
  'transfer-encoding': 'chunked',
  upgrade: 'websocket',
  'x-hop': 'named',
  'x-kept': 'kept',
};

/** The headers of the hop no page is handed, `Connection`'s own aside: the platform sets one. */
const DROPPED: readonly string[] = [
  'expect',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'x-hop',
];

/** What the page was handed of the request's own: the host it was asked at, `x-kept`, the key. */
function keptOf(headers: IncomingHttpHeaders): readonly (string | string[] | undefined)[] {
  return [headers.host, headers['x-kept'], headers['x-reactive-direct']];
}

describe('the page asked for again through Node’s own fetch', () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      site.listen(0, '127.0.0.1', resolve);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    asked.length = 0;
  });

  afterAll(async () => {
    await new Promise((resolve) => {
      site.close(resolve);
    });
  });

  it('is asked without the headers of the hop the request came by, of a read and of a write the envelopes read the body of alike', async () => {
    vi.stubEnv(DELIVERY_KEY_ENV, KEY);
    const origin = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}`;
    const { GET: get, POST: post } = routeHandlers({ envelopes: { '': READING }, routes: [ITEMS] });
    const context = { params: Promise.resolve({ path: ['deliver', routeKeyOf(ITEMS.route)] }) };

    const read = await get(new Request(`${origin}/api/items`, { headers: HOP }), context);
    const written = await post(
      new Request(`${origin}/api/items`, { body: 'abc', headers: HOP, method: 'POST' }),
      context,
    );

    const dropped = asked.map(({ headers }) =>
      DROPPED.filter((name) => headers[name] !== undefined),
    );
    const kept = asked.map(({ headers }) => keptOf(headers));
    const own = [origin.slice('http://'.length), 'kept', KEY];

    expect([read.status, written.status]).toStrictEqual([200, 200]);
    await expect(written.text()).resolves.toBe('page');
    expect(asked.map(({ body, method }) => [method, body])).toStrictEqual([
      ['GET', ''],
      ['POST', 'abc'],
    ]);
    expect(dropped).toStrictEqual([[], []]);
    expect(kept).toStrictEqual([own, own]);
  });
});
