import { createServer, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { type Authority, startAuthority } from '../src/authority/index.ts';
import { type AuthorityClient, httpClient } from '../src/client/index.ts';
import type { RenderResult, Result, RootRequest, ViewRequest } from '../src/program.ts';
import type { GateRequest, GuardRequest, SharedRenderRequest } from '../src/routing.ts';
import { type EventReader, readEvents } from './support/event-stream.ts';
import { clientOf } from './support/frames.ts';
import {
  application,
  BUILD,
  INCREMENT,
  SET_COMPLETED,
  SET_COUNT,
  SET_TITLE,
} from './support/program.ts';

/** The fixture's project page, with its first item selected, and the counter `main`. */
const PAGE: RootRequest = {
  build: BUILD,
  component: 'components/project',
  props: { filter: 'all', projectId: 'p1', selectedId: 't1' },
};
const COUNTER: RootRequest = {
  build: BUILD,
  component: 'components/counter',
  props: { id: 'main' },
};

/** An authority in memory on a free loopback port, closed when the test finishes. */
async function start(): Promise<Authority> {
  const authority = await startAuthority(application);
  onTestFinished(async () => {
    await authority.close();
  });
  return authority;
}

/** The value of an answer the test expects to be one, and the test's failure otherwise. */
function valueOf<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`refused: ${String(result.status)} ${result.code} ${result.message}`);
  }
  return result.value;
}

/** The revision a `frame` event says a newer render is at; it says nothing more. */
function revisionOf(data: unknown): number {
  return (data as { readonly frame: { readonly revision: number } }).frame.revision;
}

async function signIn(client: AuthorityClient, user: string): Promise<string> {
  return valueOf(await client.login(user)).sessionId;
}

/** The binding `component` writes `key` with, in a render of it. */
function bindingOf(rendered: RenderResult, component: string, key: string): string {
  const state = clientOf(rendered.tree, component).part.states[key];
  if (state === undefined || !('binding' in state)) {
    throw new Error(`${component} has no binding for ${key}.`);
  }
  return state.binding;
}

/** What a request was made to, however `fetch` was handed it. */
function hrefOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/** The session's stream of the root a subscription follows, read until the test ends it. */
async function subscribe(
  client: AuthorityClient,
  session: string,
  subscription: string,
): Promise<EventReader> {
  const stream = valueOf(await client.events(session, subscription));
  const events = readEvents(new Response(stream));
  onTestFinished(async () => {
    await events.cancel();
  });
  return events;
}

/** A server that takes every request and never answers one. */
async function silent(): Promise<Server> {
  const server = createServer(() => {
    // Held: neither answered nor refused.
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  });
  return server;
}

