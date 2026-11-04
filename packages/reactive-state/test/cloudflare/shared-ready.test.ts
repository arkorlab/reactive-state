import { env } from 'cloudflare:workers';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { signView } from '../../src/authority/view-tokens.ts';
import { GENERATION_HEADER } from '../../src/routing.ts';
import { readEvents } from '../support/event-stream.ts';
import { BUILD } from '../support/program.ts';
import { refusedSharedView, sharedReadyCases } from '../support/shared-ready.ts';
import { authority, type AuthorityStub, inObject, signIn, valueOf, write } from './helpers.ts';

const MAIN = { build: BUILD, props: { id: 'main' }, route: '/counters/[id]' };

/** The actual bound object's site returns the generation artifacts the authority asks for. */
async function published() {
  const stub = authority();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const page = env.AUTHORITY.get(stub.id) as unknown as AuthorityStub;
      const shown = valueOf(
        await page.renderShared(null, {
          ...MAIN,
          generation: request.headers.get(GENERATION_HEADER) ?? '',
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
  const ask = () =>
    stub.gate({ headers: {}, method: 'GET', route: MAIN.route, url: '/counters/main' });

  await expect(ask()).resolves.toMatchObject({ ok: true, value: { kind: 'respond', status: 200 } });

  const shown = valueOf(await stub.renderShared(null, MAIN));
  if (shown.kind !== 'shared') throw new Error('The ready counter is not shared.');
  const token = async (fields: { readonly build?: string; readonly route?: string } = {}) => {
    return inObject(stub, (_instance, state) => {
      const { value } = state.storage.sql
        .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'binding_secret'")
        .one();
      return signView(value, {
        build: fields.build ?? BUILD,
        epoch: shown.view.epoch,
        generation: shown.view.generation,
        params: { id: 'main' },
        route: fields.route ?? MAIN.route,
      });
    });
  };
  return { ask, shown, stub, token };
}

// eslint-disable-next-line vitest/require-hook -- This call registers the shared protocol cases.
sharedReadyCases();

describe('current shared READY over the actual Durable Object binding', () => {
  it('sends the authenticated current moment before any later generation event', async () => {
    const { ask, shown, stub } = await published();
    const stream = valueOf(await stub.sharedEvents(shown.view.token));
    const reader = readEvents(new Response(stream));
    onTestFinished(reader.cancel);
    const first = reader.next();
    valueOf(await write(stub, await signIn(stub, 'alice')));
    await ask();

    await expect(first).resolves.toStrictEqual({
      data: { epoch: shown.view.epoch, generation: shown.view.generation },
      event: 'ready',
    });
  });

  it.each([
    { kind: 'malformed', status: 403 },
    { kind: 'forged', status: 403 },
    { kind: 'wrong build', status: 409 },
    { kind: 'unknown route', status: 404 },
  ])('never sends READY for a $kind token', async ({ kind, status }) => {
    const { stub, token } = await published();
    const view = await refusedSharedView(kind, token);
    const result = await stub.sharedEvents(view);

    expect(result).toMatchObject({ ok: false, status });
    await expect(stub.stats()).resolves.toMatchObject({ sharedStreams: 0 });
  });
});
