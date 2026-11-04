import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Engine } from '../src/authority/index.ts';
import { type ComponentProgram, PROTOCOL_VERSION } from '../src/program.ts';
import {
  type GateAnswer,
  GENERATION_HEADER,
  type MiddlewareProgram,
  type RouteRegistration,
} from '../src/routing.ts';
import { currentUser, database, forbidden, table, text } from '../src/server/index.ts';
import { nextPageParam } from './support/next-page.ts';

/** A route's authorization survives path spellings whose document needs its own render. */
const BUILD = 'b_spellings';
const ROUTE = '/boards/[projectId]';
const PATHS = ['/boards/p1', '/boards/p%31', '/boards/p1/'] as const;
type Mode = 'fault' | 'guard-refused' | 'private' | 'responded' | 'root-refused' | 'shown';

/** A board whose root or guard decides its stored mode, and whose site records artifact requests. */
async function open(
  mode: Mode = 'shown',
  options: {
    readonly gateWaitMs?: number;
    readonly root?: () => Promise<void>;
    readonly guard?: () => Promise<void>;
  } = {},
): Promise<{
  readonly ask: (
    url: string,
    method?: 'GET' | 'HEAD',
    headers?: Readonly<Record<string, string>>,
  ) => Promise<GateAnswer>;
  readonly asked: readonly string[];
  readonly engine: Engine;
  readonly setMode: (mode: Mode) => Promise<void>;
}> {
  const db = database(
    { boards: table({ mode: text({ maxLength: 32 }) }) },
    { seed: { boards: { p1: { mode } } } },
  );
  const root: ComponentProgram = {
    buildId: BUILD,
    component: 'components/board',
    evaluate: async (props, $) => {
      if (options.root !== undefined) await options.root();
      const board = await db.boards.get(String(props['projectId']));
      if (board?.mode === 'root-refused') forbidden();
      if (board?.mode === 'fault') throw new Error('The board failed.');
      if (board?.mode === 'private') await currentUser();
      return $.h('p', null, 'board');
    },
    protocolVersion: PROTOCOL_VERSION,
    updaters: {},
    writable: [],
  };
  const guard: MiddlewareProgram = {
    buildId: BUILD,
    guard: async ({ params }) => {
      if (options.guard !== undefined) await options.guard();
      const board = await db.boards.get(params['projectId'] ?? '');
      if (board?.mode === 'guard-refused') forbidden();
      return board?.mode === 'responded'
        ? {
            body: 'Moved',
            headers: [
              ['location', '/boards'],
              ['set-cookie', 'first=1'],
              ['set-cookie', 'second=2'],
            ],
            status: 307,
          }
        : undefined;
    },
    id: 'boards',
    protocolVersion: PROTOCOL_VERSION,
  };
  const route: RouteRegistration = {
    blocking: true,
    guarded: true,
    middleware: ['boards'],
    page: 'boards/[projectId]/page.tsx',
    params: ['projectId'],
    props: { projectId: 'projectId' },
    root: root.component,
    route: ROUTE,
    shared: true,
  };
  const engine = new Engine({
    buildId: BUILD,
    database: db,
    gateWaitMs: options.gateWaitMs ?? 1000,
    middleware: { boards: guard },
    operations: {
      'actions/boards': {
        async setMode(value: unknown): Promise<void> {
          await db.transaction(async () => {
            await db.boards.update('p1', { mode: String(value) });
          });
        },
      },
    },
    programs: [root],
    routes: [route],
  });
  onTestFinished(async () => {
    await engine.close();
  });
  const asked: string[] = [];
  engine.site(
    async (page, headers) => {
      asked.push(page);
      const answer = await engine.renderShared(null, {
        build: BUILD,
        generation: headers[GENERATION_HEADER],
        props: { projectId: nextPageParam(page.split('/').at(-1) ?? '') },
        route: ROUTE,
      });
      return Response.json(answer.result.tree, {
        headers: { 'content-type': headers['rsc'] === '1' ? 'text/x-component' : 'text/html' },
      });
    },
    { basePath: '', skipTrailingSlashRedirect: true, trailingSlash: false },
  );
  const { sessionId } = await engine.login('alice');
  let changes = 0;
  return {
    ask: async (url, method = 'GET', headers = {}) =>
      engine.gate({ headers, method, route: ROUTE, url }),
    asked,
    engine,
    setMode: async (value) => {
      changes += 1;
      await engine.operate(sessionId, {
        args: [{ json: value }],
        build: BUILD,
        module: 'actions/boards',
        name: 'setMode',
        operationId: `mode-${String(changes)}`,
      });
    },
  };
}

/** The authority's expected log of a root that fails. */
function silenceFaults(): void {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {
    // This fixture deliberately renders a failing root.
  });
  onTestFinished(() => {
    logged.mockRestore();
  });
}

