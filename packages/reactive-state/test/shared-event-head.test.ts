import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { AuthorityEngine, createAuthorityServer } from '../src/authority/index.ts';
import { nodeSql } from '../src/authority/node-sql.ts';
import { signView } from '../src/authority/view-tokens.ts';
import {
  type AuthorityClient,
  type AuthorityNamespace,
  bindingClient,
  httpClient,
} from '../src/client/index.ts';
import type { Result } from '../src/program.ts';
import type { RouteRegistration } from '../src/routing.ts';
import { application, BUILD } from './support/program.ts';

const ROUTE: RouteRegistration = {
  blocking: true,
  middleware: [],
  page: 'counter/[id]/page.tsx',
  params: ['id'],
  props: { id: 'id' },
  root: 'components/counter',
  route: '/counter/[id]',
  shared: true,
};

/** A real authority whose signed cold view has never been admitted, evaluated or followed. */
async function coldView(): Promise<{
  readonly authority: Awaited<ReturnType<typeof createAuthorityServer>>;
  readonly client: AuthorityClient;
  readonly token: (fields?: { readonly build?: string; readonly route?: string }) => string;
}> {
  const sql = nodeSql(':memory:');
  const engine = new AuthorityEngine({ ...application, routes: [ROUTE], sql });
  const authority = await createAuthorityServer({ engine, internalToken: 'test-internal-token' });
  onTestFinished(authority.close);
  const secret = sql.get("SELECT value FROM meta WHERE key = 'binding_secret'")?.['value'];
  if (typeof secret !== 'string') throw new TypeError('The authority has no signing secret.');
  return {
    authority,
    client: httpClient({ token: 'test-internal-token', url: authority.url }),
    token: ({ build = BUILD, route = ROUTE.route } = {}) =>
      signView(secret, { build, epoch: 0, generation: 0, params: { id: 'main' }, route }),
  };
}

/** A stream result's value, with an unexpected refusal failing the test. */
function streamOf(result: Result<ReadableStream<Uint8Array>>): ReadableStream<Uint8Array> {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

/** A refused token's real signature or deliberately corrupt signature. */
function refusedToken(kind: string, token: Awaited<ReturnType<typeof coldView>>['token']): string {
  if (kind === 'wrong build') return token({ build: 'another-build' });
  if (kind === 'unknown route') return token({ route: '/unknown/[id]' });
  return `${token().split('.', 1)[0] ?? ''}.forged`;
}

/** A closed authority result, with none of a live stream's resources. */
function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

describe('the internal shared-stream HEAD mode', () => {
  it('authenticates a cold token over HTTP without admitting or following its view', async () => {
    const { authority, client, token } = await coldView();
    const following = vi.spyOn(authority.engine, 'followShared');
    const before = await authority.engine.stats();
    const stream = streamOf(await client.sharedEvents(token(), true));
    const reader = stream.getReader();
    const first = await reader.read();
    const streams = authority.streams();
    await reader.cancel();
    const after = await authority.engine.stats();

    expect(first.done).toBe(true);
    expect(following).not.toHaveBeenCalled();
    expect(streams).toBe(0);
    expect(after).toMatchObject({
      appReads: before.appReads,
      generationFailures: before.generationFailures,
      generations: before.generations,
      guardEvaluations: before.guardEvaluations,
      sharedEvaluations: before.sharedEvaluations,
      sharedStreams: 0,
      sharedViews: 0,
    });
  });

  it.each([
    { code: 'FORBIDDEN', kind: 'forged', status: 403 },
    { code: 'BUILD_MISMATCH', kind: 'wrong build', status: 409 },
    { code: 'UNKNOWN_ROUTE', kind: 'unknown route', status: 404 },
  ])('refuses a $kind token over HTTP without following it', async ({ kind, status }) => {
    const { authority, client, token } = await coldView();
    const view = refusedToken(kind, token);
    const result = await client.sharedEvents(view, true);

    expect(result).toMatchObject({ ok: false, status });
    await expect(authority.engine.stats()).resolves.toMatchObject({
      sharedStreams: 0,
      sharedViews: 0,
    });
    expect(authority.streams()).toBe(0);
  });

  it('carries the nonfollowing mode through the existing binding method', async () => {
    const sharedEvents = vi
      .fn<AuthorityClient['sharedEvents']>()
      .mockResolvedValue({ ok: true, value: closedStream() });
    const namespace = {
      getByName: () => ({ sharedEvents }) as unknown as AuthorityClient,
    } satisfies AuthorityNamespace;
    const client = bindingClient(namespace);
    const stream = streamOf(await client.sharedEvents('view-token', true));
    await stream.cancel();

    expect(sharedEvents).toHaveBeenCalledExactlyOnceWith('view-token', true);
  });
});
