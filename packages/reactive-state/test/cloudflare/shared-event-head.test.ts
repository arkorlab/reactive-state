import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { signView } from '../../src/authority/view-tokens.ts';
import { bindingClient } from '../../src/client/index.ts';
import { BUILD } from '../support/program.ts';
import { authority, inObject, valueOf } from './helpers.ts';

/** A signed cold token, made without creating a view or following one in the object. */
async function coldToken(
  stub: ReturnType<typeof authority>,
  fields: { readonly build?: string; readonly route?: string } = {},
): Promise<string> {
  await stub.stats();
  return inObject(stub, (_instance, state) => {
    const { value } = state.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'binding_secret'")
      .one();
    return signView(value, {
      build: fields.build ?? BUILD,
      epoch: 0,
      generation: 0,
      params: { id: 'main' },
      route: fields.route ?? '/counters/[id]',
    });
  });
}

/** Each rejected case retains the authority's real signing boundary. */
async function refusedToken(stub: ReturnType<typeof authority>, kind: string): Promise<string> {
  if (kind === 'wrong build') return coldToken(stub, { build: 'another-build' });
  if (kind === 'unknown route') return coldToken(stub, { route: '/unknown/[id]' });
  const token = await coldToken(stub);
  return `${token.split('.', 1)[0] ?? ''}.forged`;
}

describe('the shared-stream HEAD mode over the Durable Object binding', () => {
  it('authenticates a cold token without a view, following, evaluation or heartbeat', async () => {
    const stub = authority();
    const token = await coldToken(stub);
    const client = bindingClient({ getByName: () => stub });
    const intervals = vi.spyOn(globalThis, 'setInterval');
    onTestFinished(() => {
      intervals.mockRestore();
    });
    const stream = valueOf(await client.sharedEvents(token, true));
    const reader = stream.getReader();
    const first = await reader.read();
    await reader.cancel();

    expect(first.done).toBe(true);
    expect(intervals).not.toHaveBeenCalled();
    await expect(stub.stats()).resolves.toMatchObject({
      appReads: 0,
      generationFailures: 0,
      generations: 0,
      guardEvaluations: 0,
      sharedEvaluations: 0,
      sharedStreams: 0,
      sharedViews: 0,
    });
  });

  it.each([
    { kind: 'forged', status: 403 },
    { kind: 'wrong build', status: 409 },
    { kind: 'unknown route', status: 404 },
  ])('refuses a $kind token before retaining any following', async ({ kind, status }) => {
    const stub = authority();
    const token = await refusedToken(stub, kind);

    await expect(stub.sharedEvents(token, true)).resolves.toMatchObject({ ok: false, status });
    await expect(stub.stats()).resolves.toMatchObject({ sharedStreams: 0, sharedViews: 0 });
  });
});