function urlOf(server: Server): string {
  const address = server.address();
  return `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;
}

/** The address of a port nothing listens on any more. */
async function closedPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = urlOf(server);
  await new Promise((resolve) => {
    server.close(resolve);
  });
  return url;
}

const UNAVAILABLE = { code: 'AUTHORITY_UNAVAILABLE', ok: false, status: 503 };
/** How long a development authority takes to start again, in the test: a few of the client's polls. */
const RESTART_GAP_MS = 300;

describe('httpClient', () => {
  it('signs in, renders, writes and runs an operation as the application’s server, and signs out', async () => {
    const authority = await start();
    const client = httpClient({ token: authority.token, url: authority.url });
    const alice = await signIn(client, 'alice');

    const rendered = valueOf(await client.render(alice, PAGE));
    const receipt = valueOf(
      await client.update(alice, {
        binding: bindingOf(rendered, 'components/todo-editor', 'title'),
        operationId: 'client-http-op',
        updaterId: SET_TITLE,
        value: '一覧を直す',
      }),
    );
    const operated = valueOf(
      await client.operate(alice, {
        args: [{ json: 'p1' }],
        build: BUILD,
        module: 'actions/todos',
        name: 'completeProject',
        operationId: 'client-http-operation',
      }),
    );
    const signedOut = await client.logout(alice);
    const after = valueOf(await client.render(alice, PAGE));

    expect(rendered).toMatchObject({
      frame: { fields: { 'todos:t1:title': '一覧を作る' } },
      status: 'rendered',
    });
    expect(receipt).toStrictEqual({
      committedRevision: 1,
      deduplicated: false,
      operationId: 'client-http-op',
    });
    expect(operated).toStrictEqual({
      committedRevision: 2,
      deduplicated: false,
      operationId: 'client-http-operation',
      result: null,
    });
    expect(signedOut).toStrictEqual({ ok: true, value: null });
    expect(after.status).toBe('unauthenticated');
  });

  it('answers the authority’s refusals as failures, with its status, code and message', async () => {
    const authority = await start();
    const client = httpClient({ token: authority.token, url: authority.url });
    const bob = await signIn(client, 'bob');

    const stranger = await client.login('mallory');
    const unknown = await client.render(bob, { ...PAGE, component: 'components/none' });
    const stale = await client.render(bob, { ...PAGE, build: 'b_old' });
    const forged = await client.update(bob, {
      binding: 'forged',
      operationId: 'o',
      updaterId: SET_TITLE,
      value: 'x',
    });
    const anonymous = await client.operate(null, {
      args: [],
      build: BUILD,
      module: 'actions/todos',
      name: 'completeProject',
      operationId: 'o',
    });
    const notPublic = await client.publicView('todos', 't1');
    const nobody = await client.logout(null);

    expect(stranger).toStrictEqual({
      code: 'INVALID_USER',
      message: "The demo's users are alice, bob, carol.",
      ok: false,
      status: 400,
    });
    expect(unknown).toMatchObject({ code: 'UNKNOWN_COMPONENT', ok: false, status: 404 });
    expect(stale).toMatchObject({ code: 'BUILD_MISMATCH', ok: false, status: 409 });
    expect(forged).toMatchObject({ code: 'FORBIDDEN', ok: false, status: 403 });
    expect(anonymous).toMatchObject({ code: 'UNAUTHENTICATED', ok: false, status: 401 });
    expect(notPublic).toMatchObject({ code: 'NOT_FOUND', ok: false, status: 404 });
    expect(nobody).toMatchObject({ code: 'UNAUTHENTICATED', ok: false, status: 401 });
  });

  it('reads a record as anyone may see it, and nothing of how the authority came by it', async () => {
    const authority = await start();
    const client = httpClient({ token: authority.token, url: authority.url });

    const view = valueOf(await client.publicView('counters', 'main'));

    expect(view).toStrictEqual({
      id: 'main',
      resultVersion: expect.any(String) as string,
      revision: 0,
      table: 'counters',
      values: { count: 0 },
    });
  });

  it('carries a `set`’s value as it is — `false`, `0` and empty text too — and an `apply`’s captures in its place', async () => {
    const authority = await start();
    const client = httpClient({ token: authority.token, url: authority.url });
    const alice = await signIn(client, 'alice');
    const page = valueOf(await client.render(alice, PAGE));
    const counter = valueOf(await client.render(alice, COUNTER));
    const sent = vi.spyOn(globalThis, 'fetch');
    onTestFinished(() => {
      sent.mockRestore();
    });
    const update = async (
      binding: string,
      updaterId: string,
      change: { value?: boolean | number | string; captures?: { by: number } },
    ): Promise<void> => {
      valueOf(
        await client.update(alice, {
          binding,
          operationId: crypto.randomUUID(),
          updaterId,
          ...change,
        }),
      );
    };

    await update(bindingOf(page, 'components/todo-editor', 'completed'), SET_COMPLETED, {
      value: false,
    });
    await update(bindingOf(page, 'components/todo-editor', 'title'), SET_TITLE, { value: '' });
    await update(bindingOf(counter, 'components/counter', 'count'), SET_COUNT, { value: 0 });
    await update(bindingOf(counter, 'components/counter', 'count'), INCREMENT, {
      captures: { by: 2 },
    });
    const bodies = sent.mock.calls
      .filter(([input]) => hrefOf(input).endsWith('/api/update'))
      .map(([, init]) => {
        return JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Readonly<
          Record<string, unknown>
        >;
      });
    const after = valueOf(await client.render(alice, PAGE));

    expect(
      bodies.map((body) => (Object.hasOwn(body, 'value') ? body['value'] : 'none')),
    ).toStrictEqual([false, '', 0, 'none']);
    expect(bodies.at(-1)?.['captures']).toStrictEqual({ by: 2 });
    expect(after.frame.fields['todos:t1:title']).toBe('');
    expect(valueOf(await client.render(alice, COUNTER)).frame.fields['counters:main:count']).toBe(
      2,
    );
  });

  it('sends the root, the write and the operation by their own fields alone', async () => {
    const authority = await start();
    const client = httpClient({ token: authority.token, url: authority.url });
    const alice = await signIn(client, 'alice');
    const sent = vi.spyOn(globalThis, 'fetch');
    onTestFinished(() => {
      sent.mockRestore();
    });

    const { frame } = valueOf(await client.render(alice, { ...PAGE, extra: 'x' } as RootRequest));
    const body = sent.mock.calls.at(-1)?.[1]?.body;
    const viewed = await client.view(alice, {
      extra: 'x',
      subscription: frame.subscription,
      view: {},
    } as ViewRequest);
    const viewBody = sent.mock.calls.at(-1)?.[1]?.body;

    expect(JSON.parse(typeof body === 'string' ? body : '{}')).toStrictEqual({
      root: { build: BUILD, component: 'components/project', props: PAGE.props },
    });
    expect(viewed.ok).toBe(true);
    expect(JSON.parse(typeof viewBody === 'string' ? viewBody : '{}')).toStrictEqual({
      subscription: frame.subscription,
      view: {},
    });
  });

  it('opts into a guard admission over HTTP while preserving the legacy pass shape', async () => {
    const authority = await startAuthority({
      ...application,
      routes: [
        {
          blocking: true,
          middleware: [],
          page: 'counters/[id]/page.tsx',
          params: ['id'],
          props: { id: 'id' },
          root: 'components/counter',
          route: '/counters/[id]',
          shared: false,
        },
      ],
    });
    onTestFinished(async () => {
      await authority.close();
    });
    const client = httpClient({ token: authority.token, url: authority.url });
    const sent = vi.spyOn(globalThis, 'fetch');
    onTestFinished(() => {
      sent.mockRestore();
    });
    const request: GuardRequest = { route: '/counters/[id]', url: '/counters/main' };
    const legacy = await client.guardRoute(null, {
      ...request,
      extra: 'discarded',
    } as GuardRequest);
    const admitted = await client.guardRoute(null, {
      ...request,
      admit: true,
      extra: 'discarded',
    } as GuardRequest);
    const bodies = sent.mock.calls.map(([, init]): unknown =>
      JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
    );

    expect(bodies).toStrictEqual([request, { ...request, admit: true }]);
    expect(legacy).toStrictEqual({ ok: true, value: { kind: 'pass' } });
    expect(admitted).toStrictEqual({
      ok: true,
      value: { admission: expect.any(String), kind: 'pass' },
    });
  });

  it.each([undefined, 'signed-initial-decision'])(
    'sends a shared render with only its own fields and optional admission: %s',
    async (admission) => {
      const authority = await start();
      const client = httpClient({ token: authority.token, url: authority.url });
      const sent = vi.spyOn(globalThis, 'fetch');
      onTestFinished(() => {
        sent.mockRestore();
      });
      const request: SharedRenderRequest = {
        ...(admission !== undefined && { admission }),
        build: BUILD,
        props: { projectId: 'p1' },
        route: '/boards/[projectId]',
        site: { basePath: '/docs', trailingSlash: true },
      };

      // The test application registers no such route: what was sent is what this asks of.
      await client.renderShared(null, { ...request, extra: 'x' } as SharedRenderRequest);
      const body = sent.mock.calls.at(-1)?.[1]?.body;

      expect(JSON.parse(typeof body === 'string' ? body : '{}')).toStrictEqual(request);
    },
  );

  it('sends a gate’s question with where its site serves its routes, by its own fields alone', async () => {
    const authority = await start();
    const client = httpClient({ token: authority.token, url: authority.url });
    const sent = vi.spyOn(globalThis, 'fetch');
    onTestFinished(() => {
      sent.mockRestore();
    });
    const request: GateRequest = {
      headers: { rsc: '1' },
      method: 'GET',
      route: '/boards/[projectId]',
      site: { basePath: '/docs', trailingSlash: true },
      url: '/docs/boards/p1/',
    };

    await client.gate({ ...request, extra: 'x' } as GateRequest);
    const body = sent.mock.calls.at(-1)?.[1]?.body;

    expect(JSON.parse(typeof body === 'string' ? body : '{}')).toStrictEqual(request);
  });

  it('names in each gate’s question the deployment asking, unless the question names its own', async () => {
    const authority = await start();
    const client = httpClient({ deployment: 'dpl_a', token: authority.token, url: authority.url });
    const sent = vi.spyOn(globalThis, 'fetch');
    onTestFinished(() => {
      sent.mockRestore();
    });
    const request: GateRequest = {
      headers: {},
      method: 'GET',
      route: '/boards/[projectId]',
      url: '/boards/p1',
    };

    await client.gate(request);
    await client.gate({ ...request, deployment: 'dpl_b' });
    const bodies = sent.mock.calls.map(([, init]): unknown =>
      JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
    );

    expect(bodies).toStrictEqual([
      { ...request, deployment: 'dpl_a' },
      { ...request, deployment: 'dpl_b' },
    ]);
  });

  it('streams a root’s renders, and the authority lets go of a stream the application cancels', async () => {
    const authority = await start();
    const client = httpClient({ token: authority.token, url: authority.url });
    const alice = await signIn(client, 'alice');
    const bob = await signIn(client, 'bob');
    const { subscription } = valueOf(await client.render(bob, PAGE)).frame;
    const stream = valueOf(await client.events(bob, subscription));
    const events = readEvents(new Response(stream));
    const page = valueOf(await client.render(alice, PAGE));

    const { committedRevision } = valueOf(
      await client.update(alice, {
        binding: bindingOf(page, 'components/todo-editor', 'title'),
        operationId: 'o',
        updaterId: SET_TITLE,
        value: 'パン',
      }),
    );
    const next = await events.until(
      (event) => event.event === 'frame' && revisionOf(event.data) >= committedRevision,
    );
    await events.cancel();

    // An event says a newer render shows something else; the page renders it itself.
    expect(next.data).toStrictEqual({ frame: { revision: committedRevision } });
    expect(valueOf(await client.render(bob, PAGE)).frame.fields['todos:t1:title']).toBe('パン');

    await vi.waitFor(() => {
      expect(authority.streams()).toBe(0);
    });
  });

  it('ends the stream with `revoked` once the session ends', async () => {
    const authority = await start();
    const client = httpClient({ token: authority.token, url: authority.url });
    const bob = await signIn(client, 'bob');
    const events = await subscribe(
      client,
      bob,
      valueOf(await client.render(bob, PAGE)).frame.subscription,
    );

    valueOf(await client.logout(bob));
    const revoked = await events.until((event) => event.event !== 'frame');

    expect(revoked).toStrictEqual({
      data: { code: 'UNAUTHENTICATED', error: 'Sign in first.' },
      event: 'revoked',
    });
    await expect(events.next()).rejects.toThrow('The event stream ended.');
  });

  it('refuses a stream before it starts, and sends no session the authority could not have minted', async () => {
    const authority = await start();
    const client = httpClient({ token: authority.token, url: authority.url });
    const bob = await signIn(client, 'bob');

    const anonymous = await client.events(null, 'subscription');
    const forged = await client.events(bob, 'forged');
    const malformed = await client.render('a;b=c\r\nx', PAGE);

    expect(anonymous).toMatchObject({ code: 'UNAUTHENTICATED', ok: false, status: 401 });
    expect(forged).toMatchObject({ code: 'FORBIDDEN', ok: false, status: 403 });
    expect(valueOf(malformed).status).toBe('unauthenticated');
  });

  it('speaks with the internal token: without it, the authority answers nothing', async () => {
    const authority = await start();
    const client = httpClient({ token: `${authority.token}x`, url: authority.url });

    const login = await client.login('alice');

    expect(login).toMatchObject({ code: 'INTERNAL_ONLY', ok: false, status: 403 });
  });

  it('answers 503 for an authority it cannot reach', async () => {
    const client = httpClient({ token: 'token', url: await closedPort() });

    const results = await Promise.all([
      client.login('alice'),
      client.render('session', PAGE),
      client.publicView('counters', 'main'),
      client.events('session', 'subscription'),
      client.update('session', { binding: 'b', operationId: 'o', updaterId: SET_TITLE, value: '' }),
      client.operate('session', {
        args: [],
        build: BUILD,
        module: 'm',
        name: 'n',
        operationId: 'o',
      }),
    ]);

    const unreachable = { ...UNAVAILABLE, message: 'The authority could not be reached.' };

    expect(results).toStrictEqual(Array.from({ length: 6 }, () => unreachable));
  });

  it('waits, in development alone, for an authority starting on the port it refused', async () => {
    const url = await closedPort();
    const port = Number(new URL(url).port);
    vi.stubEnv('NODE_ENV', 'development');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const client = httpClient({ token: 'token', url });
    const asked = client.login('alice');
    await sleep(RESTART_GAP_MS);
    const authority = await startAuthority({ ...application, port, token: 'token' });
    onTestFinished(async () => {
      await authority.close();
    });

    await expect(asked).resolves.toMatchObject({ ok: true });
  });

  it('answers 503 for an authority that does not answer in time, the event stream’s opening included', async () => {
    const client = httpClient({ timeoutMs: 50, token: 'token', url: urlOf(await silent()) });

    const rendered = await client.render('session', PAGE);
    const events = await client.events('session', 'subscription');

    const late = { ...UNAVAILABLE, message: 'The authority did not answer in time.' };

    expect(rendered).toStrictEqual(late);
    expect(events).toStrictEqual(late);
  });

  it('times the opening of the event stream alone, never the stream', async () => {
    const authority = await start();
    const client = httpClient({ timeoutMs: 100, token: authority.token, url: authority.url });
    const alice = await signIn(client, 'alice');
    const counter = valueOf(await client.render(alice, COUNTER));
    const events = await subscribe(client, alice, counter.frame.subscription);

    await sleep(300);
    const { committedRevision } = valueOf(
      await client.update(alice, {
        binding: bindingOf(counter, 'components/counter', 'count'),
        operationId: 'o',
        updaterId: INCREMENT,
      }),
    );
    const later = await events.until(
      (event) => event.event === 'frame' && revisionOf(event.data) >= committedRevision,
    );

    expect(later.data).toStrictEqual({ frame: { revision: committedRevision } });
  });
});
