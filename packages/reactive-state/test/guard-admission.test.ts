import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { type CommitEvent, Engine } from '../src/authority/index.ts';
import { PublicViews } from '../src/authority/public.ts';
import { SharedViews } from '../src/authority/shared-views.ts';
import { type ComponentProgram, PROTOCOL_VERSION, type RenderScope } from '../src/program.ts';
import type { RouteRegistration, SharedRenderAnswer } from '../src/routing.ts';
import { currentUser, forbidden } from '../src/server/index.ts';
import { db } from './support/app/db.ts';
import { clientOf, textOf } from './support/frames.ts';
import { BUILD, counterProgram, INCREMENT } from './support/program.ts';

const ROUTE = '/admitted/[id]';
const OTHER_ROUTE = '/other-admitted/[id]';
const EDIT_ROUTE = '/editable-admitted/[id]';
const COMPONENT = 'components/admitted';
const EDITABLE = 'components/editable-admitted';
const GUARD = 'admitted';
const TIMES = { hour: 3_600_000 };

interface GuardState {
  allowed: boolean;
  once: boolean;
  calls: number;
}

/** The registered route's actual params, shared by its precheck and its root. */
function route(name: string, root: string, shared = false): RouteRegistration {
  return {
    blocking: true,
    guarded: true,
    middleware: [GUARD],
    page: `${name.slice(1)}/page.tsx`,
    params: ['id'],
    props: { id: 'id' },
    root,
    route: name,
    shared,
  };
}

/** A captured once-success permission, with a database dependency outside the root's reads. */
function opened(
  options: {
    readonly state?: GuardState;
    readonly build?: string;
    readonly shared?: boolean;
    readonly filename?: string;
    readonly clock?: () => number;
  } = {},
) {
  const { build = BUILD, shared = false } = options;
  const state = options.state ?? { allowed: true, calls: 0, once: true };
  const view: ComponentProgram = {
    buildId: build,
    component: COMPONENT,
    protocolVersion: PROTOCOL_VERSION,
    updaters: {},
    writable: [],
    evaluate: async (props: Readonly<Record<string, unknown>>, $: RenderScope) => {
      const counter = await db.counters.get(String(props['id']));
      return $.h('p', null, String(counter?.count ?? 'missing'));
    },
  };
  const engine = new Engine({
    buildId: build,
    database: db,
    middleware: {
      [GUARD]: {
        buildId: build,
        id: GUARD,
        protocolVersion: PROTOCOL_VERSION,
        guard: async () => {
          await currentUser();
          state.calls += 1;
          if (!state.allowed) forbidden();
          const project = await db.projects.get('p1');
          if (project?.ownerId !== 'alice') forbidden();
          if (state.once) state.allowed = false;
        },
      },
    },
    operations: {
      'actions/admission': {
        async setCount(id: unknown, count: unknown): Promise<void> {
          await db.transaction(async () => {
            await db.counters.update(String(id), { count: Number(count) });
          });
        },
        async setProjectTitle(title: unknown): Promise<void> {
          await db.transaction(async () => {
            await db.projects.update('p1', { title: String(title) });
          });
        },
      },
    },
    programs: [
      view,
      { ...view, component: 'components/other-admitted' },
      { ...counterProgram, buildId: build, component: EDITABLE },
    ],
    routes: [
      route(ROUTE, COMPONENT, shared),
      route(OTHER_ROUTE, 'components/other-admitted'),
      route(EDIT_ROUTE, EDITABLE),
    ],
    ...(options.filename !== undefined && { filename: options.filename }),
    ...(options.clock !== undefined && { clock: options.clock }),
  });
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= engine.close();
    return closed;
  };
  onTestFinished(close);
  return { close, engine, state };
}

