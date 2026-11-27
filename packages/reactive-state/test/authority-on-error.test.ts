import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { hostDatabase } from '../src/authority/database-host.ts';
import { Database } from '../src/authority/database.ts';
import { reporterOf } from '../src/authority/error-hook.ts';
import { refusal } from '../src/authority/errors.ts';
import { readAfterOperation } from '../src/authority/external-engine.ts';
import { ExternalTail } from '../src/authority/external-tail.ts';
import type { ExternalStore } from '../src/authority/external.ts';
import {
  type AuthorityErrorEvent,
  Engine,
  type EngineOptions,
  startAuthority,
} from '../src/authority/index.ts';
import { SharedStore } from '../src/authority/shared-store.ts';
import { PROTOCOL_VERSION } from '../src/program.ts';
import { forbidden, refuse } from '../src/server/index.ts';
import { db } from './support/app/db.ts';
import { logStore } from './support/follow-store.ts';
import { itemsReadThrough, itemTables } from './support/followed-items.ts';
import { clientOf } from './support/frames.ts';
import { application, BUILD, programs, SET_TITLE } from './support/program.ts';

/**
 * The application's `onError` is told of what an operation's code threw that is not the
 * authority's refusal, of a render's fault, and of a followed store's log that failed — in place
 * of the authority's own log — and changes no answer. Without it the logs stay.
 */

const TIMEOUT_MS = 50;

/** The turn after the one that met a fault: the hook is called on it. */
/** The binding the editor of a project's page writes its title by. */
function titleBinding(tree: Parameters<typeof clientOf>[0]): string {
  const state = clientOf(tree, 'components/todo-editor').part.states['title'];
  if (state === undefined || !('binding' in state) || typeof state.binding !== 'string') {
    throw new Error('There is no binding.');
  }
  return state.binding;
}

async function later(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
}

function spyOnLog() {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {
    // Silenced.
  });
  onTestFinished(() => {
    log.mockRestore();
  });
  return log;
}

