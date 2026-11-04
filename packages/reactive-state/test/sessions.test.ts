import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AssertedSession } from '../src/asserted.ts';
import { type CommitEvent, Engine, startAuthority } from '../src/authority/index.ts';
import { PublicViews } from '../src/authority/public.ts';
import { ASSERTED } from '../src/authority/sessions.ts';
import { httpClient } from '../src/client/index.ts';
import type { RenderResult, Result, RootRequest } from '../src/program.ts';
import { readEvents } from './support/event-stream.ts';
import { application, BUILD } from './support/program.ts';

/** The fixture's project page, with its first item selected: Alice owns its project. */
const PAGE: RootRequest = {
  build: BUILD,
  component: 'components/project',
  props: { filter: 'all', projectId: 'p1', selectedId: 't1' },
};

const START = 1_000_000;
const HOUR = 3_600_000;

interface Opened {
  readonly engine: Engine;
  readonly commits: CommitEvent[];
  /** Moves the authority's clock on by `ms`. */
  readonly advance: (ms: number) => void;
}

/** An authority that admits the application's own sessions, on a clock the test moves. */
function open(sessions: 'asserted' | 'demo' = 'asserted'): Opened {
  let now = START;
  const engine = new Engine({ ...application, clock: () => now, sessions });
  onTestFinished(async () => {
    await engine.close();
  });
  const commits: CommitEvent[] = [];
  engine.onCommit((event) => {
    commits.push(event);
  });
  return {
    advance: (ms) => {
      now += ms;
    },
    commits,
    engine,
  };
}

/** Alice, as the application's server asserts her session under `key`. */
function alice(key = 'k-alice', expires = START + HOUR): AssertedSession {
  return { expires, id: key, user: 'alice' };
}

async function render(engine: Engine, session: unknown): Promise<RenderResult> {
  return engine.render(session, PAGE);
}

function valueOf<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`refused: ${String(result.status)} ${result.code} ${result.message}`);
  }
  return result.value;
}

