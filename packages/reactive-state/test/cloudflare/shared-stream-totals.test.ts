import { env } from 'cloudflare:workers';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { signView } from '../../src/authority/view-tokens.ts';
import { GENERATION_HEADER } from '../../src/routing.ts';
import { BUILD } from '../support/program.ts';
import { authority, type AuthorityStub, COUNTER, inObject, valueOf } from './helpers.ts';

/** The real bound object's site answers generation requests without external network access. */
function stubSite(stub: ReturnType<typeof authority>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const page = env.AUTHORITY.get(stub.id) as unknown as AuthorityStub;
      const shown = valueOf(
        await page.renderShared(null, {
          build: BUILD,
          generation: request.headers.get(GENERATION_HEADER) ?? '',
          props: { id: 'main' },
          route: '/counters/[id]',
        }),
      );
      return Response.json(shown.result.tree, {
        headers: {
          'content-type': request.headers.get('rsc') === '1' ? 'text/x-component' : 'text/html',
        },
      });
    }),
  );
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
}

/** A real signed route token, without opening a shared stream or a page's session stream. */
async function tokenOf(stub: ReturnType<typeof authority>): Promise<string> {
  stubSite(stub);
  await stub.stats();
  return inObject(stub, (_instance, state) => {
    const { value } = state.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'binding_secret'")
      .one();
    return signView(value, {
      build: BUILD,
      epoch: 0,
      generation: 0,
      params: { id: 'main' },
      route: '/counters/[id]',
    });
  });
}

/** The observable total and its shared-view subset, without unrelated cumulative figures. */
function totals(stats: { readonly streams: number; readonly sharedStreams: number }) {
  return { sharedStreams: stats.sharedStreams, streams: stats.streams };
}

describe('cloudflare authority stream totals', () => {
  it('counts a shared stream opened through the actual binding in the total', async () => {
    const stub = authority();
    const token = await tokenOf(stub);
    const reader = valueOf(await stub.sharedEvents(token)).getReader();
    onTestFinished(async () => {
      await reader.cancel();
    });
    await reader.read();

    await expect(stub.stats()).resolves.toMatchObject({ sharedStreams: 1, streams: 1 });
  });

  it('counts each follower of one shared view and releases each cancellation', async () => {
    const stub = authority();
    const token = await tokenOf(stub);
    const observed = await inObject(stub, async (instance) => {
      const first = valueOf(await instance.sharedEvents(token)).getReader();
      const second = valueOf(await instance.sharedEvents(token)).getReader();
      try {
        const opened = totals(await instance.stats());
        await first.cancel();
        const remaining = totals(await instance.stats());
        await second.cancel();
        return [opened, remaining, totals(await instance.stats())];
      } finally {
        await first.cancel();
        await second.cancel();
      }
    });

    expect(observed).toStrictEqual([
      { sharedStreams: 2, streams: 2 },
      { sharedStreams: 1, streams: 1 },
      { sharedStreams: 0, streams: 0 },
    ]);
  });

  it('adds a shared stream to a session stream without counting either twice', async () => {
    const stub = authority();
    const token = await tokenOf(stub);
    const observed = await inObject(stub, async (instance) => {
      const session = valueOf(await instance.login('alice')).sessionId;
      const rendered = valueOf(await instance.render(session, COUNTER));
      const legacy = valueOf(
        await instance.events(session, rendered.frame.subscription),
      ).getReader();
      const shared = valueOf(await instance.sharedEvents(token)).getReader();
      try {
        const opened = totals(await instance.stats());
        await shared.cancel();
        const legacyOnly = totals(await instance.stats());
        await legacy.cancel();
        return [opened, legacyOnly, totals(await instance.stats())];
      } finally {
        await shared.cancel();
        await legacy.cancel();
      }
    });

    expect(observed).toStrictEqual([
      { sharedStreams: 1, streams: 2 },
      { sharedStreams: 0, streams: 1 },
      { sharedStreams: 0, streams: 0 },
    ]);
  });

  it('keeps a session-only stream counted before and after its reader cancels', async () => {
    const stub = authority();
    const observed = await inObject(stub, async (instance) => {
      const session = valueOf(await instance.login('alice')).sessionId;
      const rendered = valueOf(await instance.render(session, COUNTER));
      const reader = valueOf(
        await instance.events(session, rendered.frame.subscription),
      ).getReader();
      try {
        const opened = totals(await instance.stats());
        await reader.cancel();
        return [opened, totals(await instance.stats())];
      } finally {
        await reader.cancel();
      }
    });

    expect(observed).toStrictEqual([
      { sharedStreams: 0, streams: 1 },
      { sharedStreams: 0, streams: 0 },
    ]);
  });

  it('does not count an authenticated HEAD as an open stream', async () => {
    const stub = authority();
    const token = await tokenOf(stub);
    const reader = valueOf(await stub.sharedEvents(token, true)).getReader();

    await expect(reader.read()).resolves.toStrictEqual({ done: true, value: undefined });

    await reader.cancel();

    await expect(stub.stats()).resolves.toMatchObject({ sharedStreams: 0, streams: 0 });
  });

  it('leaves both totals empty when a shared token is rejected', async () => {
    const stub = authority();
    const token = await tokenOf(stub);

    await expect(stub.sharedEvents(`${token}x`)).resolves.toMatchObject({ ok: false, status: 403 });
    await expect(stub.stats()).resolves.toMatchObject({ sharedStreams: 0, streams: 0 });
  });
});
