import { describe, expect, it, onTestFinished } from 'vitest';

import type { AssertedSession } from '../src/asserted.ts';
import { Engine, startAuthority } from '../src/authority/index.ts';
import { httpClient } from '../src/client/index.ts';
import { EventStreams } from '../src/cloudflare/stream.ts';
import type { RenderResult, Result, RootRequest } from '../src/program.ts';
import { type EventReader, readEvents, type ServerEvent } from './support/event-stream.ts';
import { clientOf } from './support/frames.ts';
import { application, BUILD, SET_TITLE } from './support/program.ts';

/**
 * An authority judges whether a session has expired by its own clock, which `startAuthority` and the
 * engine take as an option and which is `Date.now` unless given. A stream that says `renew` for an
 * asserted session whose render was refused after its expiry, and `revoked` for one refused because
 * its key ended, must tell the two by that same clock: the session's `expires` is a time of it. Read
 * against `Date.now` instead, a clock that runs ahead had a refusal for the expiry said `revoked`,
 * which ends the page's subscription for good, and one that runs behind had a refusal for the end of
 * the key said `renew`. Both streams run here over a real authority, on a clock the test moves,
 * apart from `Date.now` or level with it as the stream opens: the Node authority's over HTTP, as
 * `startAuthority` serves it, and the Durable Object's over the engine it opens.
 */

const PAGE: RootRequest = {
  build: BUILD,
  component: 'components/project',
  props: { filter: 'all', projectId: 'p1', selectedId: 't1' },
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EDITOR = 'components/todo-editor';

/** What the authority is reached through, by either of its hosts. */
interface Host {
  readonly render: (session: AssertedSession) => Promise<RenderResult>;
  /** The events of the stream of `session`'s render, which is cancelled as the test ends. */
  readonly follow: (session: AssertedSession, rendered: RenderResult) => Promise<EventReader>;
  /** A write to the item the page selects, which every session of the user's pages shows. */
  readonly retitle: (
    session: AssertedSession,
    rendered: RenderResult,
    title: string,
  ) => Promise<void>;
  readonly end: (key: string) => Promise<void>;
}

function valueOf<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`refused: ${String(result.status)} ${result.code} ${result.message}`);
  }
  return result.value;
}

/** What a retitle sends: the binding of the editor's `title` in a render of the page. */
function titleUpdate(rendered: RenderResult, title: string) {
  const state = clientOf(rendered.tree, EDITOR).part.states['title'];
  if (state === undefined || !('binding' in state)) {
    throw new Error(`${EDITOR} has no binding for its title.`);
  }
  return {
    binding: state.binding,
    operationId: crypto.randomUUID(),
    updaterId: SET_TITLE,
    value: title,
  };
}

/** The Node authority, started as `startAuthority` does, and reached over HTTP. */
async function overHttp(clock: () => number): Promise<Host> {
  const authority = await startAuthority({ ...application, clock, sessions: 'asserted' });
  onTestFinished(async () => {
    await authority.close();
  });
  const client = httpClient({ token: authority.token, url: authority.url });
  return {
    end: async (key) => {
      valueOf(await client.endSession(key));
    },
    follow: async (session, rendered) => {
      const stream = valueOf(await client.events(session, rendered.frame.subscription));
      const events = readEvents(new Response(stream));
      onTestFinished(async () => {
        await events.cancel();
      });
      return events;
    },
    render: async (session) => valueOf(await client.render(session, PAGE)),
    retitle: async (session, rendered, title) => {
      valueOf(await client.update(session, titleUpdate(rendered, title)));
    },
  };
}

/** The engine a Durable Object opens, and its streams (`EventStreams`). */
function overEngine(clock: () => number): Promise<Host> {
  const engine = new Engine({ ...application, clock, sessions: 'asserted' });
  onTestFinished(async () => {
    await engine.close();
  });
  const streams = new EventStreams(engine);
  return Promise.resolve({
    end: async (key) => {
      await engine.endSession(key);
    },
    follow: async (session, rendered) => {
      const stream = await streams.open(session, rendered.frame.subscription);
      const events = readEvents(new Response(stream));
      onTestFinished(async () => {
        await events.cancel();
      });
      return events;
    },
    render: async (session) => engine.render(session, PAGE),
    retitle: async (session, rendered, title) => {
      await engine.update(session, titleUpdate(rendered, title));
    },
  });
}

/** Where the authority's clock starts, against `Date.now`. */
const CLOCKS: readonly (readonly [string, () => number])[] = [
  ['a clock a year ahead of Date.now', () => Date.now() + 365 * DAY],
  ['a clock far behind Date.now', () => 1_000_000],
  ['a clock level with Date.now as the stream opens', () => Date.now()],
];

const EXPIRED = { data: {}, event: 'renew' };
const ENDED = { data: { code: 'UNAUTHENTICATED', error: 'Sign in first.' }, event: 'revoked' };

/** What a row works on: the authority, its clock, and the user's second session and its render. */
interface Scene {
  readonly host: Host;
  readonly clock: { now: number };
  readonly second: AssertedSession;
  readonly rendered: RenderResult;
}

interface Row {
  readonly id: string;
  /** What makes the engine refuse the stream's next render. */
  readonly refusedFor: (scene: Scene) => Promise<void>;
  readonly said: ServerEvent;
}

const ROWS: readonly Row[] = [
  {
    id: 'renews a stream whose session the clock has carried past its expiry',
    refusedFor: async ({ clock, host, rendered, second }) => {
      clock.now += 2 * HOUR;
      await host.retitle(second, rendered, 'moved on');
    },
    said: EXPIRED,
  },
  {
    id: 'revokes a stream whose key ended before its session’s expiry',
    refusedFor: async ({ host }) => {
      await host.end('k1');
    },
    said: ENDED,
  },
];

/** The user's session under `key`, as the application's server asserts it. */
function asserted(key: string, expires: number): AssertedSession {
  return { expires, id: key, user: 'alice' };
}

describe.each([
  ['the Node authority’s stream, over HTTP', overHttp],
  ['the Durable Object’s stream, over its engine', overEngine],
])('%s', (_name, open) => {
  describe.each(CLOCKS)('on %s', (_clock, start) => {
    it.each(ROWS)('$id', async ({ refusedFor, said }) => {
      const clock = { now: start() };
      const host = await open(() => clock.now);
      const first = asserted('k1', clock.now + HOUR);
      // A second session of the user's, which stays: its write is the commit that wakes the stream.
      const second = asserted('k2', clock.now + 10 * HOUR);
      const events = await host.follow(first, await host.render(first));
      const rendered = await host.render(second);

      await refusedFor({ clock, host, rendered, second });

      await expect(events.until((event) => event.event !== 'frame')).resolves.toStrictEqual(said);
    });
  });
});
