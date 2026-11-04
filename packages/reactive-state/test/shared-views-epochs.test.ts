import { describe, expect, it, onTestFinished } from 'vitest';

import { Engine } from '../src/authority/index.ts';
import { type ComponentProgram, PROTOCOL_VERSION, type RenderScope } from '../src/program.ts';
import { GENERATION_HEADER, type RouteRegistration, type SharedEvent } from '../src/routing.ts';
import { boolean, currentUser, database, table, text } from '../src/server/index.ts';
import { nextPageParam } from './support/next-page.ts';
import { follow, headerOf, open, quiet, viewTokenOf } from './support/shared-fixture.ts';

/**
 * A shared view's access epochs, of the database's own counter: a view let go of and taken in
 * again starts past every epoch its earlier self reached, so a browser's `ETag` of that one is no
 * `304` of the new one; a revocation is told its streams once, however often the view
 * is evaluated again refused; and a view whose code now reads the request is revoked as a refused
 * one is, for its pages to ask for the route again.
 */

const DAY_MS = 86_400_000;
const NOTE_ROUTE = '/notes/[id]';
const NOTE_BUILD = 'b_epochs';

describe('a shared view’s epochs', () => {
  it('starts a view let go of and taken in again past every epoch its earlier self reached', async () => {
    let now = Date.UTC(2026, 9, 16);
    const { ask, engine } = await open({ clock: () => now });
    const first = headerOf(await ask('/boards/p1'), 'etag') ?? '';
    await quiet(engine);
    // Two days with nobody asking: the board is let go of as another view is asked for.
    now += 2 * DAY_MS;
    await ask('/boards/p2');
    const again = await ask('/boards/p1', { 'if-none-match': first });

    expect(again).toMatchObject({ kind: 'respond', status: 200 });
    expect(headerOf(again, 'etag')).not.toBe(first);
  });

  it('tells a view’s streams of its denial once, however often it is evaluated again refused', async () => {
    const { ask, engine, operate } = await open();
    await ask('/boards/p1');
    const heard = await follow(engine, await viewTokenOf(engine, 'p1'));
    await operate('setPublished', 'p1', false);
    await ask('/boards/p1');
    await operate('setNote', 'p1', 'still refused');
    await ask('/boards/p1');
    await quiet(engine);

    expect(heard.filter((event) => event.kind === 'denied')).toHaveLength(1);
  });

  it('revokes a published view whose code now reads the request, as a refused one', async () => {
    const db = database(
      { notes: table({ body: text({ maxLength: 200 }), secret: boolean() }) },
      { seed: { notes: { n1: { body: 'hello', secret: false } } } },
    );
    const note: ComponentProgram = {
      buildId: NOTE_BUILD,
      component: 'components/note',
      evaluate: async (props: Readonly<Record<string, unknown>>, $: RenderScope) => {
        const found = await db.notes.get(String(props['id']));
        if (found?.secret === true) {
          await currentUser();
        }
        return $.h('p', null, found?.body ?? 'none');
      },
      protocolVersion: PROTOCOL_VERSION,
      updaters: {},
      writable: [],
    };
    const route: RouteRegistration = {
      blocking: true,
      middleware: [],
      page: 'notes/[id]/page.tsx',
      params: ['id'],
      props: { id: 'id' },
      root: 'components/note',
      route: NOTE_ROUTE,
      shared: true,
    };
    const engine = new Engine({
      buildId: NOTE_BUILD,
      database: db,
      operations: {
        'actions/notes': {
          async hide(id: unknown): Promise<void> {
            await db.transaction(async () => {
              await db.notes.update(String(id), { secret: true });
            });
          },
        },
      },
      programs: [note],
      routes: [route],
    });
    onTestFinished(async () => {
      await engine.close();
    });
    engine.site(async (path, headers) => {
      const answer = await engine.renderShared(null, {
        build: NOTE_BUILD,
        ...(headers[GENERATION_HEADER] !== undefined && { generation: headers[GENERATION_HEADER] }),
        props: { id: nextPageParam(path.split('/').at(-1) ?? '') },
        route: NOTE_ROUTE,
      });
      return Response.json(answer.result.tree, {
        headers: { 'content-type': headers['rsc'] === '1' ? 'text/x-component' : 'text/html' },
      });
    });
    const ask = async (): Promise<unknown> =>
      engine.gate({ headers: {}, method: 'GET', route: NOTE_ROUTE, url: '/notes/n1' });

    await expect(ask()).resolves.toMatchObject({ status: 200 });

    const shown = await engine.renderShared(null, {
      build: NOTE_BUILD,
      props: { id: 'n1' },
      route: NOTE_ROUTE,
    });
    const heard: SharedEvent[] = [];
    const followed = await engine.followShared(shown.kind === 'shared' ? shown.view.token : '');
    onTestFinished(
      followed.listen((event) => {
        heard.push(event);
      }),
    );
    const { sessionId } = await engine.login('alice');
    await engine.operate(sessionId, {
      args: [{ json: 'n1' }],
      build: NOTE_BUILD,
      module: 'actions/notes',
      name: 'hide',
      operationId: 'hide-n1',
    });

    await expect(ask()).resolves.toStrictEqual({ kind: 'pass' });
    expect(shown.kind).toBe('shared');
    expect(heard.map((event) => event.kind)).toStrictEqual(['denied']);
  });
});
