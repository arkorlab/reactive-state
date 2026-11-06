import { describe, expect, it, onTestFinished } from 'vitest';

import type { Json } from '../src/program.ts';
import { GENERATION_HEADER, type SharedEvent, type SharedRenderAnswer } from '../src/routing.ts';
import { textOf } from './support/frames.ts';
import {
  BOARD,
  bodyOf,
  BUILD,
  headerOf,
  open,
  pageOf,
  viewTokenOf,
  WHOAMI,
  WORKSPACE,
} from './support/shared-fixture.ts';

/**
 * The shared views of the application `support/shared-fixture.ts` declares — a public board of a
 * project's to-dos, which shows only a published project, and a page that says who is reading it —
 * through the engine's own gate: what the authority decides, and what it counts.
 */

/**
 * What a page answers besides what `pageOf`'s does: the page's own headers, as Next.js writes them,
 * which an artifact keeps; then what a routing rule laid on the authority's own request —
 * `next.config`'s `headers()`, its policies, CORS, a rewrite's — which the edge, or the Function's
 * runtime, lays on each answer for the visitor's; and what an artifact keeps none of — the gate's
 * own, the one transmission's, the transport's, the platform's, and Next.js's cache's of the one
 * request.
 */
const PAGE_HEADERS: readonly (readonly [string, string])[] = [
  ['link', '</font.woff2>; rel=preload; as=font'],
  [
    'vary',
    'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, next-url, Accept-Encoding',
  ],
  ['x-nextjs-postponed', '1'],
  ['x-nextjs-prerender', '1'],
  ['x-nextjs-stale-time', '300'],
  ['x-powered-by', 'Next.js'],
  ['access-control-allow-origin', '*'],
  ['content-language', 'ja'],
  ['content-security-policy', "default-src 'self'"],
  ['permissions-policy', 'camera=()'],
  ['x-frame-options', 'DENY'],
  ['x-nextjs-rewritten-path', '/boards/p1'],
  ['age', '3'],
  ['alt-svc', 'h3=":443"'],
  ['cache-control', 'private, no-cache, no-store, max-age=0, must-revalidate'],
  ['cdn-cache-control', 'max-age=60'],
  ['cf-ray', '8c2f0a1b2c3d4e5f-SJC'],
  ['connection', 'keep-alive'],
  ['content-encoding', 'gzip'],
  ['content-length', '9999'],
  ['date', 'Sat, 17 Oct 2026 00:00:00 GMT'],
  ['etag', '"page"'],
  ['expires', '0'],
  ['keep-alive', 'timeout=5'],
  ['last-modified', 'Sat, 17 Oct 2026 00:00:00 GMT'],
  ['nel', '{"report_to":"cf-nel","max_age":604800}'],
  ['pragma', 'no-cache'],
  ['proxy-authenticate', 'Basic'],
  ['server', 'cloudflare'],
  ['server-timing', 'render;dur=12'],
  ['transfer-encoding', 'chunked'],
  ['via', '1.1 proxy'],
  ['x-arkor-edge', 'function'],
  ['x-middleware-rewrite', '/boards/p1'],
  ['x-next-cache-tags', '_N_T_/boards/p1'],
  ['x-nextjs-cache', 'MISS'],
  ['x-upwind-gate', 'pass'],
];

