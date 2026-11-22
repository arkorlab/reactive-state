import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';

import { startAuthority } from '../src/authority/index.ts';
import { type AuthorityClient, httpClient } from '../src/client/index.ts';
import type * as Authority from '../src/next/authority.ts';
import { routeHandlers } from '../src/next/route.ts';
import { renderRouteRoot } from '../src/next/shared-root.ts';
import { type ComponentProgram, PROTOCOL_VERSION, SESSION_COOKIE } from '../src/program.ts';
import {
  DELIVERY_KEY_ENV,
  DIRECT_HEADER,
  type MiddlewareProgram,
  type RouteRegistration,
  routeKeyOf,
} from '../src/routing.ts';
import { currentUser, forbidden, requireUser } from '../src/server/index.ts';
import { textOf } from './support/frames.ts';
import { application, BUILD } from './support/program.ts';

/** One delivered HTTP page and its root, speaking to the authority over its actual HTTP client. */
const hoisted = vi.hoisted(() => {
  return {
    client: undefined as AuthorityClient | undefined,
    requested: (): Headers => new Headers(),
  };
});

vi.mock(import('next/headers'), () => {
  return {
    headers: () => Promise.resolve(hoisted.requested()),
    cookies: () => {
      const cookies = new Map<string, { value: string }>();
      const parts = (hoisted.requested().get('cookie') ?? '').split(';');
      for (const part of parts) {
        const at = part.indexOf('=');
        if (at !== -1) cookies.set(part.slice(0, at).trim(), { value: part.slice(at + 1).trim() });
      }
      return Promise.resolve(cookies) as never;
    },
  };
});
vi.mock(import('../src/next/authority.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal<typeof Authority>()),
    authority: () => {
      if (hoisted.client === undefined) throw new Error('The test authority is not open.');
      return hoisted.client;
    },
  };
});

const KEY = 'guard-admission-delivery-key_0123456789';
const ADMISSION = 'x-reactive-admission';
const ROOT = 'components/guarded-delivery';
const ROUTE: RouteRegistration = {
  blocking: true,
  guarded: true,
  middleware: [''],
  page: 'once/[id]/page.tsx',
  params: ['id'],
  props: { id: 'id' },
  root: ROOT,
  route: '/once/[id]',
  shared: false,
};
const program: ComponentProgram = {
  buildId: BUILD,
  component: ROOT,
  evaluate: (props, $) => Promise.resolve($.h('p', null, `root:${String(props['id'])}`)),
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};
const context = new AsyncLocalStorage<Headers>();
const observed = { after: 0, before: 0, pages: [] as Headers[], roots: 1 };
const registry = {
  envelopes: {
    '': {
      after: (_locals: Readonly<Record<string, unknown>>, response: Response) => {
        observed.after += 1;
        response.headers.set('x-envelope', 'after');
      },
      before: () => {
        observed.before += 1;
        return {};
      },
      id: '',
    },
  },
  routes: [ROUTE],
};

/** The incoming headers as Headers, without assuming each Node field is a single string. */
function headersOf(given: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(given)) {
    if (typeof value === 'string') headers.set(name, value);
    if (Array.isArray(value)) headers.set(name, value.join(', '));
  }
  return headers;
}

/** Next's page stand-in: its root really calls renderShared through the HTTP authority client. */
async function page(request: Request): Promise<Response> {
  observed.pages.push(request.headers);
  const id = new URL(request.url).pathname.split('/').at(-1) ?? '';
  const roots: string[] = [];
  for (let index = 0; index < observed.roots; index += 1) {
    const rendered = await context.run(request.headers, () => {
      return renderRouteRoot({
        component: ROOT,
        elements: { actions: {}, build: BUILD, clients: {}, modules: {} },
        events: '/api/reactive-state/events',
        live: (result) =>
          Promise.resolve(result.status === 'rendered' ? textOf(result.tree) : null),
        props: { id },
        route: ROUTE.route,
      });
    });
    if (rendered !== null && typeof rendered !== 'string') {
      throw new TypeError('The test root must render text or null.');
    }
    roots.push(rendered ?? '');
  }
  return new Response(`<main>${roots.join('|')}</main>`);
}

