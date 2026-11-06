import { describe, expect, it, onTestFinished } from 'vitest';

import { Engine } from '../src/authority/index.ts';
import {
  type ComponentProgram,
  componentRef,
  PROTOCOL_VERSION,
  type RenderScope,
} from '../src/program.ts';
import { type GateAnswer, GENERATION_HEADER, type RouteRegistration } from '../src/routing.ts';
import { database, table, text } from '../src/server/index.ts';
import { nextPageParam } from './support/next-page.ts';
import { bodyOf } from './support/shared-fixture.ts';

/**
 * A shared render's memo: a component whose rendering read what only the request answers — the
 * clock, as a library reads it for the application — binds every render that takes it from the memo
 * to the request, as it bound the render that evaluated it, its parents' renderings with it: none is
 * ever published as every visitor's. What a component rendered after the read, which read nothing of
 * the request, is every visitor's still. Against an application of its own: a board whose root
 * renders a stamp of the clock and then the note's body, and pages of each of them.
 */

const BUILD = 'b_memo';

const db = database(
  { notes: table({ body: text({ maxLength: 200 }) }) },
  { seed: { notes: { n1: { body: 'hello' } } } },
);

/** A component as a test writes one: of `build`, with no state and no write. */
function program(
  component: string,
  evaluate: (props: Readonly<Record<string, unknown>>, $: RenderScope) => unknown,
): ComponentProgram {
  return {
    buildId: BUILD,
    component,
    evaluate,
    protocolVersion: PROTOCOL_VERSION,
    updaters: {},
    writable: [],
  };
}

/** The time it is rendered at, read as a library reads it: nothing the compile sees. */
const stamp = program('components/stamp', (_props, $) => $.h('time', null, String(Date.now())));

/** The note's body, which reads nothing but the note. */
const body = program('components/body', async (props, $) => {
  const found = await db.notes.get(String(props['id']));
  return $.h('p', null, found?.body ?? 'none');
});

/** A board of the note: the stamp, then the body, rendered after the clock was read. */
const board = program('components/board', (props, $) => {
  return $.h(
    'main',
    null,
    $.h(componentRef(stamp.component), {}),
    $.h(componentRef(body.component), { id: props['id'] }),
  );
});

/** Another root, of the stamp alone. */
const clock = program('components/clock', (_props, $) =>
  $.h('aside', null, $.h(componentRef(stamp.component), {})),
);

/** A root of the board: a root is one route's, and another renders the board inside its own. */
const wall = program('components/wall', (props, $) =>
  $.h('section', null, $.h(componentRef(board.component), { id: props['id'] })),
);

/** The name of the route a page's path `/<name>/<id>` is of, and its param. */
function pageOf(path: string): { readonly name: string; readonly id: string } {
  const { id = '', name = '' } = /^\/(?<name>[^/]+)\/(?<id>[^/]+)$/u.exec(path)?.groups ?? {};
  return { id, name };
}

/** A route of `root`, every visitor's, at `/<name>/[id]`. */
function route(name: string, root: ComponentProgram): RouteRegistration {
  return {
    blocking: true,
    middleware: [],
    page: `${name}/[id]/page.tsx`,
    params: ['id'],
    props: { id: 'id' },
    root: root.component,
    route: `/${name}/[id]`,
    shared: true,
  };
}

/** The engine, its site rendering each route's page, and the gate's answer to a path. */
function app(): { readonly engine: Engine; readonly ask: (path: string) => Promise<GateAnswer> } {
  const engine = new Engine({
    buildId: BUILD,
    database: db,
    programs: [stamp, body, board, clock, wall],
    // The board, the clock, the board inside a wall, and the body alone.
    routes: [route('a', board), route('b', clock), route('c', wall), route('d', body)],
  });
  onTestFinished(async () => {
    await engine.close();
  });
  engine.site(async (path, headers) => {
    const { id, name } = pageOf(path);
    const answer = await engine.renderShared(null, {
      build: BUILD,
      generation: headers[GENERATION_HEADER],
      props: { id: nextPageParam(id) },
      route: `/${name}/[id]`,
    });
    return Response.json(answer.result.tree, {
      headers: { 'content-type': headers['rsc'] === '1' ? 'text/x-component' : 'text/html' },
    });
  });
  const ask = async (path: string): Promise<GateAnswer> => {
    const { name } = pageOf(path);
    return engine.gate({ headers: {}, method: 'GET', route: `/${name}/[id]`, url: path });
  };
  return { ask, engine };
}

describe('a shared render’s memo', () => {
  it('binds a render that takes a rendering of the request’s from the memo to the request, as evaluating it would', async () => {
    const { ask, engine } = app();

    // The board reads the clock: the request's, its stamp and itself kept in the memo meanwhile.
    await expect(ask('/a/n1')).resolves.toStrictEqual({ kind: 'pass' });

    const before = await engine.stats();

    // Another root renders the same stamp, and another the same board: each taken from the memo,
    // never evaluated again, and each the request's all the same.
    await expect(ask('/b/n1')).resolves.toStrictEqual({ kind: 'pass' });
    await expect(ask('/c/n1')).resolves.toStrictEqual({ kind: 'pass' });

    const after = await engine.stats();

    expect(after.memoHits - before.memoHits).toBe(2);
    expect(after.evaluationsByComponent[stamp.component]).toBe(1);
    expect(after.evaluationsByComponent[board.component]).toBe(1);
    expect(after.generations).toBe(0);

    // Its page's render, for anybody: the session's, never one view for all.
    const shown = await engine.renderShared(null, {
      build: BUILD,
      props: { id: 'n1' },
      route: '/c/[id]',
    });

    expect(shown.kind).toBe('session');
  });

  it('keeps what a component rendered after the read, which read nothing of the request, as every visitor’s', async () => {
    const { ask, engine } = app();

    await expect(ask('/a/n1')).resolves.toStrictEqual({ kind: 'pass' });

    // The body, rendered by the board after its stamp read the clock: taken from the memo, shared.
    const answer = await ask('/d/n1');

    expect(answer).toMatchObject({ kind: 'respond', status: 200 });
    expect(bodyOf(answer)).toContain('hello');
    expect((await engine.stats()).evaluationsByComponent[body.component]).toBe(1);
  });
});
