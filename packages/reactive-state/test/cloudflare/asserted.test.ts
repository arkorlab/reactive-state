import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, onTestFinished } from 'vitest';

import type { AssertedSession } from '../../src/asserted.ts';
import type { SessionId } from '../../src/client/contract.ts';
import { type AuthorityClient, bindingClient } from '../../src/client/index.ts';
import { type EventReader, readEvents } from '../support/event-stream.ts';
import { SET_TITLE } from '../support/program.ts';
import { type AuthorityStub, bindingOf, EDITOR, PROJECT, valueOf } from './helpers.ts';

/**
 * The authority of an application that signs its users in itself (`sessions: 'asserted'`), as a
 * Durable Object its server reaches over the binding: each call names the session the server
 * asserts, which the object admits while it lasts and its key was not ended, and keeps nothing of.
 */

/** An object of its own, by a name no other test's has; its alarm deleted when the test ends. */
function assertedAuthority(): AuthorityStub {
  const stub = env.ASSERTED.getByName(
    `asserted-${crypto.randomUUID()}`,
  ) as unknown as AuthorityStub;
  onTestFinished(async () => {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  });
  return stub;
}

/** The client an application's server calls `stub` through, as `bindingClient` makes it. */
function clientOf(stub: AuthorityStub): AuthorityClient {
  return bindingClient({ getByName: () => stub });
}

/** Alice, as the application's server asserts her session under `key`, for an hour or `forMs`. */
function alice(key: string, forMs = 3_600_000): AssertedSession {
  return { expires: Date.now() + forMs, id: key, user: 'alice' };
}

/** The stream of `session`'s render of the project page, and the render; cancelled as the test ends. */
async function followed(
  stub: AuthorityStub,
  session: SessionId,
): Promise<{
  readonly events: EventReader;
  readonly rendered: Awaited<ReturnType<typeof render>>;
}> {
  const rendered = await render(stub, session);
  const stream = valueOf(await stub.events(session, rendered.frame.subscription));
  const events = readEvents(new Response(stream));
  onTestFinished(async () => {
    await events.cancel();
  });
  return { events, rendered };
}

async function render(stub: AuthorityStub, session: SessionId) {
  return valueOf(await stub.render(session, PROJECT));
}

describe('the application’s own sessions, over the binding', () => {
  it('renders for the user the server asserts, and writes nothing to admit her', async () => {
    const stub = assertedAuthority();
    const client = clientOf(stub);
    const before = await stub.stats();

    const rendered = valueOf(await client.render(alice('k1'), PROJECT));

    expect(rendered.status).toBe('rendered');
    await expect(stub.stats()).resolves.toMatchObject({ revision: before.revision });
  });

  it('admits a session object that holds more than its three fields', async () => {
    const stub = assertedAuthority();
    // What else the server's object holds — its sign-in's own bearer — is none of the authority's.
    const held = { ...alice('k1'), bearer: 'the sign-in’s own token' };

    await expect(clientOf(stub).render(held, PROJECT)).resolves.toMatchObject({
      value: { status: 'rendered' },
    });
  });

  it('refuses the demo sign-in', async () => {
    await expect(clientOf(assertedAuthority()).login('alice')).resolves.toMatchObject({
      code: 'NO_DEMO_SESSIONS',
      ok: false,
      status: 404,
    });
  });

  it('ends every session of a key, and keeps it ended once the object is evicted', async () => {
    const stub = assertedAuthority();
    const client = clientOf(stub);

    const ended = await client.endSession('k1');
    await evictDurableObject(stub);

    expect(ended).toStrictEqual({ ok: true, value: null });
    await expect(client.render(alice('k1'), PROJECT)).resolves.toMatchObject({
      value: { status: 'unauthenticated', tree: null },
    });
    await expect(client.render(alice('k2'), PROJECT)).resolves.toMatchObject({
      value: { status: 'rendered' },
    });
  });

  it('ends an open stream of a key with `revoked` once the key is ended', async () => {
    const stub = assertedAuthority();
    const { events } = await followed(stub, alice('k1'));

    valueOf(await stub.endSession('k1'));

    await expect(events.next()).resolves.toMatchObject({ event: 'revoked' });
    await expect(events.next()).rejects.toThrow('The event stream ended.');
  });

  it('renews a stream at its session’s expiry, rendering nothing more', async () => {
    const stub = assertedAuthority();
    // Long enough to open the stream within it.
    const { events } = await followed(stub, alice('k1', 500));

    await expect(events.next()).resolves.toStrictEqual({ data: {}, event: 'renew' });
    await expect(events.next()).rejects.toThrow('The event stream ended.');
  });

  it('renews a stream at its session’s expiry while commits keep coming', async () => {
    const stub = assertedAuthority();
    const session = alice('k1', 500);
    const { events, rendered } = await followed(stub, session);
    const binding = bindingOf(rendered, EDITOR, 'title');
    const writing = new AbortController();
    const writes = (async () => {
      let each = 0;
      while (!writing.signal.aborted) {
        each += 1;
        // Each a title of its own: a change of what the root shows, which its stream renders for.
        await stub.update(session, {
          binding,
          operationId: crypto.randomUUID(),
          updaterId: SET_TITLE,
          value: `title ${String(each)}`,
        });
      }
    })();

    const renewed = await events.until((event) => event.event !== 'frame');
    writing.abort();
    await writes;

    expect(renewed).toStrictEqual({ data: {}, event: 'renew' });
  });

  it('refuses a key no session could be asserted under', async () => {
    await expect(clientOf(assertedAuthority()).endSession('k.1')).resolves.toMatchObject({
      code: 'INVALID_SESSION_KEY',
      ok: false,
      status: 400,
    });
  });
});
