import { describe, expect, it } from 'vitest';

import { MAX_STREAMS_PER_SESSION } from '../../src/authority/stream-admission.ts';
import { authority, PROJECT, signedIn, valueOf } from './helpers.ts';

/** The caps on a session's event streams, through the Durable Object. */
describe('the caps on event streams through the object', () => {
  it('refuses a session’s stream past the cap with 429, frees a place as one ends, and leaves another session alone', async () => {
    const stub = authority();
    const { alice, bob } = await signedIn(stub);
    const { frame } = valueOf(await stub.render(alice, PROJECT));
    const { frame: bobs } = valueOf(await stub.render(bob, PROJECT));
    const held: ReadableStream<Uint8Array>[] = [];
    for (let open = 0; open < MAX_STREAMS_PER_SESSION; open += 1) {
      held.push(valueOf(await stub.events(alice, frame.subscription)));
    }

    const refused = await stub.events(alice, frame.subscription);
    const other = valueOf(await stub.events(bob, bobs.subscription));
    await held[0]?.cancel();
    const again = await stub.events(alice, frame.subscription);

    expect(refused).toMatchObject({ code: 'TOO_MANY_STREAMS', ok: false, status: 429 });
    expect(again.ok).toBe(true);
    expect(other).toBeInstanceOf(ReadableStream);

    for (const stream of [...held.slice(1), other, valueOf(again)]) {
      await stream.cancel();
    }
  });
});
