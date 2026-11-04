import { describe, expect, it, onTestFinished } from 'vitest';

import { type Application, Engine, startAuthority } from '../src/authority/index.ts';
import { httpClient } from '../src/client/index.ts';
import {
  type ComponentProgram,
  type Json,
  PROTOCOL_VERSION,
  type RenderResult,
  type RenderScope,
} from '../src/program.ts';
import type {
  GateAnswer,
  MiddlewareProgram,
  RouteParams,
  RouteRegistration,
  SharedRenderAnswer,
} from '../src/routing.ts';
import { currentUser, forbidden, requireUser } from '../src/server/index.ts';
import { db } from './support/app/db.ts';
import { clientOf, textOf } from './support/frames.ts';
import { nextPageParam } from './support/next-page.ts';
import { application, BUILD, SET_TITLE } from './support/program.ts';

/**
 * Route middleware guards as the authority runs them: a shared view's guard read with its root, a
 * guard that refuses before the root is evaluated, a guard of the session's identity that makes the
 * route the request's, and a write's replay, which runs the guards of the route its root is of in the
 * queue it commits in — whoever asks, and however the request reached the authority; a root another
 * page renders of props of its own, its guards run of the params they give, and refused where they
 * give none, never rendered past a guard; and a route's guards asked of for one request
 * (`guardRoute`), as the delivery route asks before the page.
 */

const COUNTER_ROUTE = '/counters/[id]';
const EDIT_ROUTE = '/edit/[projectId]/[id]';
const SIGNED_ROUTE = '/signed/[id]';
const MINE_ROUTE = '/mine/[id]';
/** A page of no reactive root under the owner's guard: a project's settings, say. */
const SETTINGS_ROUTE = '/edit/[projectId]/settings';
/** A counter whose root refuses itself where its count is below zero, under no guard. */
const REFUSING_ROUTE = '/refusing/[id]';
/** A counter its guard answers a redirect for where it moved, every visitor alike. */
const MOVED_ROUTE = '/moved/[id]';
/** A counter shown with the props its page gave the root, under the counters' guard. */
const GUARDED_PROPS_ROUTE = '/guarded-props/[id]';
/** A counter shown with the props its page gave the root, under no guard. */
const OPEN_PROPS_ROUTE = '/open-props/[id]';
/**
 * A counter whose page gives the root its one param as two props, under the counters' guard:
 * `<PairView first={id} second={id} />`.
 */
const PAIR_ROUTE = '/pair/[id]';
/** What the guard of `MINE_ROUTE` answers a request of no session with. */
const SIGN_IN = '<a href="/sign-in">Sign in</a>';