/** An optional receipt lets unchanged sources reach the duplicated guard, rather than fail setup. */
async function admit(
  engine: Engine,
  session: string | null,
  name = ROUTE,
): Promise<string | undefined> {
  const passed = await engine.guardRoute(session, {
    admit: true,
    route: name,
    url: name.replace('[id]', 'main'),
  });

  expect(passed.kind).toBe('pass');

  return (passed as { readonly admission?: string }).admission;
}

/** The root's existing authority call, carrying admission only on its initial render. */
function render(
  engine: Engine,
  session: string | null,
  admission?: string,
  at: { readonly route?: string; readonly id?: string } = {},
): Promise<SharedRenderAnswer> {
  const { route: name = ROUTE, id = 'main' } = at;
  return engine.renderShared(session, {
    admission,
    build: engine.buildId,
    props: { id },
    route: name,
  });
}

/** A real committed write, independent of the route's initial render. */
async function operate(
  engine: Engine,
  session: string,
  name: string,
  args: readonly unknown[],
): Promise<void> {
  await engine.operate(session, {
    args: args.map((json) => ({ json })),
    build: engine.buildId,
    module: 'actions/admission',
    name,
    operationId: `admission-${name}`,
  });
}

/** A database whose sessions and secret survive the admission's originating authority boot. */
async function databaseFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'reactive-guard-admission-'));
  onTestFinished(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  return join(directory, 'authority.sqlite');
}

/** A changed receipt or target, prepared outside the assertion that verifies its guard. */
function changedContext(
  changed: string,
  sessions: { readonly alice: string; readonly bob: string },
  admission: string | undefined,
): {
  readonly session: string | null;
  readonly admission: string | undefined;
  readonly route: string;
  readonly id: string;
} {
  let token = admission;
  switch (changed) {
    case 'malformed': {
      token = 'malformed';
      break;
    }
    case 'tampered': {
      token = `${admission ?? ''}x`;
      break;
    }
    case 'empty': {
      token = '';
      break;
    }
    // No default
  }
  let session: string | null = sessions.alice;
  if (changed === 'session') session = sessions.bob;
  else if (changed === 'anonymous') session = null;
  return {
    session,
    admission: token,
    route: changed === 'route' ? OTHER_ROUTE : ROUTE,
    id: changed === 'params' ? 'other' : 'main',
  };
}

