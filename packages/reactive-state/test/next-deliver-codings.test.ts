import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { zstdCompressSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { routeHandlers } from '../src/next/route.ts';
import { DELIVERY_KEY_ENV, type PlainRouteRegistration, routeKeyOf } from '../src/routing.ts';

/**
 * The codings the page is asked for again in, of those the request takes: the visitor's as they
 * came, but `zstd`, which the `fetch` of a Node this package runs on may hand on as it came. The
 * site the page is asked of is Node's own `fetch` of a site on a loopback port, or a stand-in for
 * a `fetch` that undoes no `zstd`, where a row gives one.
 */

const hoisted = vi.hoisted(() => {
  const fetched: Request[] = [];
  /** The page's answer in place of the site's, made of the request it is asked with. */
  const page: { answer: ((asked: Request) => Response) | undefined } = { answer: undefined };
  const real = globalThis.fetch;
  // In place before the route's modules load, which take `fetch` as they are evaluated.
  vi.stubGlobal('fetch', async (input: Request | URL | string, init?: RequestInit) => {
    const asked = new Request(input, init);
    fetched.push(asked.clone());
    return page.answer === undefined ? real(asked) : page.answer(asked);
  });
  return { fetched, page };
});

vi.mock(import('next/headers'), () => {
  return {
    cookies: () => Promise.reject(new Error('Routes read the request.')),
    headers: () => Promise.reject(new Error('Routes read the request.')),
  };
});

const ORIGIN = 'http://localhost:3000';
const KEY = 'the-build-s-delivery-key_0123456789';
/** The document a page answers: text beyond ASCII. */
const DOCUMENT = '<p>済</p>';

/** A route handler under the app's middleware, which has no guard: nothing the authority is asked. */
const ITEMS: PlainRouteRegistration = {
  file: 'api/items/route.ts',
  middleware: [''],
  params: [],
  plain: 'handler',
  route: '/api/items',
};

const { GET: get } = routeHandlers({ envelopes: {}, routes: [ITEMS] });

/** A read the rewrite of the handler's route brought, with the `Accept-Encoding` a visitor sent, or none. */
function accepting(accepted: string | undefined, origin = ORIGIN): Promise<Response> {
  const headers: Record<string, string> = {};
  if (accepted !== undefined) {
    headers['accept-encoding'] = accepted;
  }
  return get(new Request(`${origin}/api/items`, { headers }), {
    params: Promise.resolve({ path: ['deliver', routeKeyOf(ITEMS.route)] }),
  });
}

/** Whether a request's `Accept-Encoding` names `zstd`, as a site that answers in it reads it. */
function takesZstd(accepted: string | null | undefined): boolean {
  return /(?:^|,)\s*zstd\s*(?:,|;|$)/iu.test(accepted ?? '');
}

/**
 * A site on a loopback port of its own whose page answers the document in `zstd` where it is asked
 * for it, and as it is otherwise; and the `Accept-Encoding` each request came with. Closed when the
 * test finishes.
 */
async function zstdSite(): Promise<{
  readonly origin: string;
  readonly accepted: (string | undefined)[];
}> {
  const accepted: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    const asked = request.headers['accept-encoding'];
    accepted.push(asked);
    if (takesZstd(asked)) {
      response.writeHead(200, { 'content-encoding': 'zstd', 'content-type': 'text/html' });
      response.end(zstdCompressSync(DOCUMENT));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(DOCUMENT);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  onTestFinished(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  });
  return { accepted, origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
}

describe('the codings the page is asked for again in', () => {
  beforeEach(() => {
    hoisted.fetched.length = 0;
    hoisted.page.answer = () => new Response('page', { headers: { 'content-type': 'text/html' } });
    vi.stubEnv(DELIVERY_KEY_ENV, KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('are the visitor’s without `zstd`, of a site that answers in it where it is asked: the page’s text is handed on, through Node’s own fetch', async () => {
    hoisted.page.answer = undefined;
    const { accepted, origin } = await zstdSite();

    const response = await accepting('gzip, deflate, br, zstd', origin);

    expect(accepted).toStrictEqual(['gzip, deflate, br']);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBeNull();
    await expect(response.text()).resolves.toBe(DOCUMENT);
  });

  it('leave a fetch that undoes no `zstd`, as Node’s before 24.4, nothing coded to hand on as if it were text', async () => {
    // Such a fetch hands the body as it came, with the coding it came in.
    hoisted.page.answer = (asked) => {
      return takesZstd(asked.headers.get('accept-encoding'))
        ? new Response(zstdCompressSync(DOCUMENT), {
            headers: { 'content-encoding': 'zstd', 'content-type': 'text/html' },
          })
        : new Response(DOCUMENT, { headers: { 'content-type': 'text/html' } });
    };

    const response = await accepting('gzip, deflate, br, zstd');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBeNull();
    await expect(response.text()).resolves.toBe(DOCUMENT);
  });

  it.each([
    ['gzip, deflate, br, zstd', 'gzip, deflate, br'],
    ['zstd, deflate', 'deflate'],
    ['zstd', 'identity'],
    ['ZSTD;q=1.0, gzip;q=0.5', 'gzip;q=0.5'],
    ['gzip;q=1.0, zstd ;q=0.8, br;q=0.6', 'gzip;q=1.0, br;q=0.6'],
    ['*', 'identity'],
    ['gzip, *;q=0.1', 'gzip'],
    ['br;q=1.0, *;q=0', 'br;q=1.0'],
  ])('are `%s` without what may be `zstd`: `%s`', async (accepted, asked) => {
    await accepting(accepted);

    expect(hoisted.fetched.map((page) => page.headers.get('accept-encoding'))).toStrictEqual([
      asked,
    ]);
  });

  it.each([
    ['gzip, deflate, br', 'gzip, deflate, br'],
    ['gzip', 'gzip'],
    ['identity', 'identity'],
    ['x-zstd, zstdx;q=0.5, gzip', 'x-zstd, zstdx;q=0.5, gzip'],
    ['', ''],
    [undefined, null],
  ])('are the visitor’s as they came where none may be `zstd`: `%s`', async (accepted, asked) => {
    await accepting(accepted);

    expect(hoisted.fetched.map((page) => page.headers.get('accept-encoding'))).toStrictEqual([
      asked,
    ]);
  });
});