const broken = {
  buildId: BUILD,
  component: 'test/broken',
  evaluate: () => {
    throw new Error('render broke');
  },
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

/** One error object, thrown by independent operations. */
const SHARED_ERROR = new Error('the same error object');

const SHARED_ROUTE = '/shared/[id]';
/** What the shared component throws: an error unless a test says otherwise. */
const thrown: { value: unknown } = { value: new Error('shared render broke') };
const sharedBroken = {
  buildId: BUILD,
  component: 'test/shared-broken',
  evaluate: () => {
    // Each evaluation fails with an error of its own, as independent failures do.
    throw thrown.value instanceof Error && thrown.value.constructor === Error
      ? new Error(thrown.value.message)
      : thrown.value;
  },
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

const operations = {
  ...application.operations,
  'test/ops': {
    forbids: (): never => forbidden(),
    plain: (): never => {
      throw new Error('plain throw');
    },
    refuses: (): never => refuse('MINE', 'no'),
    sameError: (): never => {
      throw SHARED_ERROR;
    },
    slow: async (): Promise<void> => {
      await new Promise((resolve) => {
        setTimeout(resolve, TIMEOUT_MS * 4);
      });
    },
    write: async (): Promise<void> => {
      await db.transaction(async () => {
        await db.todos.update('t1', { title: '書いた' });
      });
    },
  },
};

/**
 * A started authority over a hosted database of a followed table, whose log `store` answers, and
 * the poke its database notifies it with.
 */
async function hostedPoke(
  store: ExternalStore,
  onError: EngineOptions['onError'],
): Promise<() => void> {
  const hosted = itemsReadThrough(store);
  let poke: (() => void) | undefined;
  hostDatabase(hosted, {
    alone: async (work) => work(),
    close: () => Promise.resolve(),
    listen: (told) => {
      poke = told;
      return Promise.resolve();
    },
    migrate: () => Promise.resolve(),
    open: () => Promise.resolve(),
    prune: () => Promise.resolve(),
    seed: async (first) => first(),
    // The follow's store, a stand-in, is the declaration's: the host brings none of its own.
    stores: () => ({}),
  });
  const authority = await startAuthority({ ...application, database: hosted, onError });
  onTestFinished(async () => {
    await authority.close();
  });
  return () => {
    poke?.();
  };
}

async function open(options: Partial<EngineOptions> = {}) {
  const engine = new Engine({
    ...application,
    operations,
    programs: [...programs, broken, sharedBroken],
    routes: [
      {
        blocking: true,
        middleware: [],
        page: 'shared/page.tsx',
        params: ['id'],
        props: { id: 'id' },
        root: 'test/shared-broken',
        route: SHARED_ROUTE,
        shared: true,
      },
    ],
    timeoutMs: TIMEOUT_MS,
    ...options,
  });
  onTestFinished(async () => {
    await engine.close();
  });
  const alice = await engine.login('alice');
  const run = async (name: string) => {
    return engine.operate(alice.sessionId, {
      args: [],
      build: BUILD,
      module: 'test/ops',
      name,
      operationId: crypto.randomUUID(),
    });
  };
  return { alice: alice.sessionId, engine, run };
}

describe('onError', () => {
  type Told = readonly [unknown, AuthorityErrorEvent];

  it("is told of an operation's plain throw, which is still answered 422, and logs nothing", async () => {
    const log = spyOnLog();
    const told: Told[] = [];
    const { run } = await open({
      onError: (error, event) => {
        told.push([error, event]);
      },
    });

    await expect(run('plain')).rejects.toMatchObject({ code: 'OPERATION_REJECTED', status: 422 });

    await later();

    expect(told).toHaveLength(1);

    await later();

    expect(told[0]?.[1]).toMatchObject({
      kind: 'operation',
      module: 'test/ops',
      name: 'plain',
      operationId: expect.any(String),
    });
    expect((told[0]?.[0] as Error).message).toBe('plain throw');
    expect(log).not.toHaveBeenCalled();
  });

  it("is told of an operation's fault, its time", async () => {
    const told: Told[] = [];
    const { run } = await open({
      onError: (error, event) => {
        told.push([error, event]);
      },
    });

    await expect(run('slow')).rejects.toBeInstanceOf(Error);

    await later();

    expect(told).toHaveLength(1);

    await later();

    expect(told[0]?.[1]).toMatchObject({ kind: 'operation', name: 'slow' });
  });

  it("is told of nothing for an operation's refusal", async () => {
    const told: Told[] = [];
    const { run } = await open({
      onError: (error, event) => {
        told.push([error, event]);
      },
    });

    await expect(run('refuses')).rejects.toMatchObject({ status: 422 });
    await expect(run('forbids')).rejects.toMatchObject({ status: 403 });

    await later();

    expect(told).toHaveLength(0);
  });

  it("is told of a render's fault with its component", async () => {
    const told: Told[] = [];
    const { alice, engine } = await open({
      onError: (error, event) => {
        told.push([error, event]);
      },
    });

    await expect(
      engine.render(alice, { build: BUILD, component: 'test/broken', props: {} }),
    ).rejects.toBeInstanceOf(Error);

    await later();

    expect(told).toHaveLength(1);

    await later();

    expect(told[0]?.[1]).toStrictEqual({ component: 'test/broken', kind: 'render' });
  });

  it("is told of each of a shared route's render faults, in place of the log", async () => {
    const log = spyOnLog();
    const told: Told[] = [];
    const { alice, engine } = await open({
      onError: (error, event) => {
        told.push([error, event]);
      },
    });

    await expect(
      engine.renderShared(alice, { build: BUILD, props: { id: '1' }, route: SHARED_ROUTE }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      engine.gate({ headers: {}, method: 'GET', route: SHARED_ROUTE, url: '/shared/1' }),
    ).resolves.toBeDefined();

    await vi.waitFor(
      () => {
        expect(told.length).toBeGreaterThan(0);
      },
      { timeout: 5000 },
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });

    await later();

    expect(told.map(([, event]) => event)).toStrictEqual(
      told.map(() => ({ component: 'test/shared-broken', kind: 'render' })),
    );

    await later();

    expect(told.map(([error]) => error)).toHaveLength(new Set(told.map(([error]) => error)).size);
    expect(log).not.toHaveBeenCalled();
  });

  it('writes the shared route render log as before without the option', async () => {
    const log = spyOnLog();
    const { engine } = await open();

    await engine.gate({ headers: {}, method: 'GET', route: SHARED_ROUTE, url: '/shared/1' });
    await vi.waitFor(() => {
      expect(log.mock.calls.length).toBeGreaterThan(0);
    });

    expect(String(log.mock.calls[0]?.[0])).toContain('failed to render');
  });

  it('is told of a fault that answers a refusal whose keeping failed, not of the refusal', async () => {
    const told: Told[] = [];
    const { run } = await open({
      onError: (error, event) => {
        told.push([error, event]);
      },
    });
    const full = new Error('SQLITE_FULL');
    const insert = vi.spyOn(Database.prototype, 'insertOperation').mockImplementation(() => {
      throw full;
    });
    onTestFinished(() => {
      insert.mockRestore();
    });

    await expect(run('refuses')).rejects.toBe(full);

    await later();

    expect(told).toHaveLength(1);

    await later();

    expect(told[0]?.[0]).toBe(full);

    await later();

    expect(told[0]?.[1]).toMatchObject({ kind: 'operation', name: 'refuses' });
  });

  it('is told of a commit listener that threw, and the commit stands', async () => {
    const told: Told[] = [];
    const { engine, run } = await open({
      onError: (error, event) => {
        told.push([error, event]);
      },
    });
    engine.onCommit(() => {
      throw new Error('listener broke');
    });

    const receipt = await run('write');

    expect(receipt.committedRevision).not.toBeNull();

    await later();

    expect(told.map(([, event]) => event.kind)).toStrictEqual(['commit']);
  });

  it("is told of a followed store's log that could not be scheduled, in place of its log", async () => {
    const log = spyOnLog();
    const events: AuthorityErrorEvent[] = [];
    const store = logStore(() =>
      Promise.resolve({ changes: [], epoch: 'test', floor: 0, head: 0 }),
    );
    const tail = new ExternalTail({
      everyMs: 1000,
      ingest: () => Promise.resolve(),
      report: reporterOf((_error, event) => {
        events.push(event);
      }),
      retained: () => true,
      schedule: () => Promise.reject(new Error('alarm failed')),
      stores: new Map([['items', store]]),
      tables: itemTables(),
    });
    onTestFinished(() => {
      tail.stop();
    });

    tail.refresh();
    await vi.waitFor(() => {
      expect(events).toStrictEqual([{ kind: 'log' }]);
    });

    expect(log).not.toHaveBeenCalled();
  });

  it('logs a hook that throws or rejects, and answers as before', async () => {
    const log = spyOnLog();
    let sync = true;
    const { run } = await open({
      onError: () => {
        if (sync) {
          throw new Error('hook threw');
        }
        return Promise.reject(new Error('hook rejected'));
      },
    });

    await expect(run('plain')).rejects.toMatchObject({ code: 'OPERATION_REJECTED' });

    sync = false;

    await expect(run('plain')).rejects.toMatchObject({ code: 'OPERATION_REJECTED' });

    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledTimes(2);
    });

    expect(String(log.mock.calls[0]?.[0])).toContain('The onError hook failed');
  });

  it('writes the existing logs without the option', async () => {
    const log = spyOnLog();
    const { engine, run } = await open();
    engine.onCommit(() => {
      throw new Error('listener broke');
    });

    await run('write');

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('A commit listener failed');
  });

  it('answers an operation as the code threw it, whatever the hook does to the error', async () => {
    const { run } = await open({
      onError: (error) => {
        (error as Error).message = 'rewritten by the hook';
      },
    });

    await expect(run('plain')).rejects.toMatchObject({ message: 'plain throw' });
  });

  it('catches the rejection of a thenable of another realm that the hook returns', async () => {
    const log = spyOnLog();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    onTestFinished(() => {
      process.off('unhandledRejection', unhandled);
    });
    const failing = {
      // eslint-disable-next-line unicorn/no-thenable -- a promise of another realm
      then: (_resolve: unknown, reject: (reason: unknown) => void) => {
        reject(new Error('thenable rejected'));
      },
    };
    const { run } = await open({ onError: () => failing as unknown as Promise<void> });

    await expect(run('plain')).rejects.toMatchObject({ code: 'OPERATION_REJECTED' });

    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledTimes(1);
    });

    expect(unhandled).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain('thenable rejected');
  });

  it('tells of a failed read once, however many operations wait on the same one', async () => {
    spyOnLog();
    const events: AuthorityErrorEvent[] = [];
    const store = logStore(() => Promise.reject(new Error('read failed')));
    const tail = new ExternalTail({
      ingest: () => Promise.resolve(),
      report: reporterOf((_error, event) => {
        events.push(event);
      }),
      stores: new Map([['items', store]]),
      tables: itemTables(),
    });
    onTestFinished(() => {
      tail.stop();
    });

    // The first reads; the other two wait on the one read queued behind it, and share its failure.
    await Promise.all([
      readAfterOperation(tail),
      readAfterOperation(tail),
      readAfterOperation(tail),
    ]);

    await later();

    expect(events).toStrictEqual([{ kind: 'log' }, { kind: 'log' }]);
  });

  it("is told of a route guard's fault, naming the route", async () => {
    const log = spyOnLog();
    const told: Told[] = [];
    const engine = new Engine({
      ...application,
      middleware: {
        broken: {
          buildId: BUILD,
          guard: () => {
            throw new Error('guard broke');
          },
          id: 'broken',
          protocolVersion: PROTOCOL_VERSION,
        },
      },
      onError: (error, event) => {
        told.push([error, event]);
      },
      routes: [
        {
          blocking: true,
          guarded: true,
          middleware: ['broken'],
          page: 'guarded/page.tsx',
          params: ['id'],
          props: { id: 'id' },
          root: 'components/counter',
          route: '/guarded/[id]',
          shared: false,
        },
      ],
    });
    onTestFinished(async () => {
      await engine.close();
    });

    await expect(
      engine.guardRoute(null, { route: '/guarded/[id]', url: '/guarded/1' }),
    ).rejects.toBeInstanceOf(Error);

    await later();

    expect(told.map(([, event]) => event)).toStrictEqual([
      { kind: 'route', route: '/guarded/[id]' },
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['an error', new Error('log read failed')],
    ['a primitive', 'log read failed'],
  ])(
    "is told of a hosted database's change log that could not be read, once, rejecting with %s",
    async (_what, rejection) => {
      const log = spyOnLog();
      const events: AuthorityErrorEvent[] = [];
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a primitive, as tested
      const store = logStore(() => Promise.reject(rejection));
      const poke = await hostedPoke(store, (_error, event) => {
        events.push(event);
      });

      poke();
      await vi.waitFor(() => {
        expect(events).toStrictEqual([{ kind: 'log' }]);
      });
      await later();

      expect(events).toStrictEqual([{ kind: 'log' }]);
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("writes a hosted database's change log failure once without the option", async () => {
    const log = spyOnLog();
    const store = logStore(() => Promise.reject(new Error('log read failed')));
    const poke = await hostedPoke(store, undefined);

    poke();
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledTimes(1);
    });
    await later();

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('Reading the change log failed');
  });

  it.each([
    ['a primitive', 'render broke'],
    ['a function', () => 'render broke'],
  ])('tells once of a shared component that throws %s', async (_what, value) => {
    spyOnLog();
    thrown.value = value;
    onTestFinished(() => {
      thrown.value = new Error('shared render broke');
    });
    const told: Told[] = [];
    const { engine } = await open({
      onError: (error, event) => {
        told.push([error, event]);
      },
    });

    await engine.gate({ headers: {}, method: 'GET', route: SHARED_ROUTE, url: '/shared/1' });
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    await later();

    expect(told.map(([, event]) => event)).toStrictEqual([
      { component: 'test/shared-broken', kind: 'render' },
    ]);
  });

  it('tells of two independent failures that throw the same primitive', async () => {
    spyOnLog();
    thrown.value = 'render broke';
    onTestFinished(() => {
      thrown.value = new Error('shared render broke');
    });
    const told: Told[] = [];
    const { alice, engine } = await open({
      onError: (error, event) => {
        told.push([error, event]);
      },
    });
    const ask = async (id: string) =>
      engine.renderShared(alice, { build: BUILD, props: { id }, route: SHARED_ROUTE });

    await expect(ask('1')).rejects.toBe('render broke');
    await expect(ask('2')).rejects.toBe('render broke');

    await later();

    expect(told).toHaveLength(2);
  });

  it("tells of a clean-up that failed after a render's fault, as well as of the fault", async () => {
    spyOnLog();
    const store = vi.spyOn(SharedStore.prototype, 'put').mockImplementation(() => {
      throw new Error('store broke');
    });
    onTestFinished(() => {
      store.mockRestore();
    });
    const told: Told[] = [];
    const { engine } = await open({
      onError: (error, event) => {
        told.push([error, event]);
      },
    });

    await engine.gate({ headers: {}, method: 'GET', route: SHARED_ROUTE, url: '/shared/1' });
    await vi.waitFor(() => {
      expect(told.map(([, event]) => event.kind)).toContain('shared-view');
    });

    await later();

    expect(told.map(([, event]) => event.kind)).toStrictEqual(['render', 'shared-view']);
    expect(String(told[1]?.[0])).toContain('store broke');
  });

  it("tells of a hook's rewrite of a render's fault only after the render's answer", async () => {
    const { alice, engine } = await open({
      onError: (error) => {
        (error as Error).message = 'rewritten by the hook';
      },
    });

    await expect(
      engine.render(alice, { build: BUILD, component: 'test/broken', props: {} }),
    ).rejects.toMatchObject({ message: 'render broke' });
  });

  it('tells nothing of a shared view whose render threw a refusal, and logs it as before', async () => {
    const log = spyOnLog();
    thrown.value = refusal(422, 'MINE', 'refused');
    onTestFinished(() => {
      thrown.value = new Error('shared render broke');
    });
    const told: Told[] = [];
    const { engine } = await open({
      onError: (error, event) => {
        told.push([error, event]);
      },
    });

    await engine.gate({ headers: {}, method: 'GET', route: SHARED_ROUTE, url: '/shared/1' });
    await vi.waitFor(
      () => {
        expect(log.mock.calls.length).toBeGreaterThan(0);
      },
      { timeout: 5000 },
    );

    expect(String(log.mock.calls[0]?.[0])).toContain('failed to render');

    await later();

    expect(told).toHaveLength(0);
  });

  it("tells of an operation's fault only after the wait on the stores' logs, which it ends in", async () => {
    const store = logStore(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      return { changes: [], epoch: 'test', floor: 0, head: 0 };
    });
    const engine = new Engine({
      ...application,
      database: itemsReadThrough(store),
      onError: (error) => {
        (error as Error).message = 'rewritten by the hook';
      },
      operations: { 'test/ops': operations['test/ops'] },
      programs: [],
      timeoutMs: 10,
    });
    onTestFinished(async () => {
      await engine.close();
    });
    const { sessionId } = await engine.login('alice');

    await expect(
      engine.operate(sessionId, {
        args: [],
        build: BUILD,
        module: 'test/ops',
        name: 'slow',
        operationId: crypto.randomUUID(),
      }),
    ).rejects.not.toMatchObject({ message: 'rewritten by the hook' });
  });

  describe('a route guard that throws', () => {
    const GUARDED = '/guarded/[id]';
    function guarded(onError: EngineOptions['onError'], thrownValue: unknown, shared = false) {
      const engine = new Engine({
        ...application,
        middleware: {
          broken: {
            buildId: BUILD,
            guard: () => {
              throw thrownValue;
            },
            id: 'broken',
            protocolVersion: PROTOCOL_VERSION,
          },
        },
        onError,
        routes: [
          {
            blocking: true,
            guarded: true,
            middleware: ['broken'],
            page: 'guarded/page.tsx',
            params: ['id'],
            props: { id: 'id' },
            root: 'components/counter',
            route: GUARDED,
            shared,
          },
        ],
      });
      onTestFinished(async () => {
        await engine.close();
      });
      return engine;
    }
    const route = { kind: 'route', route: GUARDED };

    it.each([
      ['an error', new Error('guard broke')],
      ['a primitive', 'guard broke'],
    ])('is told of once as the route’s, in a direct render, throwing %s', async (_what, value) => {
      spyOnLog();
      const told: Told[] = [];
      const engine = guarded((error, event) => {
        told.push([error, event]);
      }, value);
      const { sessionId } = await engine.login('alice');

      await expect(
        engine.render(sessionId, {
          build: BUILD,
          component: 'components/counter',
          props: { id: '1' },
        }),
      ).rejects.toBeDefined();

      await later();

      expect(told.map(([, event]) => event)).toStrictEqual([route]);
    });

    it('is told of once as the route’s, in a shared evaluation', async () => {
      spyOnLog();
      const told: Told[] = [];
      const engine = guarded(
        (error, event) => {
          told.push([error, event]);
        },
        'guard broke',
        true,
      );

      await engine.gate({ headers: {}, method: 'GET', route: GUARDED, url: '/guarded/1' });
      await later();
      await later();

      expect(told.map(([, event]) => event)).toStrictEqual([route]);
    });
  });

  it('is told of an explicit poke whose read failed, once, and still rejects', async () => {
    spyOnLog();
    const store = logStore(() => Promise.reject(new Error('read failed')));
    const events: AuthorityErrorEvent[] = [];
    const engine = new Engine({
      ...application,
      database: itemsReadThrough(store),
      onError: (_error, event) => {
        events.push(event);
      },
      programs: [],
    });
    onTestFinished(async () => {
      await engine.close();
    });

    await expect(engine.poke()).rejects.toThrow('read failed');

    await later();

    expect(events).toStrictEqual([{ kind: 'log' }]);
  });

  it('is told once, as the route’s, of a guard that throws a primitive as a write replays', async () => {
    spyOnLog();
    const told: Told[] = [];
    const flaky = { broken: false };
    const engine = new Engine({
      ...application,
      middleware: {
        flaky: {
          buildId: BUILD,
          guard: () => {
            if (flaky.broken) {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- a primitive, as tested
              throw 'guard broke';
            }
          },
          id: 'flaky',
          protocolVersion: PROTOCOL_VERSION,
        },
      },
      onError: (error, event) => {
        told.push([error, event]);
      },
      routes: [
        {
          blocking: true,
          guarded: true,
          middleware: ['flaky'],
          page: 'projects/page.tsx',
          params: ['projectId'],
          props: { projectId: 'projectId' },
          root: 'components/project',
          route: '/projects/[projectId]',
          shared: false,
        },
      ],
    });
    onTestFinished(async () => {
      await engine.close();
    });
    const { sessionId } = await engine.login('alice');
    const rendered = await engine.render(sessionId, {
      build: BUILD,
      component: 'components/project',
      props: { filter: 'all', projectId: 'p1', selectedId: 't1' },
    });
    const binding = titleBinding(rendered.tree);
    flaky.broken = true;

    await expect(
      engine.update(sessionId, {
        binding,
        operationId: crypto.randomUUID(),
        updaterId: SET_TITLE,
        value: 'later',
      }),
    ).rejects.toBe('guard broke');

    await later();

    expect(told.map(([, event]) => event)).toStrictEqual([
      { kind: 'route', route: '/projects/[projectId]' },
    ]);
  });

  it('tells of one error object thrown by two independent operations, each time', async () => {
    const told: Told[] = [];
    const { run } = await open({
      onError: (error, event) => {
        told.push([error, event]);
      },
    });

    await expect(run('sameError')).rejects.toMatchObject({ code: 'OPERATION_REJECTED' });
    await expect(run('sameError')).rejects.toMatchObject({ code: 'OPERATION_REJECTED' });

    await later();

    expect(told.map(([error]) => error)).toStrictEqual([SHARED_ERROR, SHARED_ERROR]);
  });

  it('tells of a read once where it is made, however many pokes wait on it', async () => {
    spyOnLog();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a primitive, as tested
    const store = logStore(() => Promise.reject('read failed'));
    const events: AuthorityErrorEvent[] = [];
    const engine = new Engine({
      ...application,
      database: itemsReadThrough(store),
      onError: (_error, event) => {
        events.push(event);
      },
      programs: [],
    });
    onTestFinished(async () => {
      await engine.close();
    });

    await Promise.allSettled([engine.poke(), engine.poke(), engine.poke()]);
    await later();

    // The first poke starts a read; the other two wait on the one queued behind it.
    expect(events).toStrictEqual([{ kind: 'log' }, { kind: 'log' }]);
  });
});