describe.each(PATHS)('a shared gate asked at %s', (url) => {
  it.each(['root-refused', 'guard-refused'] as const)(
    'keeps a %s decision before an artifact exists',
    async (mode) => {
      const { ask, asked } = await open(mode);
      const answer = await ask(url);

      expect(answer).toMatchObject({ kind: 'respond', status: 403 });
      expect(answer.kind === 'respond' ? answer.by : undefined).toBe(
        mode === 'guard-refused' ? 'boards' : undefined,
      );
      expect(asked).toStrictEqual([]);
    },
  );

  it('keeps a failing root unavailable', async () => {
    silenceFaults();
    const { ask, asked } = await open('fault');

    await expect(ask(url)).resolves.toMatchObject({ kind: 'respond', status: 503 });
    expect(asked).toStrictEqual([]);
  });

  it.each(['GET', 'HEAD'] as const)('keeps a guard response for %s', async (method) => {
    const { ask, asked } = await open('responded');
    const answer = await ask(url, method);

    expect(answer).toMatchObject({
      body: method === 'HEAD' ? null : Buffer.from('Moved').toString('base64'),
      by: 'boards',
      headers: [
        ['cache-control', 'private, no-store'],
        ['location', '/boards'],
        ['set-cookie', 'first=1'],
        ['set-cookie', 'second=2'],
      ],
      kind: 'respond',
      status: 307,
    });
    expect(answer).not.toHaveProperty('refused');
    expect(asked).toStrictEqual([]);
  });
});

describe.each(PATHS.slice(1))('an allowed shared view at %s', (url) => {
  it('evaluates a cold view without making or waiting for another spelling’s artifacts', async () => {
    const { ask, asked, engine } = await open();

    await expect(ask(url)).resolves.toStrictEqual({ kind: 'pass' });
    await expect(engine.stats()).resolves.toMatchObject({ gateWaits: 1, sharedEvaluations: 1 });
    expect(asked).toStrictEqual([]);
    await expect(ask(url, 'GET', { rsc: '1' })).resolves.toStrictEqual({ kind: 'pass' });
    await expect(engine.stats()).resolves.toMatchObject({ gateWaits: 1, sharedEvaluations: 1 });
    expect(asked).toStrictEqual([]);
  });

  it('passes a ready view without reading or reusing another spelling’s artifact', async () => {
    const { ask, asked, engine } = await open();
    await ask('/boards/p1');
    const before = await engine.stats();

    expect(asked).toStrictEqual(['/boards/p1', '/boards/p1']);
    await expect(ask(url)).resolves.toStrictEqual({ kind: 'pass' });
    expect((await engine.stats()).artifactReads).toBe(before.artifactReads);
    expect(asked).toStrictEqual(['/boards/p1', '/boards/p1']);
  });

  it('rechecks a dirty view before passing its alternate spelling', async () => {
    const { ask, asked, setMode } = await open();
    await ask('/boards/p1');
    await setMode('root-refused');

    await expect(ask(url)).resolves.toMatchObject({ kind: 'respond', status: 403 });
    expect(asked).toStrictEqual(['/boards/p1', '/boards/p1']);
  });

  it('keeps a dirty view unavailable when its new evaluation fails', async () => {
    silenceFaults();
    const { ask, asked, setMode } = await open();
    await ask('/boards/p1');
    await setMode('fault');

    await expect(ask(url)).resolves.toMatchObject({ kind: 'respond', status: 503 });
    expect(asked).toStrictEqual(['/boards/p1', '/boards/p1']);
  });

  it.each(['root', 'guard'] as const)('keeps its deadline while a %s is slow', async (part) => {
    const { promise: held, resolve: release } = Promise.withResolvers<undefined>();
    const { ask } = await open('shown', { gateWaitMs: 10, [part]: async () => held });
    const answering = ask(url);
    const beforeRelease = await Promise.race([answering, delay(100)]);
    release(undefined);
    await answering;

    expect(beforeRelease).toMatchObject({ kind: 'respond', status: 503 });
  });

  it('serves a canonical request that joins its evaluation', async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<undefined>();
    const { promise: started, resolve: began } = Promise.withResolvers<undefined>();
    const { ask, asked } = await open('shown', {
      root: async () => {
        began(undefined);
        await held;
      },
    });
    const alternate = ask(url);
    await started;
    const canonical = ask('/boards/p1');
    release(undefined);

    await expect(alternate).resolves.toStrictEqual({ kind: 'pass' });
    await expect(canonical).resolves.toMatchObject({ kind: 'respond', status: 200 });
    expect(asked).toStrictEqual(['/boards/p1', '/boards/p1']);
  });

  it('keeps a prefetch refusal and a private view’s pass', async () => {
    const refused = await open('root-refused');

    await expect(
      refused.ask(url, 'GET', { 'next-router-prefetch': '1', rsc: '1' }),
    ).resolves.toMatchObject({ kind: 'respond', status: 403 });

    const privateView = await open('private');

    await expect(privateView.ask(url)).resolves.toStrictEqual({ kind: 'pass' });
    expect(privateView.asked).toStrictEqual([]);
  });
});
