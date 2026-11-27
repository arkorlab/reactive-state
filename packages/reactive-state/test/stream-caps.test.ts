import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Engine } from '../src/authority/index.ts';
import { MAX_STREAMS, MAX_STREAMS_PER_SESSION } from '../src/authority/stream-admission.ts';
import { EventStreams } from '../src/cloudflare/stream.ts';
import type { RootRequest } from '../src/program.ts';
import { application, BUILD } from './support/program.ts';

/** The caps on the event streams one authority holds, where a stream is admitted. */

const PAGE: RootRequest = {
  build: BUILD,
  component: 'components/project',
  props: { filter: 'all', projectId: 'p1', selectedId: 't1' },
};
const REFUSED = { code: 'TOO_MANY_STREAMS', status: 429 };

function open(): Engine {
  const engine = new Engine(application);
  onTestFinished(async () => {
    await engine.close();
  });
  return engine;
}

/** The `n`th admission of `session`, which a refusal throws. */
function admitAll(engine: Engine, session: string, count: number): (() => void)[] {
  return Array.from({ length: count }, () => engine.admitStream(session));
}

describe('the caps on event streams', () => {
  it('admits a session its share of streams and refuses the next with 429', async () => {
    const engine = open();
    const { sessionId } = await engine.login('alice');

    admitAll(engine, sessionId, MAX_STREAMS_PER_SESSION);

    expect(() => engine.admitStream(sessionId)).toThrow(expect.objectContaining(REFUSED));
  });

  it('admits another once one is released, and a release counts once', async () => {
    const engine = open();
    const { sessionId } = await engine.login('alice');
    const [first, ...rest] = admitAll(engine, sessionId, MAX_STREAMS_PER_SESSION);

    first?.();
    first?.();
    rest[0]?.();
    engine.admitStream(sessionId);
    engine.admitStream(sessionId);

    expect(() => engine.admitStream(sessionId)).toThrow(expect.objectContaining(REFUSED));
  });

  it('leaves a second session unaffected', async () => {
    const engine = open();
    const alice = await engine.login('alice');
    const bob = await engine.login('bob');
    admitAll(engine, alice.sessionId, MAX_STREAMS_PER_SESSION);

    expect(() => engine.admitStream(bob.sessionId)).not.toThrow();
  });

  it('refuses a session that does not stand as the sign-in it needs, holding no place', () => {
    const engine = open();

    expect(() => engine.admitStream('nobody')).toThrow(expect.objectContaining({ status: 401 }));
  });

  it('refuses across sessions once the authority holds its total', async () => {
    const engine = open();
    const sessions: string[] = [];
    for (let held = 0; held < MAX_STREAMS; held += MAX_STREAMS_PER_SESSION) {
      const { sessionId } = await engine.login(held % 2 === 0 ? 'alice' : 'bob');
      sessions.push(sessionId);
      admitAll(engine, sessionId, MAX_STREAMS_PER_SESSION);
    }
    const another = await engine.login('alice');

    expect(() => engine.admitStream(another.sessionId)).toThrow(expect.objectContaining(REFUSED));
    expect(() => engine.admitStream(sessions[0] ?? '')).toThrow(expect.objectContaining(REFUSED));
  });
});

describe('the caps on the Durable Object host’s streams', () => {
  it('refuses the stream past the cap before it renders or listens, and frees a place as one ends', async () => {
    const engine = open();
    const { sessionId } = await engine.login('alice');
    const { frame } = await engine.render(sessionId, PAGE);
    const streams = new EventStreams(engine);
    const bodies: ReadableStream<Uint8Array>[] = [];
    for (let held = 0; held < MAX_STREAMS_PER_SESSION; held += 1) {
      bodies.push(await streams.open(sessionId, frame.subscription));
    }
    const listened = vi.spyOn(engine, 'onCommit');
    const watched = vi.spyOn(engine, 'watch');

    await expect(streams.open(sessionId, frame.subscription)).rejects.toMatchObject(REFUSED);
    expect(listened).not.toHaveBeenCalled();
    expect(watched).not.toHaveBeenCalled();
    expect(streams.size).toBe(MAX_STREAMS_PER_SESSION);

    await bodies[0]?.cancel();
    const next = await streams.open(sessionId, frame.subscription);
    await next.cancel();

    expect(listened).toHaveBeenCalledTimes(1);

    for (const body of bodies.slice(1)) {
      await body.cancel();
    }

    expect(streams.size).toBe(0);
  });

  it('frees the place of a stream whose first render is refused', async () => {
    const engine = open();
    const { sessionId } = await engine.login('alice');
    const streams = new EventStreams(engine);

    for (let tried = 0; tried <= MAX_STREAMS_PER_SESSION; tried += 1) {
      await expect(streams.open(sessionId, 'not-a-subscription')).rejects.toMatchObject({
        status: 403,
      });
    }
    const { frame } = await engine.render(sessionId, PAGE);

    await (await streams.open(sessionId, frame.subscription)).cancel();
  });
});
