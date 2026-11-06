import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  type AuthorityClient,
  type AuthorityNamespace,
  bindingClient,
} from '../src/client/index.ts';
import type { OperationCall, RenderResult, Result, RootRequest } from '../src/program.ts';
import type { GateRequest, GuardRequest, SharedRenderRequest } from '../src/routing.ts';
import { frameOf } from './support/frames.ts';

/** A render, as the object answers one. */
const RENDERED: RenderResult = { frame: frameOf(3, 1), status: 'rendered', tree: null };
/** The counter's root, and the fixture's project page. */
const COUNTER: RootRequest = {
  build: 'b_test',
  component: 'components/counter',
  props: { id: 'main' },
};
const PAGE: RootRequest = {
  build: 'b_test',
  component: 'components/project',
  props: { filter: 'all', projectId: 'p1' },
};
const CALL: OperationCall = {
  args: [{ json: 'p1' }, { form: [['title', 'あとで']] }],
  build: 'b_test',
  module: 'actions/todos',
  name: 'createTodo',
  operationId: 'op',
};

const TOO_SLOW = {
  code: 'AUTHORITY_UNAVAILABLE',
  message: 'The authority did not answer in time.',
  ok: false,
  status: 503,
};
const UNREACHABLE = { ...TOO_SLOW, message: 'The authority could not be reached.' };

function notImplemented(): never {
  throw new Error('not a method this test calls');
}

/** A stub that answers what `methods` answer, and throws for anything else. */
function stubOf(methods: Partial<AuthorityClient>): AuthorityClient {
  return {
    endSession: notImplemented,
    events: notImplemented,
    gate: notImplemented,
    guardRoute: notImplemented,
    login: notImplemented,
    logout: notImplemented,
    operate: notImplemented,
    publicView: notImplemented,
    render: notImplemented,
    renderShared: notImplemented,
    sharedEvents: notImplemented,
    update: notImplemented,
    view: notImplemented,
    ...methods,
  };
}

/** A namespace holding one object, and the names it was asked for. */
function namespaceOf(stub: AuthorityClient): {
  readonly namespace: AuthorityNamespace;
  readonly names: string[];
} {
  const names: string[] = [];
  return {
    namespace: {
      getByName: (name) => {
        names.push(name);
        return stub;
      },
    },
    names,
  };
}

/** A promise that never settles: an object that was asked and never answered. */
async function never<T>(): Promise<T> {
  return new Promise<T>(() => {
    // Never settled.
  });
}

