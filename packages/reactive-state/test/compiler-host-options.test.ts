import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { cacheLifeProfiles } from '../src/compiler/cache-life.ts';
import { prefetchOf, SHARING_OFF } from '../src/compiler/emit-host.ts';
import { type Compiled, compileApp, openTypeScript } from '../src/compiler/index.ts';
import type { Manifest } from '../src/compiler/manifest.ts';
import { withReactiveState } from '../src/next/config.ts';
import { isPlainRoute, type RegisteredRoute, type RouteRegistration } from '../src/routing.ts';
import { application, type Application, cli, output, removed } from './fixtures/application.ts';

/**
 * What the host tells the compile beside the application's sources: how the application reads its
 * own signed-in session (`--session`), the private cache a root renders inside for a link's
 * prefetch (`--prefetch`), and whether anything is shared (`--no-share`). Each changes what the
 * compile writes around the components alone.
 */

// A whole compile of the fixture runs well past vitest's five seconds on a loaded machine.
vi.setConfig({ hookTimeout: 300_000, testTimeout: 300_000 });

interface Compile {
  readonly app: Application;
  readonly result: Compiled;
}

/** The text of the first `'use server'` module's stub the compile wrote. */
function actionOf({ app, result }: Compile): string {
  for (const [file, text] of result.outputs) {
    if (path.relative(app.out, file).startsWith('actions')) {
      return text;
    }
  }
  throw new Error('The compile wrote no stub.');
}

/** Whether `route` is one of a reactive root's, which a compile judges for sharing. */
function isReactive(route: RegisteredRoute): route is RouteRegistration {
  return !isPlainRoute(route);
}

/** The fixture's sources, which `application()` copies. */
const FIXTURE = new URL('../../../fixtures/next-project-todo/src/', import.meta.url);

/** The text of the compile's route. */
function routeOf({ app, result }: Compile): string {
  const route = path.join(app.appDir, 'api', 'reactive-state', '[...path]', 'route.ts');
  return result.outputs.get(route) ?? '';
}