/** The counter's count, shown to everyone: a guard says whether it may be. */
const counterView: ComponentProgram = {
  buildId: BUILD,
  component: 'components/counter-view',
  evaluate: async (props: Readonly<Record<string, unknown>>, $: RenderScope) => {
    const counter = await db.counters.get(String(props['id']));
    return $.h('p', null, String(counter?.count ?? 'none'));
  },
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

/** The counter's count where it moved from: a root of its own, as a root is one route's. */
const movedView: ComponentProgram = { ...counterView, component: 'components/moved-view' };

/**
 * The counter's count, and the props a page rendered the root with as JSON — what that page asked
 * for, shown — as the root `component`.
 */
function propsView(component: string): ComponentProgram {
  return {
    ...counterView,
    component,
    evaluate: async (props: Readonly<Record<string, unknown>>, $: RenderScope) => {
      const counter = await db.counters.get(String(props['id']));
      return $.h('p', null, `${String(counter?.count ?? 'none')} ${JSON.stringify(props)}`);
    },
  };
}

/** `propsView` of the route under the counters' guard, and of the one under none. */
const guardedPropsView = propsView('components/guarded-props-view');
const openPropsView = propsView('components/open-props-view');

/** The count of the counter the prop `first` names, of the root given its param twice. */
const pairView: ComponentProgram = {
  ...counterView,
  component: 'components/pair-view',
  evaluate: async (props: Readonly<Record<string, unknown>>, $: RenderScope) => {
    const counter = await db.counters.get(String(props['first']));
    return $.h('p', null, String(counter?.count ?? 'none'));
  },
};

function guard(id: string, body: (params: RouteParams) => Promise<unknown>): MiddlewareProgram {
  return {
    buildId: BUILD,
    guard: async ({ params }) => body(params),
    id,
    protocolVersion: PROTOCOL_VERSION,
  };
}

/** A counter is shown while its count is not below zero. */
const counters = guard('counters/[id]', async (params) => {
  const counter = await db.counters.get(params['id'] ?? '');
  if (counter === null || counter.count < 0) {
    forbidden();
  }
});

/** A project's to-dos are edited by its owner alone, on this route. */
const edit = guard('edit', async (params) => {
  const user = await requireUser();
  const project = await db.projects.get(params['projectId'] ?? '');
  if (project?.ownerId !== user.id) {
    forbidden();
  }
});

/** Anyone signed in. */
const signed = guard('signed', async () => {
  await requireUser();
});

/**
 * Anyone signed in goes on; anyone else is sent to sign in, by the response the guard answers itself
 * — `return new Response(SIGN_IN, { status: 307, headers: { location: '/sign-in' } })`, as the
 * compile writes it.
 */
const mine = guard('mine', async () => {
  const user = await currentUser();
  return user === null
    ? { body: SIGN_IN, headers: [['location', '/sign-in']], status: 307 }
    : undefined;
});

/** The page of the signed-in user's own: the counter's count, under `mine`. */
const mineView: ComponentProgram = { ...counterView, component: 'components/mine-view' };

/** The counter's count, which its root refuses itself where it is below zero. */
const refusingView: ComponentProgram = {
  ...counterView,
  component: 'components/refusing-view',
  evaluate: async (props: Readonly<Record<string, unknown>>, $: RenderScope) => {
    const counter = await db.counters.get(String(props['id']));
    if (counter === null || counter.count < 0) {
      forbidden();
    }
    return $.h('p', null, String(counter.count));
  },
};

/** The counter `old` moved to `main`: its guard answers the redirect itself. */
const moved = guard('moved', async (params) => {
  await Promise.resolve();
  return params['id'] === 'old'
    ? { body: '', headers: [['location', '/moved/main']], status: 308 }
    : undefined;
});

/**
 * A route of `root` under `middleware`, as a compile registers it: guarded where it is under any —
 * each middleware here has a guard, but the application's own (`''`), which none of them is under
 * alone.
 */
function route(
  name: string,
  root: string,
  props: Readonly<Record<string, string>>,
  middleware: readonly string[],
): RouteRegistration {
  return {
    blocking: true,
    ...(middleware.length > 0 && { guarded: true }),
    middleware,
    page: `${name.slice(1)}/page.tsx`,
    // Its path's params, in the order the path names them, as a compile registers them.
    params: name
      .split('/')
      .flatMap((segment) => /^\[(?<param>\w+)\]$/u.exec(segment)?.groups?.['param'] ?? []),
    props,
    root,
    route: name,
    shared: true,
  };
}

const operations = {
  ...application.operations,
  'actions/test': {
    async setCount(id: unknown, count: unknown): Promise<void> {
      await db.transaction(async () => {
        await db.counters.update(String(id), { count: Number(count) });
      });
    },
    async transfer(projectId: unknown, ownerId: unknown): Promise<void> {
      await db.transaction(async () => {
        await db.projects.update(String(projectId), { ownerId: String(ownerId) });
      });
    },
  },
};

/** The application with its routes and their middleware's guards, as a compile registers them. */
const GUARDED: Application = {
  ...application,
  middleware: { '': null, 'counters/[id]': counters, edit, mine, moved, signed },
  operations,
  programs: [
    ...application.programs,
    counterView,
    mineView,
    movedView,
    refusingView,
    guardedPropsView,
    openPropsView,
    pairView,
  ],
  routes: [
    route(COUNTER_ROUTE, 'components/counter-view', { id: 'id' }, ['', 'counters/[id]']),
    route(REFUSING_ROUTE, 'components/refusing-view', { id: 'id' }, []),
    route(MOVED_ROUTE, movedView.component, { id: 'id' }, ['moved']),
    route(GUARDED_PROPS_ROUTE, guardedPropsView.component, { id: 'id' }, ['counters/[id]']),
    route(OPEN_PROPS_ROUTE, openPropsView.component, { id: 'id' }, []),
    route(PAIR_ROUTE, pairView.component, { first: 'id', second: 'id' }, ['counters/[id]']),
    route(EDIT_ROUTE, 'components/todo-editor', { id: 'id', projectId: 'projectId' }, ['edit']),
    route(SIGNED_ROUTE, 'components/counter', { id: 'id' }, ['signed']),
    {
      ...route(MINE_ROUTE, 'components/mine-view', { id: 'id' }, ['mine']),
      private: 'a guard reads the session’s identity',
      shared: false,
    },
    {
      file: 'edit/[projectId]/settings/page.tsx',
      guarded: true,
      middleware: ['edit'],
      params: ['projectId'],
      plain: 'page',
      route: SETTINGS_ROUTE,
    },
  ],
};

async function open(): Promise<{
  readonly engine: Engine;
  readonly sessions: Readonly<Record<'alice' | 'bob' | 'carol', string>>;
  readonly operate: (session: string, name: string, ...args: readonly unknown[]) => Promise<void>;
}> {
  const engine = new Engine(GUARDED);
  onTestFinished(async () => {
    await engine.close();
  });
  engine.site(async (path, headers) => {
    const id = nextPageParam(path.split('/').at(-1) ?? '');
    const answer = await engine.renderShared(null, {
      build: BUILD,
      generation: headers['x-reactive-generation'],
      props: { id },
      route: COUNTER_ROUTE,
    });
    return Response.json(answer.result.tree, {
      headers: { 'content-type': headers['rsc'] === '1' ? 'text/x-component' : 'text/html' },
    });
  });
  const sessions = {
    alice: (await engine.login('alice')).sessionId,
    bob: (await engine.login('bob')).sessionId,
    carol: (await engine.login('carol')).sessionId,
  };
  let made = 0;
  return {
    engine,
    operate: async (session, name, ...args) => {
      made += 1;
      await engine.operate(session, {
        args: args.map((json) => ({ json: json as never })),
        build: BUILD,
        module: 'actions/test',
        name,
        operationId: `guard-op-${String(made)}`,
      });
    },
    sessions,
  };
}

async function editorOf(engine: Engine, session: string): Promise<RenderResult> {
  return engine.render(session, {
    build: BUILD,
    component: 'components/todo-editor',
    props: { id: 't1', projectId: 'p1' },
  });
}

describe('route middleware guards in the authority', () => {
  it('shares a view its guard lets through, and refuses one it refuses before the root', async () => {
    const { engine, operate, sessions } = await open();
    const ask = async (id: string): Promise<unknown> =>
      engine.gate({ headers: {}, method: 'GET', route: COUNTER_ROUTE, url: `/counters/${id}` });

    await expect(ask('main')).resolves.toMatchObject({ status: 200 });

    await operate(sessions.alice, 'setCount', 'main', -1);

    await expect(ask('main')).resolves.toMatchObject({ status: 403 });

    const before = (await engine.stats()).evaluationsByComponent['components/counter-view'];

    await expect(ask('missing')).resolves.toMatchObject({ status: 403 });
    expect((await engine.stats()).evaluationsByComponent['components/counter-view']).toBe(before);
  });

  it('says at the gate which guard decided a view — its refusal, or its own response — and nothing where the view’s root refused it', async () => {
    const { engine, operate, sessions } = await open();
    const ask = async (name: string, url: string): Promise<GateAnswer> =>
      engine.gate({ headers: {}, method: 'GET', route: name, url });

    await operate(sessions.alice, 'setCount', 'main', -1);
    const guardRefused = await ask(COUNTER_ROUTE, '/counters/main');
    const rootRefused = await ask(REFUSING_ROUTE, '/refusing/main');
    const answered = await ask(MOVED_ROUTE, '/moved/old');

    expect(guardRefused).toMatchObject({ by: 'counters/[id]', refused: true, status: 403 });
    expect(rootRefused).toMatchObject({ status: 403 });
    expect(rootRefused).not.toHaveProperty('by');
    expect(answered).toMatchObject({ by: 'moved', status: 308 });
    expect(answered).not.toHaveProperty('refused');
  });

  it('runs a route’s guards for every render of its root, a direct one included', async () => {
    const { engine, sessions } = await open();

    expect((await editorOf(engine, sessions.alice)).status).toBe('rendered');
    // Bob may edit p1 by its membership, but the route's guard is the owner's alone.
    expect((await editorOf(engine, sessions.bob)).status).toBe('forbidden');
  });

  it('refuses a write whose route the session no longer passes, in the queue it would commit in', async () => {
    const { engine, operate, sessions } = await open();
    // Bob owns p1 for a while: the route's guard lets him through, and so does the editor itself,
    // which lets any member who may edit through.
    await operate(sessions.alice, 'transfer', 'p1', 'bob');
    const rendered = await editorOf(engine, sessions.bob);
    const { binding } = clientOf(rendered.tree, 'components/todo-editor').part.states['title'] as {
      readonly binding: string;
    };
    await operate(sessions.alice, 'transfer', 'p1', 'alice');

    // The editor still lets Bob, a member who may edit, write; the route's guard no longer does.
    await expect(
      engine.update(sessions.bob, {
        binding,
        operationId: 'title-after-transfer',
        updaterId: SET_TITLE,
        value: 'no longer his',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('holds a guard and a component’s own check together: both must let the session through', async () => {
    const { engine, sessions } = await open();
    const counter = (session: string | null): Promise<RenderResult> => {
      return engine.render(session, {
        build: BUILD,
        component: 'components/counter',
        props: { id: 'main' },
      });
    };

    await expect(counter(null)).resolves.toMatchObject({ status: 'unauthenticated' });
    await expect(counter(sessions.carol)).resolves.toMatchObject({ status: 'rendered' });
  });

  it('makes a route whose guard reads the session the request’s, never one view for all', async () => {
    const { engine } = await open();

    await expect(
      engine.gate({ headers: {}, method: 'GET', route: SIGNED_ROUTE, url: '/signed/main' }),
    ).resolves.toStrictEqual({ kind: 'pass' });
  });

  it('shares nothing where sharing is off: every route renders for each request', async () => {
    const engine = new Engine({
      ...application,
      middleware: { 'counters/[id]': counters },
      programs: [...application.programs, counterView],
      routes: [route(COUNTER_ROUTE, 'components/counter-view', { id: 'id' }, ['counters/[id]'])],
      shareViews: false,
    });
    onTestFinished(async () => {
      await engine.close();
    });

    await expect(
      engine.gate({ headers: {}, method: 'GET', route: COUNTER_ROUTE, url: '/counters/main' }),
    ).resolves.toStrictEqual({ kind: 'pass' });

    const rendered = await engine.renderShared(null, {
      build: BUILD,
      props: { id: 'main' },
      route: COUNTER_ROUTE,
    });

    expect(rendered.kind).toBe('session');
    expect((await engine.stats()).sharedEvaluations).toBe(0);
  });
});

describe('a route’s root rendered of props that are not its view’s', () => {
  it('answers a shared route’s root rendered with props besides its params — another page’s — with the session’s render of what that page asked for, in the one call, its guard run of the params: never the view of its params alone', async () => {
    const { engine, operate, sessions } = await open();
    const render = async (
      name: string,
      props: Readonly<Record<string, Json>>,
    ): Promise<SharedRenderAnswer> =>
      engine.renderShared(sessions.alice, { build: BUILD, props, route: name });

    await expect(render(COUNTER_ROUTE, { id: 'main' })).resolves.toMatchObject({ kind: 'shared' });
    await expect(render(COUNTER_ROUTE, { id: 'main', label: 'wide' })).resolves.toMatchObject({
      kind: 'session',
      result: { status: 'rendered' },
    });

    for (const label of ['wide', 2, ['a', 'b'], { x: null }]) {
      const answer = await render(GUARDED_PROPS_ROUTE, { id: 'main', label });

      expect(answer.kind).toBe('session');
      expect(textOf(answer.result.tree)).toBe(`0 ${JSON.stringify({ id: 'main', label })}`);
    }

    // The counter page's own view alone: none was taken in of another page's props.
    await expect(engine.stats()).resolves.toMatchObject({ sharedViews: 1 });

    await operate(sessions.alice, 'setCount', 'main', -1);

    // Its guard is run of the params the props give it, and refuses the counter below zero.
    await expect(render(GUARDED_PROPS_ROUTE, { id: 'main', label: 'wide' })).resolves.toMatchObject(
      { kind: 'session', result: { status: 'forbidden', tree: null } },
    );
  });

  it('refuses a root of props that give its guarded route no params — a param’s prop of no text, or none — as its guard refuses one, never rendering it, for a session or none; and renders one of a route with no guard', async () => {
    const { engine, sessions } = await open();
    const render = async (
      session: string | null,
      name: string,
      props: Readonly<Record<string, Json>>,
    ): Promise<SharedRenderAnswer> =>
      engine.renderShared(session, { build: BUILD, props, route: name });

    for (const session of [sessions.alice, null]) {
      for (const props of [{ id: ['main'] }, { id: 7 }, { label: 'main' }, {}]) {
        await expect(render(session, GUARDED_PROPS_ROUTE, props)).resolves.toMatchObject({
          kind: 'session',
          result: { status: 'forbidden', tree: null },
        });
      }

      // Two props of one param that differ give it none: no page of the route's gives them so.
      await expect(
        render(session, PAIR_ROUTE, { first: 'main', second: 'other' }),
      ).resolves.toMatchObject({ kind: 'session', result: { status: 'forbidden', tree: null } });
      // A route of the request's under a guard alike: its guard, too, is never asked of none.
      await expect(render(session, MINE_ROUTE, { id: ['main'] })).resolves.toMatchObject({
        kind: 'session',
        result: { status: 'forbidden', tree: null },
      });

      const unguarded = await render(session, OPEN_PROPS_ROUTE, { id: ['main'] });

      expect(unguarded.kind).toBe('session');
      expect(textOf(unguarded.result.tree)).toBe('0 {"id":["main"]}');
    }

    const { evaluationsByComponent } = await engine.stats();

    expect(evaluationsByComponent[guardedPropsView.component]).toBeUndefined();
    expect(evaluationsByComponent[pairView.component]).toBeUndefined();
    expect(evaluationsByComponent[mineView.component]).toBeUndefined();
  });

  it('refuses a root a page renders directly of props that give its guarded route no params, never rendering it past its guard; and renders one of a route with no guard', async () => {
    const { engine, operate, sessions } = await open();
    const render = async (
      component: string,
      props: Readonly<Record<string, Json>>,
    ): Promise<RenderResult> => engine.render(sessions.alice, { build: BUILD, component, props });
    // A counter below zero, which the counters' guard refuses.
    await operate(sessions.alice, 'setCount', 'main', -1);

    // Refused of its id as a page spells it, however else a page spells it, or leaves it out.
    for (const props of [{ id: 'main' }, { id: ['main'] }, { id: 7 }, {}]) {
      await expect(render(counterView.component, props)).resolves.toMatchObject({
        status: 'forbidden',
        tree: null,
      });
    }

    // Two props of one param that differ give it none: its guard would be asked of `other` alone,
    // while the root reads `main`.
    await expect(
      render(pairView.component, { first: 'main', second: 'other' }),
    ).resolves.toMatchObject({ status: 'forbidden', tree: null });
    expect(
      textOf((await render(pairView.component, { first: 'other', second: 'other' })).tree),
    ).toBe('100');
    expect(textOf((await render(openPropsView.component, { id: ['main'] })).tree)).toBe(
      '-1 {"id":["main"]}',
    );
  });
});

describe('a route’s guards asked of for one request (`guardRoute`)', () => {
  it('answers pass, refused, or the response a guard answered itself, for the session that asks', async () => {
    const { engine, sessions } = await open();
    const ask = async (session: string | null, name: string, url: string): Promise<unknown> =>
      engine.guardRoute(session, { route: name, url });

    await expect(ask(sessions.alice, EDIT_ROUTE, '/edit/p1/t1')).resolves.toStrictEqual({
      kind: 'pass',
    });
    // Bob may edit p1 by its membership, but the route's guard is the owner's alone.
    await expect(ask(sessions.bob, EDIT_ROUTE, '/edit/p1/t1?tab=one')).resolves.toStrictEqual({
      kind: 'refused',
    });
    // Said with the middleware whose guard answered it: the after parts around it are of those outside.
    await expect(ask(null, MINE_ROUTE, '/mine/main')).resolves.toStrictEqual({
      body: btoa(SIGN_IN),
      by: 'mine',
      headers: [
        ['cache-control', 'private, no-store'],
        ['location', '/sign-in'],
      ],
      kind: 'respond',
      status: 307,
    });
    await expect(ask(sessions.carol, MINE_ROUTE, '/mine/main')).resolves.toStrictEqual({
      kind: 'pass',
    });
  });

  it('runs the guards of a route of no reactive root, of the params its URL gives, which no gate answers', async () => {
    const { engine, sessions } = await open();
    const ask = async (session: string, url: string): Promise<unknown> =>
      engine.guardRoute(session, { route: SETTINGS_ROUTE, url });

    await expect(ask(sessions.alice, '/edit/p1/settings')).resolves.toStrictEqual({ kind: 'pass' });
    await expect(ask(sessions.bob, '/edit/p1/settings')).resolves.toStrictEqual({
      kind: 'refused',
    });
    await expect(ask(sessions.bob, '/edit/p1/other')).rejects.toMatchObject({
      code: 'INVALID_ROUTE',
      status: 400,
    });
    await expect(
      engine.gate({ headers: {}, method: 'GET', route: SETTINGS_ROUTE, url: '/edit/p1/settings' }),
    ).resolves.toStrictEqual({ kind: 'pass' });
  });

  it('reads the route’s params of its URL, and nothing else a request names', async () => {
    const { engine, sessions } = await open();

    // Bob owns p3, which the request names besides its URL: the URL's p1 is what the guard reads.
    await expect(
      engine.guardRoute(sessions.bob, {
        params: { id: 't1', projectId: 'p3' },
        route: EDIT_ROUTE,
        url: '/edit/p1/t1',
      }),
    ).resolves.toStrictEqual({ kind: 'refused' });
    await expect(
      engine.guardRoute(sessions.bob, { route: EDIT_ROUTE, url: '/edit/p3/t1' }),
    ).resolves.toStrictEqual({ kind: 'pass' });
  });

  it('runs a shared route’s guards as any route’s, and refuses a route it does not know, a URL not of it, or no question', async () => {
    const { engine, operate, sessions } = await open();
    const counter = async (): Promise<unknown> =>
      engine.guardRoute(null, { route: COUNTER_ROUTE, url: '/counters/main' });

    await expect(counter()).resolves.toStrictEqual({ kind: 'pass' });

    await operate(sessions.alice, 'setCount', 'main', -1);

    await expect(counter()).resolves.toStrictEqual({ kind: 'refused' });
    await expect(
      engine.guardRoute(null, { route: '/nowhere/[id]', url: '/nowhere/x' }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_ROUTE', status: 404 });
    await expect(
      engine.guardRoute(null, { route: COUNTER_ROUTE, url: '/elsewhere/main' }),
    ).rejects.toMatchObject({ code: 'INVALID_ROUTE', status: 400 });
    await expect(engine.guardRoute(null, { route: COUNTER_ROUTE })).rejects.toMatchObject({
      code: 'INVALID_GUARD',
      status: 400,
    });
  });

  it('refuses the call where a guard refuses the session itself (401), as a render does', async () => {
    const { engine } = await open();

    await expect(
      engine.guardRoute(null, { route: SIGNED_ROUTE, url: '/signed/main' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  });

  it('answers the same over the Node authority’s HTTP, for the session its cookie names', async () => {
    const authority = await startAuthority(GUARDED);
    onTestFinished(async () => {
      await authority.close();
    });
    const client = httpClient({ token: authority.token, url: authority.url });
    const signedIn = await client.login('carol');
    const carol = signedIn.ok ? signedIn.value.sessionId : null;

    await expect(
      client.guardRoute(carol, { route: MINE_ROUTE, url: '/mine/main' }),
    ).resolves.toStrictEqual({ ok: true, value: { kind: 'pass' } });
    await expect(
      client.guardRoute(null, { route: MINE_ROUTE, url: '/mine/main' }),
    ).resolves.toMatchObject({
      ok: true,
      value: { body: btoa(SIGN_IN), kind: 'respond', status: 307 },
    });
    await expect(
      client.guardRoute(null, { route: '/nowhere', url: '/nowhere' }),
    ).resolves.toMatchObject({ code: 'UNKNOWN_ROUTE', ok: false, status: 404 });
  });
});