function fakeTimers(): void {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

describe('bindingClient', () => {
  it('asks the one object named `authority`, and answers what it answered', async () => {
    const refusal = {
      code: 'UNAUTHENTICATED',
      message: 'Sign in first.',
      ok: false,
      status: 401,
    } as const;
    const view = {
      id: 'main',
      resultVersion: 'r',
      revision: 3,
      table: 'counters',
      values: { count: 1 },
    };
    const publicView = vi
      .fn<AuthorityClient['publicView']>()
      .mockResolvedValue({ ok: true, value: view });
    const { namespace, names } = namespaceOf(
      stubOf({
        login: vi
          .fn<AuthorityClient['login']>()
          .mockResolvedValue({ ok: true, value: { sessionId: 's1', userId: 'alice' } }),
        logout: vi.fn<AuthorityClient['logout']>().mockResolvedValue(refusal),
        publicView,
      }),
    );
    const client = bindingClient(namespace);

    const login = await client.login('alice');
    const logout = await client.logout('s1');
    const shown = await client.publicView('counters', 'main');

    expect(login).toStrictEqual({ ok: true, value: { sessionId: 's1', userId: 'alice' } });
    expect(logout).toStrictEqual(refusal);
    expect(shown).toStrictEqual({ ok: true, value: view });
    expect(publicView).toHaveBeenCalledExactlyOnceWith('counters', 'main');
    expect(names).toStrictEqual(['authority', 'authority', 'authority']);
  });

  it('asks for the object where a hint places it, and for it alone where none does', async () => {
    const stub = stubOf({
      endSession: vi
        .fn<AuthorityClient['endSession']>()
        .mockResolvedValue({ ok: true, value: null }),
    });
    const getByName = vi.fn<AuthorityNamespace['getByName']>().mockReturnValue(stub);

    await bindingClient({ getByName }, { locationHint: 'wnam' }).endSession('k1');
    await bindingClient({ getByName }).endSession('k1');

    expect(getByName.mock.calls).toStrictEqual([
      ['authority', { locationHint: 'wnam' }],
      ['authority'],
    ]);
  });

  it('sends an asserted session’s three fields alone, and a session of another shape as none', async () => {
    const logout = vi.fn<AuthorityClient['logout']>().mockResolvedValue({ ok: true, value: null });
    const { namespace } = namespaceOf(stubOf({ logout }));
    const client = bindingClient(namespace);
    const session = { expires: 1, id: 'k1', user: 'alice' };

    await client.logout({ ...session, bearer: 'the sign-in’s own token' } as typeof session);
    await client.logout({ expires: 1, id: 'k.1', user: 'alice' });

    expect(logout.mock.calls).toStrictEqual([[session], [null]]);
  });

  it('names the deployment asking in every render, unless the caller names its own', async () => {
    const render = vi
      .fn<AuthorityClient['render']>()
      .mockResolvedValue({ ok: true, value: RENDERED });
    const { namespace } = namespaceOf(stubOf({ render }));

    const answered = await bindingClient(namespace, { deployment: 'dpl_a' }).render('s1', COUNTER);
    await bindingClient(namespace, { deployment: 'dpl_a' }).render('s1', COUNTER, {
      deployment: 'dpl_b',
    });
    await bindingClient(namespace).render(null, PAGE);

    expect(answered).toStrictEqual({ ok: true, value: RENDERED });
    expect(render.mock.calls).toStrictEqual([
      ['s1', COUNTER, { deployment: 'dpl_a' }],
      ['s1', COUNTER, { deployment: 'dpl_b' }],
      [null, PAGE, {}],
    ]);
  });

  it('sends a root, a view, a write and an operation with their own fields alone', async () => {
    const refused = { code: 'FORBIDDEN', message: 'No.', ok: false, status: 403 } as const;
    const update = vi.fn<AuthorityClient['update']>().mockResolvedValue(refused);
    const operate = vi.fn<AuthorityClient['operate']>().mockResolvedValue(refused);
    const render = vi
      .fn<AuthorityClient['render']>()
      .mockResolvedValue({ ok: true, value: RENDERED });
    const view = vi.fn<AuthorityClient['view']>().mockResolvedValue({ ok: true, value: RENDERED });
    const events = vi
      .fn<AuthorityClient['events']>()
      .mockResolvedValue({ ok: true, value: new ReadableStream<Uint8Array>() });
    const client = bindingClient(
      namespaceOf(stubOf({ events, operate, render, update, view })).namespace,
      { deployment: 'dpl_a' },
    );
    const extra = { onCommit: vi.fn<() => void>() };
    const shown = { part: { d0: { filter: 'done' } } };

    await client.update('s1', { binding: 'b', operationId: 'op', updaterId: 'u', ...extra });
    await client.operate('s1', { ...CALL, ...extra });
    await client.render('s1', { ...PAGE, ...extra });
    await client.view('s1', { subscription: 'subscription', view: shown, ...extra });
    await client.events('s1', 'subscription');

    expect(update.mock.calls).toStrictEqual([
      ['s1', { binding: 'b', operationId: 'op', updaterId: 'u' }],
    ]);
    expect(operate.mock.calls).toStrictEqual([['s1', CALL]]);
    expect(render.mock.calls).toStrictEqual([['s1', PAGE, { deployment: 'dpl_a' }]]);
    expect(view.mock.calls).toStrictEqual([
      ['s1', { subscription: 'subscription', view: shown }, { deployment: 'dpl_a' }],
    ]);
    expect(events.mock.calls).toStrictEqual([['s1', 'subscription']]);
  });

  it('keeps guard admission optional across the RPC request and answer boundary', async () => {
    const guardRoute = vi
      .fn<AuthorityClient['guardRoute']>()
      .mockResolvedValueOnce({ ok: true, value: { kind: 'pass' } })
      .mockResolvedValueOnce({
        ok: true,
        value: { admission: 'signed-initial-decision', kind: 'pass' },
      });
    const client = bindingClient(namespaceOf(stubOf({ guardRoute })).namespace);
    const request: GuardRequest = { route: '/boards/[projectId]', url: '/boards/p1' };
    const legacy = await client.guardRoute('s1', {
      ...request,
      extra: 'discarded',
    } as GuardRequest);
    const admitted = await client.guardRoute('s1', {
      ...request,
      admit: true,
      extra: 'discarded',
    } as GuardRequest);

    expect(guardRoute.mock.calls).toStrictEqual([
      ['s1', request],
      ['s1', { ...request, admit: true }],
    ]);
    expect(legacy).toStrictEqual({ ok: true, value: { kind: 'pass' } });
    expect(admitted).toStrictEqual({
      ok: true,
      value: { admission: 'signed-initial-decision', kind: 'pass' },
    });
  });

  it.each([undefined, 'signed-initial-decision'])(
    'sends a shared render with only its own fields and optional admission: %s',
    async (admission) => {
      const renderShared = vi.fn<AuthorityClient['renderShared']>().mockResolvedValue({
        code: 'UNKNOWN_ROUTE',
        message: 'There is no such route.',
        ok: false,
        status: 404,
      });
      const client = bindingClient(namespaceOf(stubOf({ renderShared })).namespace);
      const request: SharedRenderRequest = {
        ...(admission !== undefined && { admission }),
        build: 'b_test',
        props: { projectId: 'p1' },
        route: '/boards/[projectId]',
        site: { basePath: '/docs', trailingSlash: true },
      };

      await client.renderShared(null, { ...request, extra: 'x' } as SharedRenderRequest);

      expect(renderShared.mock.calls).toStrictEqual([[null, request, {}]]);
    },
  );

  it('names the deployment asking in every shared render, unless the caller names its own', async () => {
    const renderShared = vi.fn<AuthorityClient['renderShared']>().mockResolvedValue({
      code: 'UNKNOWN_ROUTE',
      message: 'There is no such route.',
      ok: false,
      status: 404,
    });
    const { namespace } = namespaceOf(stubOf({ renderShared }));
    const request: SharedRenderRequest = {
      build: 'b_test',
      props: { projectId: 'p1' },
      route: '/boards/[projectId]',
    };

    await bindingClient(namespace, { deployment: 'dpl_a' }).renderShared(null, request);
    await bindingClient(namespace, { deployment: 'dpl_a' }).renderShared(null, request, {
      deployment: 'dpl_b',
    });

    expect(renderShared.mock.calls).toStrictEqual([
      [null, request, { deployment: 'dpl_a' }],
      [null, request, { deployment: 'dpl_b' }],
    ]);
  });

  it('sends a gate’s question with where its site serves its routes, by its own fields alone', async () => {
    const gate = vi
      .fn<AuthorityClient['gate']>()
      .mockResolvedValue({ ok: true, value: { kind: 'pass' } });
    const client = bindingClient(namespaceOf(stubOf({ gate })).namespace);
    const request: GateRequest = {
      headers: { rsc: '1' },
      method: 'GET',
      route: '/boards/[projectId]',
      site: { basePath: '/docs', trailingSlash: true },
      url: '/docs/boards/p1/',
    };

    await client.gate({ ...request, extra: 'x' } as GateRequest);

    expect(gate.mock.calls).toStrictEqual([[request]]);
  });

  it('names in each gate’s question the deployment asking, unless the question names its own', async () => {
    const gate = vi
      .fn<AuthorityClient['gate']>()
      .mockResolvedValue({ ok: true, value: { kind: 'pass' } });
    const { namespace } = namespaceOf(stubOf({ gate }));
    const client = bindingClient(namespace, { deployment: 'dpl_a' });
    const request: GateRequest = {
      headers: {},
      method: 'GET',
      route: '/boards/[projectId]',
      url: '/boards/p1',
    };

    await client.gate(request);
    await client.gate({ ...request, deployment: 'dpl_b' });

    expect(gate.mock.calls).toStrictEqual([
      [{ ...request, deployment: 'dpl_a' }],
      [{ ...request, deployment: 'dpl_b' }],
    ]);
  });

  it('sends a value as it is, `false`, `0` and empty text among them, an update’s captures, and none when there is none', async () => {
    const update = vi
      .fn<AuthorityClient['update']>()
      .mockResolvedValue({ code: 'FORBIDDEN', message: 'No.', ok: false, status: 403 });
    const client = bindingClient(namespaceOf(stubOf({ update })).namespace);
    const write = { binding: 'b', operationId: 'op', updaterId: 'u_set' };

    for (const value of [false, 0, '', 'Oat milk']) {
      await client.update('s1', { ...write, value });
    }
    await client.update('s1', { ...write, captures: { step: 5 } });
    await client.update('s1', write);

    expect(update.mock.calls).toStrictEqual([
      ['s1', { ...write, value: false }],
      ['s1', { ...write, value: 0 }],
      ['s1', { ...write, value: '' }],
      ['s1', { ...write, value: 'Oat milk' }],
      ['s1', { ...write, captures: { step: 5 } }],
      ['s1', write],
    ]);
  });

  it('answers 503 for a call that takes longer than 15 s', async () => {
    fakeTimers();
    const { namespace } = namespaceOf(stubOf({ render: never }));

    const answer = bindingClient(namespace).render('s1', COUNTER);
    await vi.advanceTimersByTimeAsync(14_999);
    // An answer already there wins the race; one still awaited loses it to the marker.
    const early = await Promise.race([answer, Promise.resolve('pending')]);
    await vi.advanceTimersByTimeAsync(1);

    expect(early).toBe('pending');
    await expect(answer).resolves.toStrictEqual(TOO_SLOW);
  });

  it('answers 503 for a call that fails, or that answers something other than a result', async () => {
    const thrown = namespaceOf(
      stubOf({
        login: () => {
          throw new Error('Durable Object reset because its code was updated.');
        },
      }),
    );
    const gone = vi.fn<AuthorityClient['login']>().mockRejectedValue(new Error('gone'));
    const rejected = namespaceOf(stubOf({ login: gone }));
    const malformed = namespaceOf(
      stubOf({
        login: vi
          .fn<AuthorityClient['login']>()
          .mockResolvedValue(undefined as unknown as Result<never>),
      }),
    );
    const unbound: AuthorityNamespace = {
      getByName: () => {
        throw new TypeError('not a namespace');
      },
    };

    const answers = await Promise.all(
      [thrown.namespace, rejected.namespace, unbound].map(async (namespace) =>
        bindingClient(namespace).login('alice'),
      ),
    );
    const odd = await bindingClient(malformed.namespace).login('alice');

    expect(answers).toStrictEqual([UNREACHABLE, UNREACHABLE, UNREACHABLE]);
    expect(odd).toStrictEqual({
      ...UNREACHABLE,
      message: 'The authority answered something other than a result.',
    });
  });

  it('times the opening of an event stream alone, and lets go of one that came too late', async () => {
    fakeTimers();
    const opened = new ReadableStream<Uint8Array>();
    const late = Promise.withResolvers<Result<ReadableStream<Uint8Array>>>();
    const cancelled = vi.fn<(reason: unknown) => void>();
    const tooLate = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const events = vi
      .fn<AuthorityClient['events']>()
      .mockResolvedValueOnce({ ok: true, value: opened })
      .mockReturnValueOnce(late.promise);
    const client = bindingClient(namespaceOf(stubOf({ events })).namespace);

    const first = await client.events('s1', 'subscription');
    await vi.advanceTimersByTimeAsync(60_000);
    const second = client.events('s1', 'subscription');
    await vi.advanceTimersByTimeAsync(15_000);
    const gaveUp = await second;
    late.resolve({ ok: true, value: tooLate });
    await vi.advanceTimersByTimeAsync(0);

    expect(first).toStrictEqual({ ok: true, value: opened });
    expect(opened.locked).toBe(false);
    expect(gaveUp).toStrictEqual(TOO_SLOW);
    expect(cancelled).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});