describe('what the host tells the compile', () => {
  let api: API;
  const apps: Application[] = [];
  let told: Compile;
  let values: Compile;
  let neither: Compile;
  /** The fixture compiled by the command line with `--no-share`: its manifest, and its status. */
  let unshared: { readonly manifest: Manifest; readonly status: number | null };

  async function compiled(
    options: { readonly prefetch?: string; readonly session?: string } = {},
  ): Promise<Compile> {
    const app = await application();
    apps.push(app);
    return {
      app,
      result: compileApp({ api, appDir: app.appDir, outDir: app.out, srcDir: app.src, ...options }),
    };
  }

  beforeAll(async () => {
    api = openTypeScript();
    told = await compiled({ prefetch: 'status', session: '@/session#appSession' });
    values = await compiled({ prefetch: '30/30/300' });
    neither = await compiled();
    const app = await application();
    apps.push(app);
    const ran = cli(app.src, '--out', app.out, '--app', app.appDir, '--no-share');
    const manifest = JSON.parse(
      await readFile(path.join(app.out, 'manifest.json'), 'utf8'),
    ) as Manifest;
    unshared = { manifest, status: ran.status };
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    for (const app of apps.splice(0)) {
      await removed(app);
    }
  });

  it('writes a session source’s re-export', () => {
    expect(told.result.refusals).toStrictEqual([]);
    expect(output(told.result, told.app, 'request-session.ts')).toContain(
      'export { appSession as session } from "@/session";',
    );
  });

  it('hands the session source to each caller', () => {
    const elements = output(told.result, told.app, 'elements.ts');

    expect(elements).toContain("import { session as session$ } from './request-session';");
    expect(elements).toContain('  session: session$,');
    expect(output(told.result, told.app, 'server-functions.ts')).toContain(
      'return updateField(input, elements.session);',
    );
    expect(actionOf(told)).toContain("import { session as session$ } from '../request-session';");
    expect(actionOf(told)).toContain(', session: session$ }) as Promise');
    expect(routeOf(told)).toContain('routeHandlers({ envelopes, routes, session })');
  });

  it('registers the application’s sessions', () => {
    expect(output(told.result, told.app, 'authority.mts')).toContain(
      "export const sessions = 'asserted';",
    );
  });

  it('caches a private root for a prefetch', () => {
    const root = output(told.result, told.app, 'components/todo-editor.root.tsx');

    expect(root).toContain("import { cacheLife } from 'next/cache';");
    expect(root).toContain('  \'use cache: private\';\n  cacheLife("status");');
    expect(root).toContain('prefetchable: true, ');
  });

  it('writes a lifetime’s three values', () => {
    expect(values.result.refusals).toStrictEqual([]);
    expect(output(values.result, values.app, 'components/todo-editor.root.tsx')).toContain(
      'cacheLife({ expire: 300, revalidate: 30, stale: 30 });',
    );
  });

  it('writes what it wrote before, told neither', () => {
    expect(neither.result.refusals).toStrictEqual([]);
    expect(neither.result.outputs.has(path.join(neither.app.out, 'request-session.ts'))).toBe(
      false,
    );
    expect(output(neither.result, neither.app, 'components/todo-editor.root.tsx')).not.toContain(
      'use cache',
    );
    expect(output(neither.result, neither.app, 'authority.mts')).not.toContain('sessions');
    expect(routeOf(neither)).toContain('routeHandlers({ envelopes, routes })');
  });

  it('shares nothing where the application turned sharing off', () => {
    const routes = (neither.result.manifest?.routes ?? []).filter((each) => isReactive(each));
    // Told nothing, the fixture's board is a view every visitor shares.
    const shared = routes.filter((each) => each.shared).map((each) => each.route);
    const privateRoute: unknown = expect.objectContaining({ private: SHARING_OFF, shared: false });
    const unsharedRoutes = unshared.manifest.routes.filter((each) => isReactive(each));

    expect(shared).not.toStrictEqual([]);
    expect(unshared.status).toBe(0);
    expect(unsharedRoutes).toStrictEqual(routes.map(() => privateRoute));
  });

  it('refuses a lifetime no prefetch carries', () => {
    const result = compileApp({
      api,
      appDir: 'app',
      outDir: '.reactive',
      prefetch: '10/10/10',
      srcDir: 'src',
    });

    expect(result.refusals.map((refusal) => refusal.message)).toStrictEqual([
      expect.stringContaining('`10/10/10` is no lifetime a prefetch carries a render by'),
    ]);
  });

  it('refuses a module of its own where the session source is written again', async () => {
    // The publication's actions moved to `src/request-session.ts`, where the re-export is written.
    const actions = await readFile(new URL('actions/publication.ts', FIXTURE), 'utf8');
    const settings = await readFile(
      new URL('components/publication-settings.reactive.tsx', FIXTURE),
      'utf8',
    );
    const app = await application({
      'components/publication-settings.reactive.tsx': settings.replace(
        '@/actions/publication',
        '@/request-session',
      ),
      'request-session.ts': actions,
    });
    apps.push(app);

    const result = compileApp({
      api,
      appDir: app.appDir,
      outDir: app.out,
      session: '@/session#appSession',
      srcDir: app.src,
    });

    expect(result.refusals.map((refusal) => refusal.message)).toStrictEqual([
      expect.stringContaining("writes the session source's re-export as `request-session`"),
    ]);
  });

  it.each([
    ['30/600/300', 'its revalidate is past its expire'],
    ['seconds', 'The cacheLife profile `seconds` is no lifetime'],
  ])('refuses the lifetime %s, which no prefetch carries', (prefetch, why) => {
    const result = compileApp({ api, appDir: 'app', outDir: '.reactive', prefetch, srcDir: 'src' });

    expect(result.refusals.map((refusal) => refusal.message)).toStrictEqual([
      expect.stringContaining(why),
    ]);
  });

  it('takes Next.js’s profiles a prefetch carries, and leaves others to Next.js', () => {
    expect(prefetchOf('minutes')).toStrictEqual({ profile: 'minutes' });
    // `default`, whose `stale` Next.js fills in of `staleTimes.static`: five minutes unless set.
    expect(prefetchOf('default')).toStrictEqual({ profile: 'default' });
    expect(prefetchOf('status')).toStrictEqual({ profile: 'status' });
    expect(prefetchOf('30/300/300')).toStrictEqual({ expire: 300, revalidate: 300, stale: 30 });
  });

  it('reads a profile of the config where the config is read', () => {
    const profiles = {
      slow: { expire: 600, revalidate: 60, stale: 10 },
      status: { expire: 600, revalidate: 30, stale: 30 },
    };

    const read = cacheLifeProfiles({ cacheLife: profiles });

    expect(prefetchOf('status', read)).toStrictEqual({ profile: 'status' });
    expect(() => prefetchOf('slow', read)).toThrow('The cacheLife profile `slow` is no lifetime');
    expect(() => prefetchOf('nope', read)).toThrow('`nope` names no cacheLife profile');
    expect(() =>
      withReactiveState({ cacheComponents: true, cacheLife: profiles }, { prefetch: 'slow' }),
    ).toThrow('withReactiveState: The cacheLife profile `slow` is no lifetime');
  });

  it('reads a profile as Next.js keeps a render by it: what it leaves out is `default`’s', () => {
    // `quick` says a `revalidate` alone: `default`'s `stale` and `expire` keep its render.
    const quick = cacheLifeProfiles({ cacheLife: { quick: { revalidate: 60 } } });
    // `default`'s own `stale` of `staleTimes.static`, its `expire` of `expireTime`.
    const fleeting = cacheLifeProfiles({ experimental: { staleTimes: { static: 10 } } });
    const ending = cacheLifeProfiles({
      cacheLife: { default: { revalidate: 60 }, quick: { revalidate: 60 } },
      expireTime: 120,
    });

    expect(prefetchOf('quick', quick)).toStrictEqual({ profile: 'quick' });
    expect(prefetchOf('default', quick)).toStrictEqual({ profile: 'default' });
    expect(() => prefetchOf('default', fleeting)).toThrow('`default` is no lifetime');
    expect(() => prefetchOf('quick', ending)).toThrow('`quick` is no lifetime');
    // A config of no profiles of its own, as `withReactiveState` reads it: Next.js's.
    expect(withReactiveState({ cacheComponents: true }, { prefetch: 'default' })).toMatchObject({
      cacheComponents: true,
    });
  });

  it('refuses a session source of no export', () => {
    const result = compileApp({
      api,
      appDir: 'app',
      outDir: '.reactive',
      session: '@/session',
      srcDir: 'src',
    });

    expect(result.refusals.map((refusal) => refusal.message)).toStrictEqual([
      expect.stringContaining('names no session source'),
    ]);
  });
});