describe('sessions the application asserts', () => {
  it('renders for the user it asserts', async () => {
    const { engine } = open();

    const rendered = await render(engine, alice());

    expect(rendered.status).toBe('rendered');
    expect(rendered.frame.subscription).not.toBe('');
  });

  it('writes nothing to admit one', async () => {
    const { commits, engine } = open();
    const before = engine.revision();

    await render(engine, alice());
    await render(engine, alice());

    expect(engine.revision()).toBe(before);
    expect(commits).toStrictEqual([]);
  });

  it('reads a demo session or a malformed one as none', async () => {
    const { engine } = open();

    await expect(render(engine, 'a-demo-session-id')).resolves.toMatchObject({
      status: 'unauthenticated',
    });
    await expect(
      render(engine, { id: 'k.1', user: 'alice', expires: START + HOUR }),
    ).resolves.toMatchObject({
      status: 'unauthenticated',
    });
    await expect(render(engine, { id: 'k1', user: 'alice' })).resolves.toMatchObject({
      status: 'unauthenticated',
    });
  });

  it('reads one that expired as none', async () => {
    const { advance, engine } = open();
    advance(HOUR);

    await expect(render(engine, alice('k1', START + HOUR))).resolves.toMatchObject({
      status: 'unauthenticated',
    });
  });

  it('reads one asserted to last past thirty days as none', async () => {
    const { engine } = open();

    await expect(
      render(engine, alice('k1', START + ASSERTED.lifetimeMs + 1)),
    ).resolves.toMatchObject({ status: 'unauthenticated' });
    await expect(render(engine, alice('k1', START + ASSERTED.lifetimeMs))).resolves.toMatchObject({
      status: 'rendered',
    });
  });

  it('keeps a key ended past every session admitted under it before', async () => {
    const { advance, engine } = open();
    // The furthest a session admitted before the end may last.
    const session = alice('k1', START + ASSERTED.lifetimeMs);
    await render(engine, session);
    await engine.endSession('k1');

    advance(ASSERTED.endedForMs + 1);
    // Another key's end commits, and lets go of the first key, whose sessions have all expired.
    await engine.endSession('k2');

    await expect(render(engine, session)).resolves.toMatchObject({ status: 'unauthenticated' });
  });

  it('refuses the demo sign-in', async () => {
    const { engine } = open();

    await expect(engine.login('alice')).rejects.toMatchObject({
      code: 'NO_DEMO_SESSIONS',
      status: 404,
    });
  });

  it('ends every session of a key, for good, and says so in the commit', async () => {
    const { commits, engine } = open();
    await render(engine, alice('k1'));

    await engine.endSession('k1');
    await engine.endSession('k1');

    await expect(render(engine, alice('k1'))).resolves.toMatchObject({
      status: 'unauthenticated',
    });
    await expect(render(engine, alice('k2'))).resolves.toMatchObject({ status: 'rendered' });
    expect(commits.map((event) => event.changed)).toStrictEqual([
      ['session-key:k1'],
      ['session-key:k1'],
    ]);
  });

  it('refuses a key no session could be asserted under', async () => {
    const { engine } = open();

    await expect(engine.endSession('a.b')).rejects.toMatchObject({
      code: 'INVALID_SESSION_KEY',
      status: 400,
    });
  });

  it('keeps one key’s users apart', async () => {
    const { engine } = open();
    const rendered = await render(engine, alice('shared'));

    const asBob = engine.view(
      { expires: START + HOUR, id: 'shared', user: 'bob' },
      { subscription: rendered.frame.subscription, view: {} },
    );

    await expect(asBob).rejects.toMatchObject({ status: 403 });
  });

  it('wakes the streams of a key that ended', async () => {
    const { engine } = open();
    const rendered = await render(engine, alice('k1'));
    const watched = await engine.watch(alice('k1'), rendered.frame.subscription);
    const other = await engine.watch(
      alice('k2'),
      (await render(engine, alice('k2'))).frame.subscription,
    );
    const ended: CommitEvent[] = [];
    engine.onCommit((event) => {
      ended.push(event);
    });

    await engine.endSession('k1');

    expect(ended.map((event) => watched.dependsOn(event))).toStrictEqual([true]);
    expect(ended.map((event) => other.dependsOn(event))).toStrictEqual([false]);
  });

  it('keeps no version of a key it ended, which no rendering of a record reads', async () => {
    const committed = vi.spyOn(PublicViews.prototype, 'committed');
    onTestFinished(() => {
      committed.mockRestore();
    });
    const { engine } = open();

    await engine.endSession('k1');
    const views = committed.mock.contexts.at(-1) as PublicViews;

    // A version kept of `session-key:k1` would hold it against every rendering, and never go.
    expect(views.current({ 'session-key:k1': 0 })).toBe(true);
  });

  it('renews a stream long before a long session ends', async () => {
    const { engine } = open();
    await render(engine, alice('k1', START + 7 * 24 * HOUR));

    await expect(engine.expiresIn(alice('k1', START + 7 * 24 * HOUR))).resolves.toBe(
      ASSERTED.reassertMs,
    );
  });

  it('is none to an authority of the demo’s sessions', async () => {
    const { engine } = open('demo');

    await expect(render(engine, alice())).resolves.toMatchObject({ status: 'unauthenticated' });
  });

  it('ends no key where the authority admits the demo’s sessions', async () => {
    const { engine } = open('demo');

    await expect(engine.endSession('k1')).rejects.toMatchObject({
      code: 'NO_ASSERTED_SESSIONS',
      status: 404,
    });
  });

  it('lets go of day-old receipts of operations that committed nothing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'reactive-state-sessions-'));
    onTestFinished(async () => {
      await rm(dir, { force: true, recursive: true });
    });
    const filename = path.join(dir, 'authority.sqlite');
    let now = START;
    const engine = new Engine({ ...application, clock: () => now, filename, sessions: 'asserted' });
    onTestFinished(async () => {
      await engine.close();
    });
    // A to-do of no title: refused, its receipt kept for a resend, and nothing committed.
    const refused = async (operationId: string): Promise<void> => {
      const call = { build: BUILD, module: 'actions/todos', name: 'createTodo', operationId };
      const args = [{ json: 'p1' }, { form: [['title', '']] as [string, string][] }];

      await expect(
        engine.operate(alice('k1', now + HOUR), { ...call, args }),
      ).rejects.toMatchObject({
        status: 422,
      });
    };
    await refused('first');
    now += 2 * ASSERTED.receiptsForMs;

    await refused('second');

    const kept = new DatabaseSync(filename, { readOnly: true });
    onTestFinished(() => {
      kept.close();
    });

    const ids = kept.prepare('SELECT id FROM operations ORDER BY id').all();

    expect(ids.map((row) => row['id'])).toStrictEqual(['second']);
  });
});

describe('an asserted session over HTTP', () => {
  it('crosses in its header, and a sign-out ends it', async () => {
    const authority = await startAuthority({ ...application, sessions: 'asserted' });
    onTestFinished(async () => {
      await authority.close();
    });
    const client = httpClient({ token: authority.token, url: authority.url });
    const asserted = { expires: Date.now() + HOUR, id: 'k-http', user: 'alice' };

    const rendered = valueOf(await client.render(asserted, PAGE));
    valueOf(await client.endSession('k-http'));
    const after = valueOf(await client.render(asserted, PAGE));

    expect(rendered.status).toBe('rendered');
    expect(after.status).toBe('unauthenticated');
  });

  it('renews its stream at its expiry, and renders nothing more', async () => {
    const authority = await startAuthority({ ...application, sessions: 'asserted' });
    onTestFinished(async () => {
      await authority.close();
    });
    const client = httpClient({ token: authority.token, url: authority.url });
    // Long enough to open the stream within it.
    const asserted = { expires: Date.now() + 500, id: 'k-renew', user: 'alice' };
    const rendered = valueOf(await client.render(asserted, PAGE));

    const stream = valueOf(await client.events(asserted, rendered.frame.subscription));
    const events = readEvents(new Response(stream));
    onTestFinished(async () => {
      await events.cancel();
    });

    await expect(events.next()).resolves.toStrictEqual({ data: {}, event: 'renew' });
    await expect(events.next()).rejects.toThrow('The event stream ended.');
  });

  it('refuses the demo sign-in', async () => {
    const authority = await startAuthority({ ...application, sessions: 'asserted' });
    onTestFinished(async () => {
      await authority.close();
    });
    const client = httpClient({ token: authority.token, url: authority.url });

    await expect(client.login('alice')).resolves.toMatchObject({
      code: 'NO_DEMO_SESSIONS',
      ok: false,
      status: 404,
    });
  });
});
