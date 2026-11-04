import { describe, expect, it, onTestFinished } from 'vitest';

import { AuthorityEngine, createAuthorityServer } from '../src/authority/index.ts';
import { nodeSql } from '../src/authority/node-sql.ts';
import { signView } from '../src/authority/view-tokens.ts';
import { type ComponentProgram, INTERNAL_HEADER, PROTOCOL_VERSION } from '../src/program.ts';
import { GENERATION_HEADER, type RouteRegistration } from '../src/routing.ts';
import { db } from './support/app/db.ts';
import { readEvents } from './support/event-stream.ts';
import { application, BUILD } from './support/program.ts';
import { refusedSharedView, sharedReadyCases } from './support/shared-ready.ts';

const INTERNAL_TOKEN = 'ready-internal';
const ROUTE: RouteRegistration = {
  blocking: true,
  middleware: [],
  page: 'ready/[id]/page.tsx',
  params: ['id'],
  props: { id: 'id' },
  root: 'components/ready',
  route: '/ready/[id]',
  shared: true,
};
const MAIN = { build: BUILD, props: { id: 'main' }, route: ROUTE.route };
const ready: ComponentProgram = {
  buildId: BUILD,
  component: ROUTE.root,
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
  evaluate: async (_props, $) => $.h('p', null, String((await db.counters.get('main'))?.count)),
};

/** A real HTTP authority with a published counter generation and its signed current token. */
async function published() {
  const sql = nodeSql(':memory:');
  const engine = new AuthorityEngine({
    ...application,
    sql,
    programs: [...application.programs, ready],
    routes: [ROUTE],
    operations: {
      ...application.operations,
      'test/ready': {
        async increment() {
          await db.transaction(async () => {
            await db.counters.update('main', { count: 1 });
          });
        },
      },
    },
  });
  const authority = await createAuthorityServer({ engine, internalToken: INTERNAL_TOKEN });
  onTestFinished(authority.close);
  engine.site(async (_path, headers) => {
    const shown = await engine.renderShared(null, {
      ...MAIN,
      generation: headers[GENERATION_HEADER],
    });
    return Response.json(shown.result.tree, {
      headers: { 'content-type': headers['rsc'] === '1' ? 'text/x-component' : 'text/html' },
    });
  });
  const ask = () =>
    engine.gate({ headers: {}, method: 'GET', route: ROUTE.route, url: '/ready/main' });

  await expect(ask()).resolves.toMatchObject({ kind: 'respond', status: 200 });

  const shown = await engine.renderShared(null, MAIN);
  if (shown.kind !== 'shared') throw new Error('The ready counter is not shared.');
  const secret = sql.get("SELECT value FROM meta WHERE key = 'binding_secret'")?.['value'];
  if (typeof secret !== 'string') throw new TypeError('The authority has no signing secret.');
  const token = (fields: { readonly build?: string; readonly route?: string } = {}) => {
    return signView(secret, {
      build: fields.build ?? BUILD,
      epoch: shown.view.epoch,
      generation: shown.view.generation,
      params: { id: 'main' },
      route: fields.route ?? ROUTE.route,
    });
  };
  const events = (view: string) => {
    return fetch(`${authority.url}/api/shared/events?view=${encodeURIComponent(view)}`, {
      headers: { [INTERNAL_HEADER]: INTERNAL_TOKEN },
    });
  };
  return { ask, engine, events, shown, token };
}

// eslint-disable-next-line vitest/require-hook -- This call registers the shared protocol cases.
sharedReadyCases();

describe('current shared READY over the Node authority HTTP endpoint', () => {
  it('sends the authenticated current moment before any later generation event', async () => {
    const { ask, engine, events, shown } = await published();
    const reader = readEvents(await events(shown.view.token));
    onTestFinished(reader.cancel);
    const first = reader.next();
    const { sessionId } = await engine.login('alice');
    await engine.operate(sessionId, {
      args: [],
      build: BUILD,
      module: 'test/ready',
      name: 'increment',
      operationId: 'ready-increment',
    });
    await ask();

    await expect(first).resolves.toStrictEqual({
      data: { epoch: shown.view.epoch, generation: shown.view.generation },
      event: 'ready',
    });
  });

  it.each([
    { kind: 'malformed', status: 403 },
    { kind: 'forged', status: 403 },
    { kind: 'wrong build', status: 409 },
    { kind: 'unknown route', status: 404 },
  ])('never sends READY for a $kind token', async ({ kind, status }) => {
    const { engine, events, token } = await published();
    const view = await refusedSharedView(kind, token);
    const response = await events(view);

    expect(response.status).toBe(status);
    await expect(response.text()).resolves.not.toContain('event: ready');
    await expect(engine.stats()).resolves.toMatchObject({ sharedStreams: 0 });
  });
});