describe('a route precheck admitted on its initial render', () => {
  it.each([false, true])(
    'reuses one successful evaluation for a session root (shared candidate: %s)',
    async (shared) => {
      const { engine, state } = opened({ shared });
      const { sessionId } = await engine.login('alice');
      const admission = await admit(engine, sessionId);
      const shown = await render(engine, sessionId, admission);

      expect(shown).toMatchObject({ kind: 'session', result: { status: 'rendered' } });
      expect(textOf(shown.result.tree)).toBe('0');
      expect(state.calls).toBe(1);
      expect(admission).toBeTypeOf('string');
      expect(JSON.stringify(shown)).not.toContain(admission);
    },
  );

  it('keeps optional currentUser guards working for an anonymous admitted root', async () => {
    const { engine, state } = opened();
    const admission = await admit(engine, null);

    await expect(render(engine, null, admission)).resolves.toMatchObject({
      kind: 'session',
      result: { status: 'rendered' },
    });
    expect(state.calls).toBe(1);
  });

  it('asks a later delivery for fresh permission', async () => {
    const { engine, state } = opened();
    const { sessionId } = await engine.login('alice');
    const admission = await admit(engine, sessionId);

    await expect(render(engine, sessionId, admission)).resolves.toMatchObject({
      result: { status: 'rendered' },
    });
    await expect(
      engine.guardRoute(sessionId, { admit: true, route: ROUTE, url: '/admitted/main' }),
    ).resolves.toStrictEqual({ kind: 'refused' });
    expect(state.calls).toBe(2);
  });

  it('preserves ordinary passes and guards direct renders without admission', async () => {
    const { engine, state } = opened();
    const { sessionId } = await engine.login('alice');

    await expect(
      engine.guardRoute(sessionId, { route: ROUTE, url: '/admitted/main' }),
    ).resolves.toStrictEqual({ kind: 'pass' });
    await expect(render(engine, sessionId)).resolves.toMatchObject({
      result: { status: 'forbidden' },
    });
    expect(state.calls).toBe(2);
  });

  it.each(['route', 'params', 'session', 'anonymous', 'malformed', 'tampered', 'empty'] as const)(
    'rechecks an admission with changed %s',
    async (changed) => {
      const { engine, state } = opened();
      const alice = (await engine.login('alice')).sessionId;
      const bob = (await engine.login('bob')).sessionId;
      const admission = await admit(engine, alice);
      const changedRequest = changedContext(changed, { alice, bob }, admission);

      await expect(
        render(engine, changedRequest.session, changedRequest.admission, changedRequest),
      ).resolves.toMatchObject({ result: { status: 'forbidden' } });
      expect(state.calls).toBe(2);
    },
  );

  it('rechecks after a successful commit', async () => {
    const { engine, state } = opened();
    const { sessionId } = await engine.login('alice');
    const admission = await admit(engine, sessionId);
    await operate(engine, sessionId, 'setCount', ['main', 1]);

    await expect(render(engine, sessionId, admission)).resolves.toMatchObject({
      result: { status: 'forbidden' },
    });
    expect(state.calls).toBe(2);
  });

  it('invalidates admission after SQL commits even if its public follow-up fails', async () => {
    const filename = await databaseFile();
    const { close, engine, state } = opened({ clock: () => 0, filename });
    const { sessionId } = await engine.login('alice');
    const admission = await admit(engine, sessionId);
    const before = await engine.stats();
    const failed = vi.spyOn(PublicViews.prototype, 'committed').mockImplementationOnce(() => {
      throw new Error('postcommit public follow-up');
    });
    onTestFinished(() => {
      failed.mockRestore();
    });
    try {
      await expect(operate(engine, sessionId, 'setCount', ['main', 1])).rejects.toThrow(
        'postcommit public follow-up',
      );
    } finally {
      failed.mockRestore();
    }

    expect(admission).toBeTypeOf('string');
    expect({ commits: (await engine.stats()).commits, revision: engine.revision() }).toStrictEqual({
      commits: before.commits + 1,
      revision: before.revision + 1,
    });
    await expect(engine.publicSnapshot('counters', 'main')).resolves.toMatchObject({
      values: { count: 1 },
    });

    const shown = await render(engine, sessionId, admission);

    expect({ calls: state.calls, status: shown.result.status }).toStrictEqual({
      calls: 2,
      status: 'forbidden',
    });

    await close();
    const reopened = opened({ filename });

    expect(reopened.engine.revision()).toBe(before.revision + 1);
    await expect(reopened.engine.publicSnapshot('counters', 'main')).resolves.toMatchObject({
      values: { count: 1 },
    });
  });

  it('retains admission after the SQL transaction rolls its records back', async () => {
    const filename = await databaseFile();
    const { close, engine, state } = opened({ clock: () => 0, filename });
    const { sessionId } = await engine.login('alice');
    const admission = await admit(engine, sessionId);
    const before = await engine.stats();
    const failed = vi.spyOn(SharedViews.prototype, 'dirtyBy').mockImplementationOnce(() => {
      throw new Error('transaction dirty marking');
    });
    onTestFinished(() => {
      failed.mockRestore();
    });
    try {
      await expect(operate(engine, sessionId, 'setCount', ['main', 1])).rejects.toThrow(
        'transaction dirty marking',
      );
    } finally {
      failed.mockRestore();
    }

    expect(admission).toBeTypeOf('string');
    expect({ commits: (await engine.stats()).commits, revision: engine.revision() }).toStrictEqual({
      commits: before.commits,
      revision: before.revision,
    });
    await expect(engine.publicSnapshot('counters', 'main')).resolves.toMatchObject({
      values: { count: 0 },
    });

    const shown = await render(engine, sessionId, admission);

    expect({
      calls: state.calls,
      status: shown.result.status,
      text: textOf(shown.result.tree),
    }).toStrictEqual({
      calls: 1,
      status: 'rendered',
      text: '0',
    });

    const fresh = await engine.guardRoute(sessionId, {
      admit: true,
      route: ROUTE,
      url: '/admitted/main',
    });

    expect({ answer: fresh, calls: state.calls }).toStrictEqual({
      answer: { kind: 'refused' },
      calls: 2,
    });

    await close();
    const reopened = opened({ filename });
    const persisted = await reopened.engine.publicSnapshot('counters', 'main');

    expect({ revision: reopened.engine.revision(), values: persisted.values }).toStrictEqual({
      revision: before.revision,
      values: { count: 0 },
    });
  });

  it('rechecks an expired admission while its session remains valid', async () => {
    const clock = { now: Date.UTC(2026, 9, 19) };
    const { engine, state } = opened({ clock: () => clock.now });
    const { sessionId } = await engine.login('alice');
    const admission = await admit(engine, sessionId);
    clock.now += TIMES.hour;

    await expect(render(engine, sessionId, admission)).resolves.toMatchObject({
      result: { status: 'forbidden' },
    });
    expect(state.calls).toBe(2);
  });

  it.each([BUILD, 'b_after_restart'])(
    'rechecks after an authority restart under %s',
    async (build) => {
      const filename = await databaseFile();
      const first = opened({ filename });
      const { sessionId } = await first.engine.login('alice');
      const admission = await admit(first.engine, sessionId);
      await first.close();
      const { engine, state } = opened({
        build,
        filename,
        state: { allowed: false, calls: 0, once: true },
      });

      await expect(render(engine, sessionId, admission)).resolves.toMatchObject({
        result: { status: 'forbidden' },
      });
      expect(state.calls).toBe(1);
    },
  );

  it('rechecks a view refresh without carrying admission in the subscription', async () => {
    const { engine, state } = opened();
    const { sessionId } = await engine.login('alice');
    const initial = await render(engine, sessionId, await admit(engine, sessionId));

    expect(initial.result.status).toBe('rendered');
    await expect(
      engine.view(sessionId, { subscription: initial.result.frame.subscription, view: {} }),
    ).resolves.toMatchObject({ status: 'forbidden' });
    expect(state.calls).toBe(2);
  });

  it('rechecks an event subscription and rebuilds guard database dependencies', async () => {
    const { engine, state } = opened();
    const { sessionId } = await engine.login('alice');
    const initial = await render(engine, sessionId, await admit(engine, sessionId));

    expect(initial.result.status).toBe('rendered');

    state.allowed = true;
    state.once = false;
    const watched = await engine.watch(sessionId, initial.result.frame.subscription);

    expect(state.calls).toBe(2);

    const events: CommitEvent[] = [];
    onTestFinished(
      engine.onCommit((event) => {
        events.push(event);
      }),
    );
    await operate(engine, sessionId, 'setProjectTitle', ['new title']);
    await operate(engine, sessionId, 'setCount', ['other', 1]);

    expect(events).toHaveLength(2);
    expect(watched.dependsOn(events[0]!)).toBe(true);
    expect(watched.dependsOn(events[1]!)).toBe(false);
  });

  it('replays the guard for a field update without carrying admission in the binding', async () => {
    const { engine, state } = opened();
    const { sessionId } = await engine.login('alice');
    const initial = await render(engine, sessionId, await admit(engine, sessionId, EDIT_ROUTE), {
      route: EDIT_ROUTE,
    });

    expect(initial.result.status).toBe('rendered');

    const { binding } = clientOf(initial.result.tree, EDITABLE).part.states['count'] as {
      readonly binding: string;
    };

    await expect(
      engine.update(sessionId, {
        binding,
        operationId: 'admitted-write',
        captures: { by: 1 },
        updaterId: INCREMENT,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(state.calls).toBe(2);
  });
});
