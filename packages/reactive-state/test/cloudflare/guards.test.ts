import { describe, expect, it } from 'vitest';

import { authority, signIn } from './helpers.ts';

/**
 * A route's guards asked of over the Durable Object's RPC (`guardRoute`), as the delivery route asks
 * before it asks for a page of the request's: answered as a `Result`, for the session the caller
 * names, of the params the object reads of the URL. The Worker's `/counters/[id]` has no middleware,
 * so nothing stops a request of it; its `/guarded/[id]` has a guard, which the gate's answer names
 * where it refused the view. The engine's own suites hold the guards' answers.
 */

const ROUTE = '/counters/[id]';

describe('a route’s guards in the Durable Object', () => {
  it('lets a request of a route no guard stops on, for a session or none', async () => {
    const stub = authority();
    const alice = await signIn(stub, 'alice');

    await expect(
      stub.guardRoute(null, { route: ROUTE, url: '/counters/main' }),
    ).resolves.toStrictEqual({ ok: true, value: { kind: 'pass' } });
    await expect(
      stub.guardRoute(alice, { route: ROUTE, url: '/counters/main?tab=one' }),
    ).resolves.toStrictEqual({ ok: true, value: { kind: 'pass' } });
  });

  it('names over its RPC the guard that refused a shared view at the gate, and none of a view its root refused', async () => {
    const stub = authority();
    const ask = async (route: string, url: string): Promise<unknown> =>
      stub.gate({ headers: {}, method: 'GET', route, url });

    const guarded = await ask('/guarded/[id]', '/guarded/nothing');
    const rooted = await ask(ROUTE, '/counters/nothing');

    expect(guarded).toMatchObject({
      ok: true,
      value: { by: 'guarded', refused: true, status: 403 },
    });
    expect(rooted).toMatchObject({ ok: true, value: { status: 403 } });
    expect((rooted as { readonly value: Record<string, unknown> }).value).not.toHaveProperty('by');
  });

  it('answers a route it does not know, and a URL not of the route, as refusals', async () => {
    const stub = authority();

    await expect(
      stub.guardRoute(null, { route: '/nowhere/[id]', url: '/nowhere/x' }),
    ).resolves.toMatchObject({ code: 'UNKNOWN_ROUTE', ok: false, status: 404 });
    await expect(
      stub.guardRoute(null, { route: ROUTE, url: '/elsewhere/main' }),
    ).resolves.toMatchObject({ code: 'INVALID_ROUTE', ok: false, status: 400 });
  });
});
