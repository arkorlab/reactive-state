import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  type AuthorityServer,
  createAuthorityServer,
  Engine,
  type EngineOptions,
  startAuthority,
} from '../src/authority/index.ts';
import {
  type ComponentProgram,
  type FieldReceipt,
  INTERNAL_HEADER,
  type Json,
  type OperationArgument,
  PROTOCOL_VERSION,
  type RenderResult,
  SESSION_COOKIE,
  type View,
} from '../src/program.ts';
import { database, MAX_TEXT_LENGTH, requireUser, table, text } from '../src/server/index.ts';
import { db } from './support/app/db.ts';
import { type EventReader, readEvents, type ServerEvent } from './support/event-stream.ts';
import { clientOf, deferred } from './support/frames.ts';
import { application, BUILD, programs, SET_TITLE } from './support/program.ts';

const TOKEN = 'test-token';
/** How long a session lasts from its sign-in, as the authority signs one in. */
const SESSION_MS = 86_400_000;
/** The fixture's project page, with its first item selected. */
const PAGE = { filter: 'all', projectId: 'p1', selectedId: 't1' } as const;

/**
 * An authority on a free loopback port, in test mode, closed when the test finishes: the test
 * application unless told otherwise.
 */
async function start(options: Partial<EngineOptions> = {}): Promise<AuthorityServer> {
  const engine = new Engine({ ...application, ...options });
  const app = await createAuthorityServer({
    engine,
    internalToken: TOKEN,
    port: 0,
    testMode: true,
  });
  onTestFinished(async () => {
    await app.close();
  });
  return app;
}

/** What the application's server sends the authority with: the token, and the session's cookie. */
function headersOf(
  cookie: string | undefined,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { [INTERNAL_HEADER]: TOKEN, ...(cookie !== undefined && { cookie }), ...extra };
}

/** Signs `user` in — holding the cookie `held` already, if given — and answers the new cookie. */
async function login(app: AuthorityServer, user: string, held?: string): Promise<string> {
  const response = await fetch(`${app.url}/api/session`, {
    body: JSON.stringify({ user }),
    headers: headersOf(held, { 'Content-Type': 'application/json' }),
    method: 'POST',
  });
  const [cookie = ''] = response.headers.getSetCookie();
  const [pair = ''] = cookie.split(';', 1);
  if (!pair.startsWith(`${SESSION_COOKIE}=`)) {
    throw new Error(`${user} was not signed in: HTTP ${String(response.status)}`);
  }
  return pair;
}

