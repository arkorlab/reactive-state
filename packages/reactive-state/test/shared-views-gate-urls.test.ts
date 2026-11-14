import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, onTestFinished } from 'vitest';

import { handleShared } from '../src/authority/http-shared.ts';
import { Engine } from '../src/authority/node-engine.ts';
import { type ComponentProgram, PROTOCOL_VERSION, type RenderScope } from '../src/program.ts';
import {
  GATE_ANSWER_HEADER,
  GATE_PASS,
  GATE_ROUTE_HEADER,
  type GateAnswer,
  GENERATION_HEADER,
  type RouteRegistration,
} from '../src/routing.ts';
import { database, table, text } from '../src/server/index.ts';

/**
 * The URL a gate's question names — the path and the query a visitor asked for — read as a server
 * reads a request's target (RFC 9112 §3.3): the path of the authority's own origin, whatever it
 * begins with. A path that begins `//`, or `/\`, which a URL read against a base takes for a host of
 * its own, is the path it is: of no route, as no route has an empty segment, and so passed to the
 * site — which redirects it, as Next.js does every path that repeats a slash (308) — never answered
 * with the page of whatever path follows the host it was taken for.
 */

const BUILD = 'b_gate_urls';
const BOARD = '/boards/[projectId]';
/** The header the edge's gate tells the authority the visitor's URL in. */
const GATE_URL_HEADER = 'x-upwind-gate-url';

const db = database({ notes: table({ title: text() }) });

/** A board's page, which every visitor is shown alike: its project's id. */
const board: ComponentProgram = {
  buildId: BUILD,
  component: 'components/board',
  evaluate: (props: Readonly<Record<string, unknown>>, $: RenderScope) =>
    $.h('p', null, String(props['projectId'])),
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

const route: RouteRegistration = {
  blocking: true,
  middleware: [],
  page: 'boards/[projectId]/page.tsx',
  params: ['projectId'],
  props: { projectId: 'projectId' },
  root: board.component,
  route: BOARD,
  shared: true,
};

/**
 * The board's authority, and its site, which renders a board's page as its root entry does: the
 * route's root, of the last segment of the path it is asked for, with the generation's token.
 */
function authorityOf(): Engine {
  const engine = new Engine({ buildId: BUILD, database: db, programs: [board], routes: [route] });
  onTestFinished(async () => {
    await engine.close();
  });
  engine.site(async (path, headers) => {
    const answer = await engine.renderShared(null, {
      build: BUILD,
      generation: headers[GENERATION_HEADER],
      props: { projectId: path.split('/').at(-1) ?? '' },
      route: BOARD,
    });
    const type = headers['rsc'] === '1' ? 'text/x-component' : 'text/html; charset=utf-8';
    return Response.json(answer.result.tree, { headers: { 'content-type': type } });
  });
  return engine;
}

/** The gate's answer to a visitor's request for `url`, of the board's route. */
async function gated(engine: Engine, url: string): Promise<GateAnswer> {
  return engine.gate({ headers: {}, method: 'GET', route: BOARD, url });
}

/**
 * The Node authority's gate route asked the edge's question of the visitor's URL `url`, as a
 * request and a response that stand in for the edge's: the status and the headers it answered.
 */
async function forwarded(engine: Engine, url: string): Promise<readonly unknown[]> {
  const written: unknown[] = [];
  const res = {
    end: (): void => {
      // What is written of the answer's body is not read.
    },
    writeHead: (...head: readonly unknown[]): unknown => {
      written.push(...head);
      return res;
    },
  };
  const req = { headers: { [GATE_ROUTE_HEADER]: BOARD, [GATE_URL_HEADER]: url } };
  await handleShared({
    engine,
    method: 'GET',
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    streams: new Set(),
    url: new URL('http://127.0.0.1/internal/gate'),
  });
  return written;
}

describe('the URL a gate’s question names, as the gate reads it', () => {
  it.each(['//x/boards/p1', String.raw`/\x/boards/p1`, '//x/boards/p1?tab=open'])(
    'passes %s, a path of no route, to the site',
    async (url) => {
      const engine = authorityOf();

      const answer = await gated(engine, url);
      const { sharedViews } = await engine.stats();

      expect(answer).toStrictEqual({ kind: 'pass' });
      // No view was taken in for the path that follows what was taken for a host.
      expect(sharedViews).toBe(0);
    },
  );

  it('passes the edge’s question of a visitor’s URL whose path begins with two slashes', async () => {
    const engine = authorityOf();

    const written = await forwarded(engine, 'https://site.test//x/boards/p1');

    expect(written).toStrictEqual([204, { [GATE_ANSWER_HEADER]: GATE_PASS }]);
  });

  it('answers the route’s own path, and its query, with its view’s page', async () => {
    const engine = authorityOf();

    const answer = await gated(engine, '/boards/p1?tab=open');

    expect(answer).toMatchObject({ kind: 'respond', status: 200 });
  });
});