/** The generated public route and the trusted page fetch, with the same rewrite boundary. */
async function answer(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  const origin = `http://127.0.0.1:${String(incoming.socket.localPort)}`;
  const request = new Request(new URL(incoming.url ?? '/', origin), {
    headers: headersOf(incoming.headers),
    method: incoming.method ?? 'GET',
  });
  const url = new URL(request.url);
  let response: Response;
  if (request.headers.get(DIRECT_HEADER) === KEY) {
    response = await page(request);
  } else {
    const paths = url.pathname.startsWith('/api/reactive-state/')
      ? url.pathname.slice('/api/reactive-state/'.length).split('/')
      : ['deliver', routeKeyOf(ROUTE.route), url.pathname.split('/').at(-1) ?? ''];
    const handlers = routeHandlers(registry);
    const handler = request.method === 'POST' ? handlers.POST : handlers.GET;
    response = await handler(request, { params: Promise.resolve({ path: paths }) });
  }
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

const site = createServer((request, response) => {
  void answer(request, response).catch((error: unknown) => {
    response.writeHead(500);
    response.end(String(error));
  });
});

/** A fresh guard program, so each case measures exactly its own source executions. */
async function opened(guard: MiddlewareProgram['guard']) {
  const authority = await startAuthority({
    ...application,
    middleware: { '': { buildId: BUILD, guard, id: '', protocolVersion: PROTOCOL_VERSION } },
    programs: [program],
    routes: [ROUTE],
  });
  hoisted.client = httpClient({ token: authority.token, url: authority.url });
  observed.after = 0;
  observed.before = 0;
  observed.pages.length = 0;
  observed.roots = 1;
  vi.stubEnv(DELIVERY_KEY_ENV, KEY);
  onTestFinished(async () => {
    await authority.close();
    hoisted.client = undefined;
    vi.unstubAllEnvs();
  });
  const origin = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}`;
  return { authority, origin };
}

describe('one guard admission for a delivered HTTP page', () => {
  beforeAll(async () => {
    hoisted.requested = () => context.getStore() ?? new Headers();
    await new Promise<void>((resolve) => {
      site.listen(0, '127.0.0.1', resolve);
    });
  });

  afterAll(async () => {
    site.closeAllConnections();
    await new Promise<void>((resolve) => {
      site.close(() => {
        resolve();
      });
    });
  });

  it.each(['refusal', 'response'])(
    'renders the root after a guard that permits the first request only: %s',
    async (later) => {
      const admitted = new Set<string>();
      const { origin } = await opened(({ params }) => {
        const id = params['id'] ?? '';
        if (!admitted.has(id)) {
          admitted.add(id);
          return;
        }
        if (later === 'refusal') forbidden();
        return { body: 'sign in', headers: [['location', '/sign-in']], status: 307 };
      });
      const first = await fetch(`${origin}/once/main`);
      const firstBody = await first.text();
      const second = await fetch(`${origin}/once/main`, { redirect: 'manual' });

      expect([first.status, firstBody, second.status]).toStrictEqual([
        200,
        '<main>root:main</main>',
        later === 'refusal' ? 403 : 307,
      ]);
      expect(observed.pages).toHaveLength(1);
      expect(observed.before).toBe(2);
      expect(observed.after).toBe(1);
    },
  );

  it('ignores a previously issued decision replayed through public delivery', async () => {
    let allowed = true;
    const { origin } = await opened(() => {
      if (!allowed) forbidden();
      allowed = false;
    });
    const first = await fetch(`${origin}/once/main`);
    await first.text();
    const admission = observed.pages[0]?.get(ADMISSION) ?? 'missing-before-fix';
    const replayed = await fetch(`${origin}/once/main`, { headers: { [ADMISSION]: admission } });

    expect(replayed.status).toBe(403);
    expect(observed.pages).toHaveLength(1);
  });

  it('reuses a decision for multiple roots of the same delivered page', async () => {
    let allowed = true;
    let calls = 0;
    const { origin } = await opened(() => {
      calls += 1;
      if (!allowed) forbidden();
      allowed = false;
    });
    observed.roots = 2;
    const response = await fetch(`${origin}/once/main`);

    await expect(response.text()).resolves.toBe('<main>root:main|root:main</main>');
    expect(calls).toBe(1);
  });

  it.each(['guard', 'shared/render'])(
    'requires the internal credential at the raw authority %s endpoint',
    async (path) => {
      const { authority } = await opened(() => {
        // The guard permits every request.
      });
      const response = await fetch(`${authority.url}/api/${path}`, { method: 'POST' });

      expect(response.status).toBe(403);
      expect(observed.pages).toHaveLength(0);
    },
  );

  it('checks every fresh visitor request once', async () => {
    let calls = 0;
    const { origin } = await opened(() => {
      calls += 1;
    });
    const first = await fetch(`${origin}/once/main`);
    const second = await fetch(`${origin}/once/main`);

    await expect(first.text()).resolves.toBe('<main>root:main</main>');
    await expect(second.text()).resolves.toBe('<main>root:main</main>');
    expect(calls).toBe(2);
  });

  it('refuses before the page and every after part where its guard refuses', async () => {
    const { origin } = await opened(() => forbidden());
    const response = await fetch(`${origin}/once/main`);

    expect(response.status).toBe(403);
    expect(observed.pages).toHaveLength(0);
    expect(observed.after).toBe(0);
  });

  it('keeps a session-reading guard and the page in the same session', async () => {
    const { authority, origin } = await opened(async () => {
      const user = await requireUser();
      if (user.id !== 'alice') forbidden();
    });
    const alice = await authority.engine.login('alice');
    const response = await fetch(`${origin}/once/main`, {
      headers: { cookie: `${SESSION_COOKIE}=${alice.sessionId}` },
    });

    await expect(response.text()).resolves.toBe('<main>root:main</main>');
    expect(response.status).toBe(200);
  });

  it('keeps an optional session guard available to anonymous requests', async () => {
    const { origin } = await opened(async () => {
      if ((await currentUser()) !== null) forbidden();
    });
    const response = await fetch(`${origin}/once/main`);

    await expect(response.text()).resolves.toBe('<main>root:main</main>');
    expect(response.status).toBe(200);
  });

  it.each([
    { headers: new Headers(), name: 'no delivery key' },
    {
      headers: new Headers({ [DIRECT_HEADER]: 'wrong-delivery-key' }),
      name: 'incorrect delivery key',
    },
  ])('ignores a real decision with $name', async ({ headers }) => {
    let allowed = true;
    const { origin } = await opened(() => {
      if (!allowed) forbidden();
      allowed = false;
    });
    const first = await fetch(`${origin}/once/main`);
    await first.text();
    const admission = observed.pages[0]?.get(ADMISSION) ?? 'missing-before-fix';
    const requested = new Headers(headers);
    requested.set(ADMISSION, admission);
    const rendered = await context.run(requested, () => {
      return renderRouteRoot({
        component: ROOT,
        elements: { actions: {}, build: BUILD, clients: {}, modules: {} },
        events: '/api/reactive-state/events',
        live: (result) =>
          Promise.resolve(result.status === 'rendered' ? textOf(result.tree) : null),
        props: { id: 'main' },
        route: ROUTE.route,
      });
    });

    expect(rendered).toBeNull();
  });

  it('still runs guards on a direct page render without an admission', async () => {
    const { origin } = await opened(() => forbidden());
    const response = await fetch(`${origin}/once/main`, { headers: { [DIRECT_HEADER]: KEY } });

    await expect(response.text()).resolves.toBe('<main></main>');
    expect(observed.pages).toHaveLength(1);
  });

  it.each(['guard', 'shared/render'])(
    'exposes no raw authority admission endpoint at the public %s path',
    async (path) => {
      const { origin } = await opened(() => forbidden());
      const response = await fetch(`${origin}/api/reactive-state/${path}`, { method: 'POST' });

      expect(response.status).toBe(404);
      expect(observed.pages).toHaveLength(0);
    },
  );

  it('replaces a visitor admission header with the freshly checked authority answer', async () => {
    const { origin } = await opened(() => {
      // The guard permits every request.
    });
    const response = await fetch(`${origin}/once/main`, {
      headers: { [ADMISSION]: 'visitor-forgery' },
    });

    await expect(response.text()).resolves.toBe('<main>root:main</main>');
    // An admission of the authority's own, not none: the visitor's merely taken off would be none.
    expect(observed.pages[0]?.get(ADMISSION)).toMatch(/./u);
    expect(observed.pages[0]?.get(ADMISSION)).not.toBe('visitor-forgery');
  });
});
