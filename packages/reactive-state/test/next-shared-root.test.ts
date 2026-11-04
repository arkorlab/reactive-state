import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AuthorityClient } from '../src/client/index.ts';
import type * as Authority from '../src/next/authority.ts';
import type { Elements } from '../src/next/render.ts';
import { renderRouteRoot } from '../src/next/shared-root.ts';
import type { SharedRenderRequest } from '../src/routing.ts';

/**
 * A route's page as it renders its root (`renderRouteRoot`): what it asks the authority for — the
 * route, its props, the build, and where the site serves its routes as Next.js compiled the build
 * (`basePath`, `trailingSlash`), which Next.js writes into the module and the suite stands in for
 * with the environment. The request's cookie and headers, and the authority, are stood in for.
 */

const hoisted = vi.hoisted(() => ({ requests: [] as unknown[] }));

vi.mock(import('next/headers'), () => {
  return {
    // No cookie: no session.
    cookies: () => Promise.resolve(new Map()) as never,
    headers: () => Promise.resolve(new Headers()),
  };
});
vi.mock(import('../src/next/authority.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal<typeof Authority>()),
    authority: () => {
      return {
        renderShared: (_session: unknown, request: SharedRenderRequest) => {
          hoisted.requests.push(request);
          // The route renders no shared way: the page renders nothing of it here.
          return Promise.resolve({
            code: 'UNKNOWN_ROUTE',
            message: 'There is no such route.',
            ok: false,
            status: 404,
          });
        },
      } as unknown as AuthorityClient;
    },
  };
});

const ELEMENTS: Elements = { actions: {}, build: 'b_site', clients: {}, modules: {} };

/** What the page asks the authority for, as it renders p1's board. */
async function asked(): Promise<unknown> {
  hoisted.requests.length = 0;
  await renderRouteRoot({
    component: 'components/board',
    elements: ELEMENTS,
    events: '/api/reactive-state/events',
    live: () => Promise.reject(new Error('Not called here.')),
    props: { projectId: 'p1' },
    route: '/boards/[projectId]',
  });
  return hoisted.requests[0];
}

describe('a route’s page, rendering its root', () => {
  it('tells the authority where the site serves its routes, as Next.js compiled the build', async () => {
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    await expect(asked()).resolves.toStrictEqual({
      build: 'b_site',
      props: { projectId: 'p1' },
      route: '/boards/[projectId]',
      site: { basePath: '', trailingSlash: false },
    });

    vi.stubEnv('__NEXT_ROUTER_BASEPATH', '/docs');
    vi.stubEnv('__NEXT_TRAILING_SLASH', 'true');

    await expect(asked()).resolves.toMatchObject({
      site: { basePath: '/docs', trailingSlash: true },
    });

    // `skipTrailingSlashRedirect`, as Next.js compiles it in: each path served at either form.
    vi.stubEnv('__NEXT_MANUAL_TRAILING_SLASH', 'true');

    await expect(asked()).resolves.toMatchObject({
      site: { basePath: '/docs', skipTrailingSlashRedirect: true, trailingSlash: true },
    });
  });
});
