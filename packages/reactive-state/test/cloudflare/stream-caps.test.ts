import { describe, expect, it } from 'vitest';

import { MAX_STREAMS_PER_SESSION } from '../../src/authority/stream-admission.ts';
import { type PipedReader, pipedReader } from '../support/piped-reader.ts';
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

  // A reader that left unseen, as a browser leaves a Function that never sees it go: its pipe's
  // next write fails, which cancels the stream on the receiving side of the RPC alone.
  it('admits a session’s stream at its cap once a stream whose reader left unseen fails the heartbeat written to it', async () => {
    const stub = authority();
    const { alice } = await signedIn(stub);
    const { frame } = valueOf(await stub.render(alice, PROJECT));
    const held: ReadableStream<Uint8Array>[] = [];
    for (let open = 1; open < MAX_STREAMS_PER_SESSION; open += 1) {
      held.push(valueOf(await stub.events(alice, frame.subscription)));
    }
    const leaving = pipedReader(valueOf(await stub.events(alice, frame.subscription)));
    await leaving.opened;
    leaving.leave();

    const again = await stub.events(alice, frame.subscription);

    expect(again).toMatchObject({ ok: true });

    await leaving.piped;

    expect(leaving.failed()).toBe(true);
    await expect(stub.stats()).resolves.toMatchObject({ streams: MAX_STREAMS_PER_SESSION });

    for (const stream of [...held, valueOf(again)]) {
      await stream.cancel();
    }
  });

  // A reader whose pipe was aborted while the object had nothing to write, as a pipe aborted by a
  // request's signal is: the cancel that makes crosses the RPC only with the stream's next write
  // (one of the stream itself crosses at once), which the object makes before it refuses the next.
  it('admits a session’s stream at its cap once a stream whose pipe was aborted while nothing was written is written to', async () => {
    const stub = authority();
    const { alice } = await signedIn(stub);
    const { frame } = valueOf(await stub.render(alice, PROJECT));
    const held: ReadableStream<Uint8Array>[] = [];
    for (let open = 1; open < MAX_STREAMS_PER_SESSION; open += 1) {
      held.push(valueOf(await stub.events(alice, frame.subscription)));
    }
    const aborted = pipedReader(valueOf(await stub.events(alice, frame.subscription)));
    await aborted.opened;
    // A call to the object and back: the write of the opening comment is over before the pipe is
    // aborted, which a write still under way would carry across the RPC at once.
    await stub.stats();
    const stopped = aborted.stop();
    const before = await stub.stats();

    const again = await stub.events(alice, frame.subscription);

    expect(before).toMatchObject({ streams: MAX_STREAMS_PER_SESSION });
    expect(again).toMatchObject({ ok: true });

    await stopped;

    await expect(stub.stats()).resolves.toMatchObject({ streams: MAX_STREAMS_PER_SESSION });

    for (const stream of [...held, valueOf(again)]) {
      await stream.cancel();
    }
  });

  // A page of three live roots, opened while its session holds sixteen streams nobody reads: each
  // reader that left finds its write failed a while after the heartbeat comes, as a Function finds
  // its browser gone, and each of the three is admitted as the places come back.
  it('admits each of a page’s streams asked for at once while its session’s streams are written to', async () => {
    const stub = authority();
    const { alice } = await signedIn(stub);
    const { frame } = valueOf(await stub.render(alice, PROJECT));
    const leaving: PipedReader[] = [];
    for (let open = 0; open < MAX_STREAMS_PER_SESSION; open += 1) {
      const reader = pipedReader(valueOf(await stub.events(alice, frame.subscription)), 60);
      await reader.opened;
      leaving.push(reader);
    }
    for (const reader of leaving) {
      reader.leave();
    }

    const answers = await Promise.all(
      Array.from({ length: 3 }, async () => stub.events(alice, frame.subscription)),
    );
    await Promise.all(leaving.map(async (reader) => reader.piped));

    expect(answers.map((answer) => answer.ok)).toStrictEqual([true, true, true]);
    // The places of the readers that left the three were not admitted to come back as well.
    await expect.poll(async () => (await stub.stats()).streams).toBe(3);

    for (const answer of answers) {
      await valueOf(answer).cancel();
    }
  });
});