describe('a shared view through its gate', () => {
  it('renders a published board once, of the to-dos it shows', async () => {
    const { ask, asked } = await open();
    const first = await ask('/boards/p1');

    expect(first).toMatchObject({ kind: 'respond', status: 200 });
    expect(bodyOf(first)).toContain('開発');
    expect(bodyOf(first)).toContain('一覧を作る');
    expect(bodyOf(first)).toContain('|g1');
    expect(asked).toStrictEqual([
      { path: '/boards/p1', rsc: false },
      { path: '/boards/p1', rsc: true },
    ]);
  });

  it('answers a hundred requests with no read, evaluation nor render', async () => {
    const { ask, asked, engine } = await open();
    const first = bodyOf(await ask('/boards/p1'));
    const before = await engine.stats();
    const bodies = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      bodies.add(bodyOf(await ask('/boards/p1')));
    }
    const after = await engine.stats();

    expect([...bodies]).toStrictEqual([first]);
    expect(after.sharedEvaluations).toBe(before.sharedEvaluations);
    expect(after.evaluations).toBe(before.evaluations);
    expect(after.appReads).toBe(before.appReads);
    expect(after.nextRenders).toBe(before.nextRenders);
    expect(after.artifactReads - before.artifactReads).toBe(100);
    // Its bytes as they are kept and served, UTF-8's, which its Japanese is three each of.
    expect(after.artifactBytes - before.artifactBytes).toBe(100 * Buffer.byteLength(first, 'utf8'));
    expect(asked).toHaveLength(2);
  });

  it('answers the router a payload of its own, and keeps no cookie of the page', async () => {
    const { ask } = await open();
    const rsc = await ask('/boards/p1', { rsc: '1' });

    expect(headerOf(rsc, 'content-type')).toBe('text/x-component');
    expect(headerOf(rsc, 'x-nextjs-deployment-id')).toBe('dpl_test');
    expect(headerOf(rsc, 'set-cookie')).toBeUndefined();
    expect(headerOf(rsc, 'cache-control')).toBe('private, no-cache');
    await expect(
      ask('/boards/p1', { 'next-router-prefetch': '1', rsc: '1' }),
    ).resolves.toStrictEqual({
      kind: 'pass',
    });
  });

  it.each([
    ['document', {}, 'text/html; charset=utf-8'],
    ['payload', { rsc: '1' }, 'text/x-component'],
  ])(
    'answers a %s with the page’s own headers alone: none a routing rule laid, nor of a session’s, the gate’s, the transport’s or the platform’s',
    async (_representation, headers, type) => {
      const { ask } = await open({
        site: (engine) => {
          const page = pageOf(engine);
          return async (path, asked) => {
            const answer = await page(path, asked);
            const answered = new Headers(answer.headers);
            for (const [name, value] of PAGE_HEADERS) {
              answered.append(name, value);
            }
            return new Response(answer.body, { headers: answered, status: answer.status });
          };
        },
      });
      const answer = await ask('/boards/p1', headers);

      expect(answer.kind === 'respond' ? Object.fromEntries(answer.headers) : {}).toStrictEqual({
        'cache-control': 'private, no-cache',
        'content-type': type,
        etag: expect.stringMatching(/^"rs-/u),
        link: '</font.woff2>; rel=preload; as=font',
        // The gate's, with what else the page said it varies on.
        vary: 'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, next-url, Accept-Encoding',
        'x-nextjs-deployment-id': 'dpl_test',
        'x-nextjs-postponed': '1',
        'x-nextjs-prerender': '1',
        'x-nextjs-stale-time': '300',
        'x-powered-by': 'Next.js',
      });
    },
  );

  it('answers 304 for the artifact a browser holds, and nothing of a later epoch', async () => {
    const { ask, operate } = await open();
    const etag = headerOf(await ask('/boards/p1'), 'etag') ?? '';

    await expect(ask('/boards/p1', { 'if-none-match': etag })).resolves.toMatchObject({
      body: null,
      status: 304,
    });

    await operate('setPublished', 'p1', false);

    // A prefetch first, before anything asked for the view settled it again.
    await expect(
      ask('/boards/p1', { 'next-router-prefetch': '1', rsc: '1' }),
    ).resolves.toMatchObject({
      status: 403,
    });
    await expect(ask('/boards/p1', { 'if-none-match': etag })).resolves.toMatchObject({
      status: 403,
    });

    await operate('setPublished', 'p1', true);
    const again = await ask('/boards/p1', { 'if-none-match': etag });

    expect(again).toMatchObject({ status: 200 });
    expect(headerOf(again, 'etag')).not.toBe(etag);
  });

  it('refuses a board not published and one that is not there alike', async () => {
    const { ask, asked, engine } = await open();
    const unpublished = await ask('/boards/p2');
    const missing = await ask('/boards/nope');

    expect(unpublished).toMatchObject({ status: 403 });
    expect(missing).toStrictEqual(unpublished);
    expect(bodyOf(unpublished)).not.toContain('運用');
    expect(asked).toHaveLength(0);
    // The board's to-dos were never read: the root refused before them.
    expect((await engine.stats()).evaluationsByComponent['components/board-todos']).toBeUndefined();
  });

  it('shows a write of what it read in its next answer, and none of what it did not', async () => {
    const { ask, asked, engine, operate } = await open();
    await ask('/boards/p1');
    await ask('/boards/p2');
    await operate('setTodoTitle', 't1', '一覧を直す');
    const updated = await ask('/boards/p1');

    expect(bodyOf(updated)).toContain('一覧を直す');
    expect(bodyOf(updated)).toContain('|g2');

    const made = asked.length;
    const evaluations = (await engine.stats()).sharedEvaluations;
    await operate('setNote', 'p1', 'PRIVATE_CHANGED');

    expect(bodyOf(await ask('/boards/p1'))).toContain('|g2');
    expect(asked).toHaveLength(made);
    // The note is read by the board (its record), so it is evaluated again, and shows the same.
    expect((await engine.stats()).sharedEvaluations).toBe(evaluations + 1);

    // A change of p2 alone: p2's view is evaluated again, p1's is not.
    await operate('setNote', 'p2', 'ELSEWHERE');

    await expect(ask('/boards/p2')).resolves.toMatchObject({ status: 403 });
    expect(bodyOf(await ask('/boards/p1'))).toContain('|g2');
    expect((await engine.stats()).sharedEvaluations).toBe(evaluations + 2);
  });

  it('follows a board from no to-do to one, and a project published after it was refused', async () => {
    const { ask, operate } = await open();

    await expect(ask('/boards/p2')).resolves.toMatchObject({ status: 403 });

    await operate('setPublished', 'p2', true);
    const published = await ask('/boards/p2');

    expect(bodyOf(published)).toContain('empty');

    await operate('addTodo', 'p2', '最初の作業');

    expect(bodyOf(await ask('/boards/p2'))).toContain('最初の作業');
  });

  it('refuses a withdrawn board on the next request, and tells its streams', async () => {
    const { ask, engine, operate } = await open();
    const shown = await ask('/boards/p1');

    expect(shown).toMatchObject({ status: 200 });

    const followed = await engine.followShared(await viewTokenOf(engine, 'p1'));
    const heard: SharedEvent[] = [];
    const stop = followed.listen((event) => {
      heard.push(event);
    });
    onTestFinished(stop);
    await operate('setPublished', 'p1', false);

    await expect(ask('/boards/p1')).resolves.toMatchObject({ status: 403 });
    expect(heard).toStrictEqual([{ epoch: 2, kind: 'denied' }]);
  });

  it('answers 503 for a view it cannot make in time, never the earlier artifact', async () => {
    const { ask, engine, operate } = await open({ gateWaitMs: 50 });
    await ask('/boards/p1');
    engine.site(undefined);
    await operate('setTodoTitle', 't2', '確認しない');

    await expect(ask('/boards/p1')).resolves.toMatchObject({ status: 503 });
  });

  it('answers 503 at once for a view there is no site to make, holding the request for nothing else', async () => {
    const { ask, engine, operate } = await open({ gateWaitMs: 5000 });
    await ask('/boards/p1');
    engine.site(undefined);
    await operate('setTodoTitle', 't2', '作れない');
    const before = await engine.stats();

    await expect(ask('/boards/p1')).resolves.toMatchObject({ status: 503 });

    const after = await engine.stats();

    // Held while the view was evaluated, and no longer: no job, each ended as it starts, woke it
    // only for it to start another until its deadline.
    expect(after.gateWaits - before.gateWaits).toBe(1);
    expect(after.generationFailures - before.generationFailures).toBeLessThanOrEqual(1);
  });

  it('never publishes a generation a commit outran while it was made', async () => {
    let hold: (() => void) | undefined;
    let held = false;
    const { ask, operate } = await open({
      site: (engine) => {
        const page = pageOf(engine);
        return async (path, headers) => {
          const answer = await page(path, headers);
          if (!held && headers['rsc'] !== '1' && (await answer.clone().text()).includes('|g2')) {
            held = true;
            const { promise, resolve } = Promise.withResolvers<undefined>();
            hold = () => {
              resolve(undefined);
            };
            await promise;
          }
          return answer;
        };
      },
    });
    await ask('/boards/p1');
    await operate('setTodoTitle', 't1', 'A');
    const waiting = ask('/boards/p1');

    await expect.poll(() => hold !== undefined).toBe(true);

    await operate('setTodoTitle', 't1', 'B');
    hold?.();
    const answer = await waiting;

    expect(bodyOf(answer)).toContain('B');
    expect(bodyOf(answer)).not.toContain('>A<');
  });

  it('answers a request made once a commit was acknowledged with what the commit made, while an earlier generation is still being made', async () => {
    let hold: (() => void) | undefined;
    let held = false;
    const { ask, operate } = await open({
      site: (engine) => {
        const page = pageOf(engine);
        return async (path, headers) => {
          const answer = await page(path, headers);
          if (!held && headers['rsc'] !== '1' && (await answer.clone().text()).includes('|g2')) {
            held = true;
            const { promise, resolve } = Promise.withResolvers<undefined>();
            hold = () => {
              resolve(undefined);
            };
            await promise;
          }
          return answer;
        };
      },
    });
    await ask('/boards/p1');
    await operate('setTodoTitle', 't1', 'A');
    const before = ask('/boards/p1');

    await expect.poll(() => hold !== undefined).toBe(true);

    // The next commit acknowledged while A's document is still on its way, and the board asked for
    // only then — as a check asks for it once its write was answered.
    await operate('setTodoTitle', 't1', 'B');
    const after = ask('/boards/p1');
    hold?.();
    const answers = await Promise.all([before, after]);

    expect(answers.map((answer) => bodyOf(answer).includes('B'))).toStrictEqual([true, true]);
    expect(answers.map((answer) => bodyOf(answer).includes('>A<'))).toStrictEqual([false, false]);
  });

  it('renders a root that reads who reads it for each request, never once for all', async () => {
    const { alice, ask, engine } = await open();

    await expect(ask('/whoami/x')).resolves.toStrictEqual({ kind: 'pass' });

    const anonymous = await engine.renderShared(null, {
      build: BUILD,
      props: { projectId: 'x' },
      route: WHOAMI,
    });

    expect(anonymous.kind).toBe('session');
    expect(JSON.stringify(anonymous.result.tree)).toContain('anonymous');

    const signedIn = await engine.renderShared(alice, {
      build: BUILD,
      props: { projectId: 'x' },
      route: WHOAMI,
    });

    expect(JSON.stringify(signedIn.result.tree)).toContain('alice');
  });

  it('renders a route the compile found the request’s for the session, with the page’s own props', async () => {
    const { alice, asked, engine } = await open();

    await expect(
      engine.gate({ headers: {}, method: 'GET', route: WORKSPACE, url: '/workspace/p1' }),
    ).resolves.toStrictEqual({ kind: 'pass' });

    const rendered = await engine.renderShared(alice, {
      build: BUILD,
      props: { filter: 'open', projectId: 'p1' },
      route: WORKSPACE,
    });

    expect(rendered.kind).toBe('session');
    expect(JSON.stringify(rendered.result.tree)).toContain('p1:open');
    expect(asked).toHaveLength(0);
    expect((await engine.stats()).sharedEvaluations).toBe(0);
  });

  it('renders a route the compile found the request’s with props of any JSON its page gives — a search param’s values, a number — for the session or none, in the one call', async () => {
    const { alice, asked, engine } = await open();
    const render = async (session: string | null, filter: Json): Promise<SharedRenderAnswer> => {
      return engine.renderShared(session, {
        build: BUILD,
        props: { filter, projectId: 'p1' },
        route: WORKSPACE,
      });
    };
    const shown: Readonly<Record<string, Json>> = {
      'p1:3': 3,
      'p1:null': null,
      'p1:open,done': ['open', 'done'],
    };

    for (const session of [alice, null]) {
      for (const [text, filter] of Object.entries(shown)) {
        const rendered = await render(session, filter);

        expect(rendered.kind).toBe('session');
        expect(textOf(rendered.result.tree)).toBe(text);
      }
    }

    expect(asked).toHaveLength(0);
    await expect(engine.stats()).resolves.toMatchObject({ sharedEvaluations: 0, sharedViews: 0 });
  });

  it('renders a shared route’s root of props besides its params — another page’s, text or not — for the session, making no view of them, nor asking for any page', async () => {
    const { alice, asked, engine } = await open();

    for (const extra of ['compact', 2, ['a'], { open: true }]) {
      await expect(
        engine.renderShared(alice, {
          build: BUILD,
          props: { extra, projectId: 'p1' },
          route: BOARD,
        }),
      ).resolves.toMatchObject({ kind: 'session', result: { status: 'rendered' } });
    }

    expect(asked).toHaveLength(0);
    await expect(engine.stats()).resolves.toMatchObject({ sharedEvaluations: 0, sharedViews: 0 });
  });

  it('refuses a render that names a generation it is not making, of any route', async () => {
    const { alice, ask, engine } = await open();
    await ask('/boards/p1');
    const forged = (name: string): Promise<unknown> => {
      return engine.renderShared(alice, {
        build: BUILD,
        generation: 'forged',
        props: { projectId: 'p1' },
        route: name,
      });
    };

    await expect(forged(BOARD)).rejects.toMatchObject({ code: 'NOT_A_GENERATION', status: 403 });
    await expect(forged(WORKSPACE)).rejects.toMatchObject({ status: 403 });
    await expect(ask('/boards/p1', { [GENERATION_HEADER]: 'forged' })).resolves.toMatchObject({
      kind: 'respond',
      status: 200,
    });
  });

  it('renders the generation a token names of its view’s props alone, and refuses the token with any other — props besides the params, or a param’s of no text', async () => {
    const answered: unknown[] = [];
    const { ask } = await open({
      site: (engine) => {
        const page = pageOf(engine);
        return async (path, headers) => {
          const generation = headers[GENERATION_HEADER];
          const others: readonly Readonly<Record<string, Json>>[] =
            generation === undefined || answered.length > 0
              ? []
              : [
                  { extra: 'x', projectId: 'p1' },
                  { extra: 1, projectId: 'p1' },
                  { projectId: ['p1'] },
                ];
          for (const props of others) {
            try {
              answered.push(
                await engine.renderShared(null, { build: BUILD, generation, props, route: BOARD }),
              );
            } catch (error) {
              answered.push(error);
            }
          }
          return page(path, headers);
        };
      },
    });

    await expect(ask('/boards/p1')).resolves.toMatchObject({ kind: 'respond', status: 200 });
    expect(answered).toMatchObject([
      { code: 'NOT_A_GENERATION', status: 403 },
      { code: 'NOT_A_GENERATION', status: 403 },
      { code: 'NOT_A_GENERATION', status: 403 },
    ]);
  });

  it('lets the authority’s own request for an artifact through as a generation’s, and a view of the request’s as no more', async () => {
    const passes: unknown[] = [];
    const { ask } = await open({
      site: (engine) => {
        const page = pageOf(engine);
        return async (path, headers) => {
          const token = headers[GENERATION_HEADER];
          if (token !== undefined && passes.length === 0) {
            passes.push(
              await engine.gate({
                headers: { [GENERATION_HEADER]: token },
                method: 'HEAD',
                route: BOARD,
                url: path,
              }),
            );
          }
          return page(path, headers);
        };
      },
    });
    await ask('/boards/p1');

    expect(passes).toStrictEqual([{ generation: true, kind: 'pass' }]);
    await expect(ask('/whoami/x')).resolves.toStrictEqual({ kind: 'pass' });
  });

  it('lets a generation’s token through for its own view’s artifact alone, while it is asked for — never of another view, nor once its request is over', async () => {
    const tokens: string[] = [];
    const elsewhere: unknown[] = [];
    const { ask } = await open({
      site: (engine) => {
        const page = pageOf(engine);
        return async (path, headers) => {
          const generation = headers[GENERATION_HEADER];
          if (generation !== undefined) {
            tokens.push(generation);
            // While its request is under way, of another view's path.
            elsewhere.push(
              await engine.gate({
                headers: { [GENERATION_HEADER]: generation },
                method: 'GET',
                route: BOARD,
                url: '/boards/p2',
              }),
            );
          }
          return page(path, headers);
        };
      },
    });
    await ask('/boards/p1');

    expect(tokens).toHaveLength(2);
    // p2's board as any request of it is answered: refused, its project unpublished.
    expect(elsewhere).toMatchObject(tokens.map(() => ({ kind: 'respond', status: 403 })));

    // Replayed once its request is over: answered from the view's artifact, as any request is.
    for (const token of tokens) {
      await expect(ask('/boards/p1', { [GENERATION_HEADER]: token })).resolves.toMatchObject({
        kind: 'respond',
        status: 200,
      });
    }
  });
});