interface Post {
  /** The session's cookie. */
  readonly cookie?: string;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A JSON request of the application's server. */
async function post(app: AuthorityServer, pathname: string, request: Post): Promise<Response> {
  return fetch(`${app.url}${pathname}`, {
    body: JSON.stringify(request.body),
    headers: headersOf(request.cookie, { 'Content-Type': 'application/json', ...request.headers }),
    method: 'POST',
  });
}

async function logout(app: AuthorityServer, cookie: string): Promise<Response> {
  return fetch(`${app.url}/api/session`, { headers: headersOf(cookie), method: 'DELETE' });
}

/** A page's render of `component`: the project page unless told otherwise. */
async function render(
  app: AuthorityServer,
  cookie: string | undefined,
  props: Readonly<Record<string, Json>> = PAGE,
  component = 'components/project',
): Promise<RenderResult> {
  const response = await post(app, '/api/render', {
    body: { root: { build: BUILD, component, props } },
    ...(cookie !== undefined && { cookie }),
  });
  return (await response.json()) as RenderResult;
}

/** The binding the `title` of `component` is written with, in a render of it. */
function titleBinding(rendered: RenderResult, component = 'components/todo-editor'): string {
  const state = clientOf(rendered.tree, component).part.states['title'];
  if (state === undefined || !('binding' in state)) {
    throw new Error(`${component} has no binding for its title.`);
  }
  return state.binding;
}

/** Retitles the item the page selects, as its text input does. */
async function retitle(app: AuthorityServer, cookie: string, value: string): Promise<Response> {
  const binding = titleBinding(await render(app, cookie));
  return post(app, '/api/update', {
    body: { binding, operationId: crypto.randomUUID(), updaterId: SET_TITLE, value },
    cookie,
  });
}

/** `actions/todos`' `createTodo` for `p1`, as the application's server sends it. */
async function createTodo(
  app: AuthorityServer,
  cookie: string,
  options: { readonly operationId: string; readonly headers?: Readonly<Record<string, string>> },
): Promise<Response> {
  const args: readonly OperationArgument[] = [{ json: 'p1' }, { form: [['title', 'あとで']] }];
  return post(app, '/api/operate', {
    body: {
      args,
      build: BUILD,
      module: 'actions/todos',
      name: 'createTodo',
      operationId: options.operationId,
    },
    cookie,
    ...(options.headers !== undefined && { headers: options.headers }),
  });
}

/** The session's stream of the root a subscription follows, read until the test ends it. */
async function subscribe(
  app: AuthorityServer,
  cookie: string,
  subscription: string,
): Promise<EventReader> {
  const query = new URLSearchParams({ subscription });
  const response = await fetch(`${app.url}/api/events?${query.toString()}`, {
    headers: headersOf(cookie),
  });
  const events = readEvents(response);
  onTestFinished(async () => {
    await events.cancel();
  });
  return events;
}

/** The first `frame` the stream announces. */
async function nextFrame(events: EventReader): Promise<unknown> {
  return (await events.until((candidate) => candidate.event === 'frame')).data;
}

/** The stream's `revoked`, once it says it. */
async function revokedIn(events: EventReader): Promise<ServerEvent> {
  return events.until((candidate) => candidate.event === 'revoked');
}

async function streamsOpen(app: AuthorityServer): Promise<number> {
  const response = await fetch(`${app.url}/internal/stats`, { headers: headersOf(undefined) });
  const { streams } = (await response.json()) as { readonly streams: number };
  return streams;
}

/** What the authority writes to its own log, kept from the test's output and read back. */
function stderr(): ReturnType<typeof vi.spyOn> {
  const written = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  onTestFinished(() => {
    written.mockRestore();
  });
  return written;
}

/** The states of a component without any: none it writes, and no update. */
const STATELESS: Pick<ComponentProgram, 'updaters' | 'writable'> = { updaters: {}, writable: [] };

/** A program of the test build. */
function program(
  component: string,
  evaluate: ComponentProgram['evaluate'],
  states?: Pick<ComponentProgram, 'updaters' | 'writable'>,
): ComponentProgram {
  return {
    buildId: BUILD,
    component,
    evaluate,
    protocolVersion: PROTOCOL_VERSION,
    ...(states ?? STATELESS),
  };
}

describe('the authority over HTTP', () => {
  it('answers no `/api/` request without the internal token: a browser never reaches it', async () => {
    const app = await start();

    const browser = await fetch(`${app.url}/api/render`, {
      body: JSON.stringify({
        root: { build: BUILD, component: 'components/project', props: PAGE },
      }),
      headers: { 'Content-Type': 'application/json', Origin: app.url },
      method: 'POST',
    });
    const signedOut = await render(app, undefined);

    expect(browser.status).toBe(403);
    await expect(browser.json()).resolves.toMatchObject({ code: 'INTERNAL_ONLY' });
    expect(signedOut).toMatchObject({ status: 'unauthenticated', tree: null });
  });

  it('renders the root a request names, and refuses one it does not run, of another build, or none', async () => {
    const app = await start();
    const alice = await login(app, 'alice');
    const asked = async (root: unknown): Promise<Response> =>
      post(app, '/api/render', { body: { root }, cookie: alice });

    const rendered = await asked({ build: BUILD, component: 'components/project', props: PAGE });
    const unknown = await asked({ build: BUILD, component: 'components/none', props: {} });
    const stale = await asked({ build: 'b_old', component: 'components/project', props: PAGE });
    const unnamed = await asked(undefined);

    expect(rendered.status).toBe(200);
    await expect(rendered.json()).resolves.toMatchObject({
      frame: { revision: 0 },
      status: 'rendered',
    });
    expect([unknown.status, stale.status, unnamed.status]).toStrictEqual([404, 409, 400]);
    await expect(stale.json()).resolves.toMatchObject({ code: 'BUILD_MISMATCH' });
  });

  it('renders the root a subscription names for the view a page sends, and refuses a view no part reads', async () => {
    const app = await start();
    const alice = await login(app, 'alice');
    const props = { filter: 'all', projectId: 'p1', selectedId: 't1' };
    const first = (await (
      await post(app, '/api/render', {
        body: { root: { build: BUILD, component: 'components/workspace-project', props } },
        cookie: alice,
      })
    ).json()) as { readonly frame: { readonly subscription: string; readonly view: View } };
    const [instance = ''] = Object.keys(first.frame.view);
    const asked = async (view: unknown): Promise<Response> => {
      return post(app, '/api/view', {
        body: { subscription: first.frame.subscription, view },
        cookie: alice,
      });
    };

    const viewed = await asked({ [instance]: { d0: { filter: 'done' } } });
    const invalid = await asked({ [instance]: { d0: { filter: 1 } } });

    expect(viewed.status).toBe(200);
    await expect(viewed.json()).resolves.toMatchObject({
      frame: { view: { [instance]: { d0: { filter: 'done' } } } },
      status: 'rendered',
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ code: 'INVALID_VIEW' });
  });

  it('says which build it serves, its components and its operations', async () => {
    const app = await start();

    const health = await fetch(`${app.url}/health`);
    const config = await fetch(`${app.url}/api/config`, { headers: headersOf(undefined) });
    const missing = await fetch(`${app.url}/api/frame`, { headers: headersOf(undefined) });

    await expect(health.json()).resolves.toStrictEqual({
      buildId: BUILD,
      localOnly: true,
      ok: true,
    });
    await expect(config.json()).resolves.toMatchObject({
      buildId: BUILD,
      components: expect.arrayContaining(['components/project', 'components/todo-editor']),
      operations: {
        'actions/todos': ['completeProject', 'createTodo', 'deleteTodo', 'moveTodo'],
      },
      protocol: PROTOCOL_VERSION,
    });
    expect(missing.status).toBe(404);
  });

  it('announces at once a render that shows something other than the page, and each commit that changes it', async () => {
    const app = await start();
    const alice = await login(app, 'alice');
    const bob = await login(app, 'bob');
    const shown = await render(app, bob);

    await retitle(app, alice, '一覧を直す');
    const events = await subscribe(app, bob, shown.frame.subscription);
    const behind = await nextFrame(events);
    await retitle(app, alice, '一覧を直した');
    const next = await nextFrame(events);
    const read = await render(app, bob);

    expect(behind).toStrictEqual({ frame: { revision: 1 } });
    expect(next).toStrictEqual({ frame: { revision: 2 } });
    expect(read.frame.fields['todos:t1:title']).toBe('一覧を直した');
  });

  it('announces nothing on opening for a page that shows what the root renders now', async () => {
    const app = await start();
    const alice = await login(app, 'alice');
    const bob = await login(app, 'bob');
    const events = await subscribe(app, bob, (await render(app, bob)).frame.subscription);

    await retitle(app, alice, '一覧を直す');
    const first = await events.next();

    // The first event is the commit's, not one of the stream's own opening.
    expect(first).toStrictEqual({ data: { frame: { revision: 1 } }, event: 'frame' });
  });

  it('opens a stream with a comment at once, which a client reads as no event', async () => {
    const app = await start();
    const bob = await login(app, 'bob');
    const query = new URLSearchParams({
      subscription: (await render(app, bob)).frame.subscription,
    });
    const response = await fetch(`${app.url}/api/events?${query.toString()}`, {
      headers: headersOf(bob),
    });
    const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
    onTestFinished(async () => {
      await reader?.cancel();
    });

    // Its first bytes, long before the first heartbeat: what stands between the authority and the
    // browser may hold the headers back until a stream's body starts.
    expect((await reader?.read())?.value).toBe(': open\n\n');
  });

  it('follows a root the session may not see, and announces it once access comes back', async () => {
    const invite = {
      invite: async (projectId: Json, userId: Json): Promise<void> => {
        await db.transaction(async () => {
          await requireUser();
          await db.memberships.insert({
            canEdit: false,
            projectId: projectId as string,
            userId: userId as string,
          });
        });
      },
    };
    const app = await start({ operations: { ...application.operations, 'test/invite': invite } });
    const alice = await login(app, 'alice');
    const bob = await login(app, 'bob');
    const refused = await render(app, alice, { filter: 'all', projectId: 'p3' });
    const events = await subscribe(app, alice, refused.frame.subscription);

    await post(app, '/api/operate', {
      body: {
        args: [{ json: 'p3' }, { json: 'alice' }],
        build: BUILD,
        module: 'test/invite',
        name: 'invite',
        operationId: 'op',
      },
      cookie: bob,
    });
    const announced = await nextFrame(events);

    expect(refused.status).toBe('forbidden');
    expect(announced).toStrictEqual({ frame: { revision: 1 } });
    expect((await render(app, alice, { filter: 'all', projectId: 'p3' })).status).toBe('rendered');
  });

  it('revokes an idle stream once its session expires, though nothing commits', async () => {
    let elapsed = 0;
    const app = await start({ clock: () => Date.now() + elapsed });
    const bob = await login(app, 'bob');
    const { subscription } = (await render(app, bob)).frame;
    // By the authority's clock, the session has a fifth of a second left.
    elapsed = SESSION_MS - 200;
    const events = await subscribe(app, bob, subscription);

    const revoked = await revokedIn(events);

    expect(revoked.data).toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(events.next()).rejects.toThrow('The event stream ended.');
  });

  it('ends the session a browser held when it signs in again, and revokes the streams it held', async () => {
    const app = await start();
    const alice = await login(app, 'alice');
    const events = await subscribe(app, alice, (await render(app, alice)).frame.subscription);

    // Another tab of the same browser signs in as Bob, sending the cookie the tabs share.
    const bob = await login(app, 'bob', alice);
    const revoked = await revokedIn(events);

    expect(bob).not.toBe(alice);
    expect(revoked.data).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect((await render(app, alice)).status).toBe('unauthenticated');
  });

  it('renders the root once more for a burst of commits that came while it rendered', async () => {
    const app = await start();
    const alice = await login(app, 'alice');
    const bob = await login(app, 'bob');
    const events = await subscribe(app, bob, (await render(app, bob)).frame.subscription);
    await sleep(20);
    const binding = titleBinding(await render(app, alice));
    const gate = deferred<undefined>();
    const watch = app.engine.watch.bind(app.engine);
    const reads = vi.spyOn(app.engine, 'watch').mockImplementation(async (...args) => {
      await gate.promise;
      return watch(...args);
    });
    onTestFinished(() => {
      reads.mockRestore();
    });

    for (const [index, operationId] of ['b-1', 'b-2', 'b-3', 'b-4', 'b-5'].entries()) {
      await post(app, '/api/update', {
        body: { binding, operationId, updaterId: SET_TITLE, value: `t${String(index)}` },
        cookie: alice,
      });
    }
    gate.resolve(undefined);
    const last = await events.until((event) => {
      return (
        event.event === 'frame' &&
        (event.data as { frame: { revision: number } }).frame.revision === 5
      );
    });

    expect(last.data).toStrictEqual({ frame: { revision: 5 } });
    await expect.poll(() => reads.mock.calls.length).toBe(2);

    await sleep(50);

    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('renders the root again for a commit it depends on, and for no other', async () => {
    const app = await start();
    const alice = await login(app, 'alice');
    const bob = await login(app, 'bob');
    const events = await subscribe(app, bob, (await render(app, bob)).frame.subscription);
    await sleep(20);
    const other = await render(app, alice, { filter: 'all', projectId: 'p2', selectedId: 't3' });
    const reads = vi.spyOn(app.engine, 'watch');
    onTestFinished(() => {
      reads.mockRestore();
    });

    await post(app, '/api/update', {
      body: {
        binding: titleBinding(other),
        operationId: 'other-op',
        updaterId: SET_TITLE,
        value: '別',
      },
      cookie: alice,
    });
    await sleep(50);

    expect(reads).not.toHaveBeenCalled();

    await retitle(app, alice, '一覧を直す');

    await expect(nextFrame(events)).resolves.toStrictEqual({ frame: { revision: 2 } });
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('serves a record’s public fields as HTML again without rendering it, and with nothing of a session', async () => {
    const app = await start();
    const alice = await login(app, 'alice');

    const first = await fetch(`${app.url}/public/counters/main`);
    const second = await fetch(`${app.url}/public/counters/main`);
    const html = await second.text();
    const json = await fetch(`${app.url}/api/public?table=counters&id=main`, {
      headers: headersOf(undefined),
    });
    const none = await fetch(`${app.url}/public/todos/t1`);

    expect(first.headers.get('x-reactive-cache')).toBe('MISS');
    expect(second.headers.get('x-reactive-cache')).toBe('HIT');
    expect(html).toContain('<dt>count</dt><dd><output>0</output></dd>');
    expect(html).not.toMatch(/reactive_session|ownerId|alice|Shared counter/u);
    expect(html).not.toContain(alice.slice(`${SESSION_COOKIE}=`.length));
    await expect(json.json()).resolves.toMatchObject({ table: 'counters', values: { count: 0 } });
    expect(none.status).toBe(404);
  });

  it('clears the session cookie when signing out, of a session that had already ended too', async () => {
    const app = await start();
    const alice = await login(app, 'alice');
    const cleared = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

    const first = await logout(app, alice);
    const again = await logout(app, alice);

    expect(first.status).toBe(200);
    expect(first.headers.getSetCookie()).toStrictEqual([cleared]);
    expect(again.status).toBe(401);
    expect(again.headers.getSetCookie()).toStrictEqual([cleared]);
  });

  it('refuses a body that is JSON but no object, and one past its limit, rather than fail on them', async () => {
    const app = await start();
    const alice = await login(app, 'alice');

    const update = await post(app, '/api/update', { body: [], cookie: alice });
    const large = await post(app, '/api/session', { body: { user: 'x'.repeat(4_000_000) } });

    expect(update.status).toBe(400);
    await expect(update.json()).resolves.toMatchObject({ code: 'INVALID_JSON' });
    expect(large.status).toBe(413);
    await expect(large.json()).resolves.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('takes an operation sent the largest form, though JSON escapes each of its characters, and refuses more as either host does', async () => {
    const noted = {
      note: (): undefined => undefined,
    };
    const app = await start({ operations: { ...application.operations, 'test/noted': noted } });
    const alice = await login(app, 'alice');
    // 16 KiB of UTF-8, the most a form holds, which JSON writes six bytes to each character of.
    const largest = { form: [['note', '\u{1}'.repeat(16_384 - 'note'.length)]] };
    const call = (args: readonly unknown[], operationId: string): Post => {
      return {
        body: { args, build: BUILD, module: 'test/noted', name: 'note', operationId },
        cookie: alice,
      };
    };

    const one = await post(app, '/api/operate', call([largest], 'op-one'));
    const three = await post(app, '/api/operate', call([largest, largest, largest], 'op-three'));

    expect(one.status).toBe(200);
    expect(three.status).toBe(413);
    await expect(three.json()).resolves.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('takes a write of the longest text a field holds, though JSON escapes each of its characters', async () => {
    const drafts = database(
      { drafts: table({ title: text() }) },
      { seed: { drafts: { d1: { title: '' } } } },
    );
    const editor = program(
      'test/draft',
      async (_, $) => {
        await requireUser();
        return $.client({ props: {}, slots: {}, states: { title: drafts.drafts.ref('d1').title } });
      },
      { updaters: { [SET_TITLE]: { keys: ['title'], kind: 'set' } }, writable: ['title'] },
    );
    const app = await start({ database: drafts, operations: {}, programs: [editor] });
    const alice = await login(app, 'alice');
    const rendered = await render(app, alice, {}, 'test/draft');
    const title = '\u{1}'.repeat(MAX_TEXT_LENGTH);
    const body = {
      binding: titleBinding(rendered, 'test/draft'),
      operationId: 'o'.repeat(128),
      updaterId: SET_TITLE,
      value: title,
    };

    const response = await post(app, '/api/update', { body, cookie: alice });

    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(6 * MAX_TEXT_LENGTH);
    expect(response.status).toBe(200);
    expect((await render(app, alice, {}, 'test/draft')).frame.fields['drafts:d1:title']).toBe(
      title,
    );
  });

  it('answers a fault of the application’s code as 500, logged, and serves on', async () => {
    const written = stderr();
    const failing = program('test/failing', () => {
      throw new Error('The permission service did not answer.');
    });
    const odd = program('test/odd', () => {
      // What an application's code may throw: anything, a value with no string of its own too.
      throw Object.create(null);
    });
    const app = await start({ programs: [...programs, failing, odd] });
    const alice = await login(app, 'alice');
    const asked = async (component: string): Promise<Response> => {
      return post(app, '/api/render', {
        body: { root: { build: BUILD, component, props: {} } },
        cookie: alice,
      });
    };

    const fault = await asked('test/failing');
    const strange = await asked('test/odd');

    expect(fault.status).toBe(500);
    await expect(fault.json()).resolves.toStrictEqual({
      code: 'INTERNAL_ERROR',
      error: 'Internal error',
    });
    expect(written).toHaveBeenCalledWith(
      expect.stringContaining('The permission service did not answer.'),
    );
    expect(strange.status).toBe(500);
    expect(written).toHaveBeenCalledWith(
      expect.stringContaining('a value that does not say what it is'),
    );
    expect((await fetch(`${app.url}/health`)).status).toBe(200);
  });

  it('refuses to start with an empty internal token, which every internal request would fail', async () => {
    await expect(startAuthority({ ...application, token: '' })).rejects.toThrow(
      'The internal token is empty',
    );
  });

  it('answers the change log to the internal token alone, saying what a page without a session may show', async () => {
    const app = await start();
    const alice = await login(app, 'alice');
    await retitle(app, alice, '一覧を直す');

    const anonymous = await fetch(`${app.url}/internal/changes`);
    const wrong = await fetch(`${app.url}/internal/changes`, {
      headers: { [INTERNAL_HEADER]: 'nope' },
    });
    const internal = await fetch(`${app.url}/internal/changes?since=0`, {
      headers: headersOf(undefined),
    });

    expect([anonymous.status, wrong.status]).toStrictEqual([403, 403]);
    await expect(internal.json()).resolves.toMatchObject([
      { changed: ['todos:t1'], published: [], revision: 1 },
    ]);
  });

  it('lets a write whose answer was lost be sent again safely, a field’s and an operation’s', async () => {
    const app = await start();
    const alice = await login(app, 'alice');
    const binding = titleBinding(await render(app, alice));
    const body = { binding, operationId: 'lost-ack', updaterId: SET_TITLE, value: '直す' };

    await expect(
      post(app, '/api/update', { body, cookie: alice, headers: { 'x-test-drop': '1' } }),
    ).rejects.toThrow('fetch failed');
    await expect(
      createTodo(app, alice, { headers: { 'x-test-drop': '1' }, operationId: 'lost-op' }),
    ).rejects.toThrow('fetch failed');

    const retry = (await (
      await post(app, '/api/update', { body, cookie: alice })
    ).json()) as FieldReceipt;
    const again = await createTodo(app, alice, { operationId: 'lost-op' });

    expect(retry).toMatchObject({ committedRevision: 1, deduplicated: true });
    await expect(again.json()).resolves.toMatchObject({ committedRevision: 2, deduplicated: true });
    expect((await app.engine.stats()).commits).toBe(2);
  });

  it('counts the open event streams, and stops counting one its client cancelled', async () => {
    const app = await start();
    const bob = await login(app, 'bob');
    const events = await subscribe(app, bob, (await render(app, bob)).frame.subscription);

    await expect.poll(async () => streamsOpen(app)).toBe(1);

    await events.cancel();

    await expect.poll(async () => streamsOpen(app), { timeout: 5000 }).toBe(0);
  });

  it('ends a stream without revoking it when a render fails for a reason other than the session', async () => {
    let failing = false;
    const fragile = program('test/fragile', async (_, $) => {
      const user = await requireUser();
      const project = await db.projects.get('p1');
      if (failing && user.id === 'bob') {
        throw new TypeError('The database is busy.');
      }
      return $.h('p', null, project?.title ?? '');
    });
    const renamer = {
      rename: async (): Promise<void> => {
        await db.transaction(async () => {
          await db.projects.update('p1', { title: '改名' });
        });
      },
    };
    const app = await start({
      operations: { 'test/rename': renamer },
      programs: [...programs, fragile],
    });
    const alice = await login(app, 'alice');
    const bob = await login(app, 'bob');
    const events = await subscribe(
      app,
      bob,
      (await render(app, bob, {}, 'test/fragile')).frame.subscription,
    );
    await sleep(20);

    failing = true;
    await post(app, '/api/operate', {
      body: { args: [], build: BUILD, module: 'test/rename', name: 'rename', operationId: 'op' },
      cookie: alice,
    });

    await expect(revokedIn(events)).rejects.toThrow('The event stream ended.');
  });

  it('opens no stream for a client that left while the root was rendered for it', async () => {
    const app = await start();
    const bob = await login(app, 'bob');
    const { subscription } = (await render(app, bob)).frame;
    const entered = deferred<undefined>();
    const gate = deferred<undefined>();
    const watch = app.engine.watch.bind(app.engine);
    const reads = vi.spyOn(app.engine, 'watch').mockImplementation(async (...args) => {
      entered.resolve(undefined);
      await gate.promise;
      return watch(...args);
    });
    onTestFinished(() => {
      reads.mockRestore();
    });
    const leaving = new AbortController();
    const asked = fetch(
      `${app.url}/api/events?${new URLSearchParams({ subscription }).toString()}`,
      {
        headers: headersOf(bob),
        signal: leaving.signal,
      },
    );
    await entered.promise;

    leaving.abort();

    await expect(asked).rejects.toThrow('This operation was aborted');

    // Let the server see the connection close before the render it waits on returns.
    await sleep(50);
    gate.resolve(undefined);
    await sleep(50);

    await expect(streamsOpen(app)).resolves.toBe(0);
    expect(reads).toHaveBeenCalledTimes(1);
  });
});
