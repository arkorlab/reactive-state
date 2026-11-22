import { describe, expect, it, vi } from 'vitest';

import type { AuthorityClient } from '../src/client/index.ts';
import { authorityRefusal, renderRoot } from '../src/next/index.ts';
import { refusedRender } from '../src/next/refusals.ts';
import { BUILD } from './support/program.ts';

/**
 * How an application tells the authority's refusal of a root's render from any other fault: by
 * the error's digest, the one part of it a `'use cache'` boundary — a root a link's prefetch
 * carries renders in `'use cache: private'` — carries in production. Next.js keeps an error's own
 * digest (`createReactServerErrorHandler`), and React's client in production makes the error again
 * of that alone, its message replaced and its `cause` gone: as `decoded` below does.
 */

const hoisted = vi.hoisted(() => ({ client: undefined as Partial<AuthorityClient> | undefined }));
vi.mock(import('next/headers'), () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock(import('next/navigation'), () => {
  return {
    notFound: () => {
      throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    },
  };
});
vi.mock(import('../src/next/authority.ts'), () => {
  return {
    authority: () => hoisted.client as AuthorityClient,
    requestSession: () => Promise.resolve('session-1'),
  };
});

/** `error` as React's client makes it again in production of what crossed: its digest alone. */
function decoded(error: unknown): Error {
  const { digest } = error as { readonly digest?: string };
  return Object.assign(
    new Error(
      'An error occurred in the Server Components render. The specific message is omitted.',
    ),
    { digest },
  );
}

/** What a root's render was rejected with; a test fails when it was not. */
async function rejection(rendered: Promise<unknown>): Promise<unknown> {
  try {
    await rendered;
  } catch (error) {
    return error;
  }
  throw new Error('The render was not rejected.');
}

const ELEMENTS = { actions: {}, build: BUILD, clients: {}, modules: {} };
const unanswered = vi.fn(() => Promise.reject(new Error('Nothing is asked of it.')));

describe('the authority’s refusal of a root’s render', () => {
  it('says its status and code in its digest, and its cause', () => {
    const error = refusedRender('down', { code: 'AUTHORITY_UNAVAILABLE', status: 503 });

    expect(error.message).toBe('down');
    expect(error.cause).toStrictEqual({ code: 'AUTHORITY_UNAVAILABLE', status: 503 });
    expect(authorityRefusal(error)).toStrictEqual({ code: 'AUTHORITY_UNAVAILABLE', status: 503 });
    // Each its own error in Next.js's reports, which it keeps by their digests.
    expect((error as { digest?: string }).digest).not.toBe(
      (refusedRender('down', { code: 'AUTHORITY_UNAVAILABLE', status: 503 }) as { digest?: string })
        .digest,
    );
  });

  it('is told across a cache’s boundary, where nothing but the digest comes through', () => {
    const error = refusedRender('stale', { code: 'BUILD_MISMATCH', status: 409 });

    expect(authorityRefusal(decoded(error))).toStrictEqual({ code: 'BUILD_MISMATCH', status: 409 });
  });

  it.each([
    ['an error of no digest', new Error('the application’s own')],
    ['a digest of Next.js’s own', { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }],
    ['a digest Next.js made of the message', { digest: '2234016181' }],
    ['a digest of no code', { digest: 'REACTIVE_STATE_REFUSED;503;;n' }],
    ['a digest of no status', { digest: 'REACTIVE_STATE_REFUSED;up;AUTHORITY_UNAVAILABLE;n' }],
    ['a digest of no nonce', { digest: 'REACTIVE_STATE_REFUSED;503;AUTHORITY_UNAVAILABLE' }],
    ['what is no object', 'REACTIVE_STATE_REFUSED;503;AUTHORITY_UNAVAILABLE;n'],
  ])('is none of %s', (_what, error) => {
    expect(authorityRefusal(error)).toBeUndefined();
  });

  it('is what a root of no route throws for an outage', async () => {
    hoisted.client = {
      render: vi.fn<AuthorityClient['render']>().mockResolvedValue({
        code: 'AUTHORITY_UNAVAILABLE',
        message: 'down',
        ok: false,
        status: 503,
      }),
    };

    const thrown = await rejection(
      renderRoot({
        component: 'components/board',
        elements: ELEMENTS,
        prefetchable: true,
        props: {},
        update: unanswered,
        view: unanswered,
      }),
    );

    expect(authorityRefusal(decoded(thrown))).toStrictEqual({
      code: 'AUTHORITY_UNAVAILABLE',
      status: 503,
    });
  });

  it('is what a route’s root a private cache keeps throws for an outage', async () => {
    hoisted.client = {
      renderShared: vi.fn<AuthorityClient['renderShared']>().mockResolvedValue({
        code: 'AUTHORITY_UNAVAILABLE',
        message: 'down',
        ok: false,
        status: 503,
      }),
    };

    const thrown = await rejection(
      renderRoot({
        component: 'components/board',
        elements: ELEMENTS,
        prefetchable: true,
        props: { id: 'p1' },
        route: '/boards/[id]',
        update: unanswered,
        view: unanswered,
      }),
    );

    expect(authorityRefusal(decoded(thrown))).toStrictEqual({
      code: 'AUTHORITY_UNAVAILABLE',
      status: 503,
    });
  });
});
