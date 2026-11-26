import { spawnSync } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Compiled, openTypeScript, writeOutputs } from '../src/compiler/index.ts';
import { isPlainRoute, type PlainRouteRegistration, type RegisteredRoute } from '../src/routing.ts';
import {
  application,
  type Application,
  compiledApp,
  node,
  output,
  positionOf,
  refusalOf,
  removed,
} from './fixtures/application.ts';

/**
 * The routes under route middleware that are no reactive route — a page that renders no reactive
 * root, a route handler — as a compile registers them: each with the chain of middleware around it,
 * and whether a guard is among it, for the delivery route to run the envelopes around every request
 * of it and the guards ahead of each; and what it refuses of them rather than leave a request of
 * one to be served around the middleware: a route no rewrite places exactly, members prerendered,
 * and a metadata file of code under a guard.
 */

const PACKAGE = fileURLToPath(new URL('../', import.meta.url));

/** A source file of `lines`. */
function file(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/** The app's own middleware: an envelope alone, around every route. */
const ENVELOPE = file(
  "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
  '',
  'export default (async (_context, next) => {',
  '  const response = await next();',
  "  response.headers.set('X-Root', '1');",
  '  return response;',
  '}) satisfies RouteMiddleware;',
);

/** An account's middleware: a guard of the session's user, and an envelope. */
const GUARD = file(
  "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
  "import { requireUser } from '@/auth';",
  '',
  'export default (async (_context, next) => {',
  '  await requireUser();',
  '  const response = await next();',
  "  response.headers.append('X-Account', '1');",
  '  return response;',
  '}) satisfies RouteMiddleware;',
);

/** A page of no reactive root: a sign-in page, say. */
const PAGE = file('export default function Page() {', '  return <p>Sign in</p>;', '}');

/** A route handler of a dynamic segment. */
const HANDLER = file(
  'export function GET(): Response {',
  '  return Response.json({ ok: true });',
  '}',
  '',
  'export function PUT(): Response {',
  '  return new Response(null, { status: 204 });',
  '}',
);

/** What a module exports for Next.js to prerender the members of its route by. */
const MEMBERS = file(
  'export async function generateStaticParams() {',
  "  return [{ tab: 'a' }];",
  '}',
);

interface Manifested {
  readonly routes: readonly RegisteredRoute[];
}

/** The routes of no reactive root a compile registered, in the manifest's order. */
function plainOf(compiled: Compiled, app: Application): readonly PlainRouteRegistration[] {
  const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as Manifested;
  return manifest.routes.filter((route) => isPlainRoute(route));
}

/** What the authority makes of the registry the compile wrote: its routes of each kind, by name. */
function loadedRoutes(app: Application): unknown {
  const authority = (name: string): string =>
    JSON.stringify(path.join(PACKAGE, 'src/authority', name));
  const ran = node(
    [
      `import { registerPaths } from ${authority('paths.ts')};`,
      `import { registryOf } from ${authority('programs.ts')};`,
      `import { routeRegistryOf } from ${authority('route-registry.ts')};`,
      `registerPaths(${JSON.stringify(app.tsconfig)});`,
      `const registry = await import(${JSON.stringify(path.join(app.out, 'authority.mts'))});`,
      'const { buildId, middleware, operations, programs, routes } = registry;',
      'const loaded = routeRegistryOf({ middleware, routes }, registryOf({ buildId, operations, programs }));',
      'process.stdout.write(JSON.stringify({ plain: [...loaded.plain.keys()], routes: [...loaded.routes.keys()] }));',
    ].join('\n'),
    app.root,
  );
  if (ran.status !== 0) {
    throw new Error(ran.stderr);
  }
  return JSON.parse(ran.stdout) as unknown;
}

/** What the application's type check says of the files the compile wrote. */
function diagnosticsOfOutputs(app: Application): readonly string[] {
  const tsc = path.join(PACKAGE, 'node_modules/typescript/bin/tsc');
  const ran = spawnSync(process.execPath, [tsc, '--noEmit', '-p', app.root], {
    cwd: app.root,
    encoding: 'utf8',
  });
  return `${ran.stdout}${ran.stderr}`
    .split('\n')
    .filter((line) => line.startsWith('.reactive/') || line.startsWith('src/'));
}

describe('the compile of the routes under route middleware that render no reactive root', () => {
  let api: API;
  const apps: Application[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    for (const each of apps) {
      await removed(each);
    }
  });

  async function compiledWith(
    files: Readonly<Record<string, string>>,
  ): Promise<{ app: Application; compiled: Compiled }> {
    const app = await application(files);
    apps.push(app);
    return { app, compiled: compiledApp(app, api) };
  }

  /** The middleware the cases are under: the app's envelope, and the account's guard. */
  const UNDER = { 'app/account/middleware.ts': GUARD, 'app/middleware.ts': ENVELOPE };

  it('registers each page of no reactive root and each route handler under route middleware with its chain, and nothing of the compile’s own route or a private folder', async () => {
    const { app, compiled } = await compiledWith({
      ...UNDER,
      'app/_drafts/page.tsx': PAGE,
      'app/account/[tab]/page.tsx': PAGE,
      'app/account/page.tsx': PAGE,
      'app/api/items/[itemId]/route.ts': HANDLER,
    });

    expect(compiled.refusals).toStrictEqual([]);
    expect(plainOf(compiled, app)).toStrictEqual([
      { file: 'page.tsx', middleware: [''], params: [], plain: 'page', route: '/' },
      {
        file: 'account/page.tsx',
        guarded: true,
        middleware: ['', 'account'],
        params: [],
        plain: 'page',
        route: '/account',
      },
      {
        file: 'account/[tab]/page.tsx',
        guarded: true,
        middleware: ['', 'account'],
        params: ['tab'],
        plain: 'page',
        route: '/account/[tab]',
      },
      {
        file: 'api/items/[itemId]/route.ts',
        middleware: [''],
        params: ['itemId'],
        plain: 'handler',
        route: '/api/items/[itemId]',
      },
    ]);
  });

  it('registers the routes of a folder `%5F` escapes at the segment Next.js serves it at, `_admin`, a param under it too', async () => {
    const { app, compiled } = await compiledWith({
      'app/%5Fadmin/[tab]/page.tsx': PAGE,
      'app/%5Fadmin/middleware.ts': GUARD,
      'app/%5Fadmin/page.tsx': PAGE,
    });
    const under = { guarded: true, middleware: ['%5Fadmin'], plain: 'page' };

    expect(compiled.refusals).toStrictEqual([]);
    expect(plainOf(compiled, app)).toStrictEqual([
      { ...under, file: '%5Fadmin/page.tsx', params: [], route: '/_admin' },
      { ...under, file: '%5Fadmin/[tab]/page.tsx', params: ['tab'], route: '/_admin/[tab]' },
    ]);
  });

  it('registers the routes Next.js serves under a folder of a leading dot or `node_modules` — a route handler under `.well-known` beneath a guard among them — and none of a private folder', async () => {
    const { app, compiled } = await compiledWith({
      'app/.hidden/page.tsx': PAGE,
      'app/.well-known/_drafts/route.ts': HANDLER,
      'app/.well-known/keys/[keyId]/route.ts': HANDLER,
      'app/.well-known/openid-configuration/route.ts': HANDLER,
      'app/_drafts/route.ts': HANDLER,
      'app/middleware.ts': GUARD,
      'app/node_modules/listed/page.tsx': PAGE,
    });
    const under = { guarded: true, middleware: [''], params: [] };

    expect(compiled.refusals).toStrictEqual([]);
    expect(plainOf(compiled, app)).toStrictEqual([
      { ...under, file: 'page.tsx', plain: 'page', route: '/' },
      { ...under, file: '.hidden/page.tsx', plain: 'page', route: '/.hidden' },
      {
        ...under,
        file: '.well-known/keys/[keyId]/route.ts',
        params: ['keyId'],
        plain: 'handler',
        route: '/.well-known/keys/[keyId]',
      },
      {
        ...under,
        file: '.well-known/openid-configuration/route.ts',
        plain: 'handler',
        route: '/.well-known/openid-configuration',
      },
      {
        ...under,
        file: 'node_modules/listed/page.tsx',
        plain: 'page',
        route: '/node_modules/listed',
      },
    ]);
  });

  it('registers the routes under a link to a folder at the path Next.js serves them, as it follows the link, and walks no link back into a folder it is in', async () => {
    const app = await application({
      'app/middleware.ts': GUARD,
      'linked/page.tsx': PAGE,
      'linked/reports/route.ts': HANDLER,
    });
    apps.push(app);
    await symlink(path.join(app.src, 'linked'), path.join(app.appDir, 'docs'));
    await mkdir(path.join(app.src, 'linked', 'deeper'));
    await writeFile(path.join(app.src, 'linked', 'deeper', 'page.tsx'), PAGE);
    await symlink(app.appDir, path.join(app.src, 'linked', 'deeper', 'loop'));
    await symlink(path.join(app.src, 'missing'), path.join(app.appDir, 'dangling'));
    const compiled = compiledApp(app, api);
    const under = { guarded: true, middleware: [''], params: [] };

    expect(compiled.refusals).toStrictEqual([]);
    expect(plainOf(compiled, app)).toStrictEqual([
      { ...under, file: 'page.tsx', plain: 'page', route: '/' },
      { ...under, file: 'docs/page.tsx', plain: 'page', route: '/docs' },
      { ...under, file: 'docs/deeper/page.tsx', plain: 'page', route: '/docs/deeper' },
      { ...under, file: 'docs/reports/route.ts', plain: 'handler', route: '/docs/reports' },
    ]);
  });

  it('registers no such route where no middleware is around it', async () => {
    const { app, compiled } = await compiledWith({
      'app/account/page.tsx': PAGE,
      'app/api/items/[itemId]/route.ts': HANDLER,
    });

    expect(compiled.refusals).toStrictEqual([]);
    expect(plainOf(compiled, app)).toStrictEqual([]);
  });

  it('writes them into the host’s registry and the authority’s, of a type the application’s check accepts, and the authority takes them as routes of no root', async () => {
    const { app, compiled } = await compiledWith({ ...UNDER, 'app/account/page.tsx': PAGE });
    writeOutputs(compiled.outputs, app.out);

    expect(output(compiled, app, 'routes.ts')).toContain(
      'export const routes: readonly RegisteredRoute[] = [',
    );
    expect(output(compiled, app, 'authority.mts')).toContain(
      "import type { MiddlewareProgram, RegisteredRoute } from '@arkorlab/reactive-state/routing';",
    );
    expect(loadedRoutes(app)).toStrictEqual({
      plain: ['/', '/account'],
      routes: ['/boards/[projectId]', '/projects/[projectId]', '/projects/[projectId]/publication'],
    });
    expect(diagnosticsOfOutputs(app)).toStrictEqual([]);
  });

  it('refuses a page or a route handler under route middleware that no rewrite places exactly: a catch-all, a parallel route’s slot, an intercepting route', async () => {
    const cases = [
      ['app/docs/[...slug]/page.tsx', PAGE, '[...slug]'],
      ['app/@modal/sign-in/page.tsx', PAGE, '@modal'],
      ['app/feed/(..)photo/[id]/page.tsx', PAGE, '(..)photo'],
      ['app/files/[[...rest]]/route.ts', HANDLER, '[[...rest]]'],
    ] as const;
    for (const [where, text, segment] of cases) {
      const { compiled } = await compiledWith({ 'app/middleware.ts': ENVELOPE, [where]: text });
      const refusal = refusalOf(compiled);

      expect(refusal.fileName).toBe(where);
      expect([refusal.line, refusal.column]).toStrictEqual([1, 1]);
      expect(refusal.reason).toContain(
        `\`${where.slice('app/'.length)}\` is under route middleware (\`(app)\`), which runs around every request of the routes under it, but no rewrite places it exactly: its segment \`${segment}\``,
      );
    }
  });

  it('refuses members a page of no reactive root prerenders under middleware, by itself or by a layout along it, and a route handler’s, at the export', async () => {
    const page = file(PAGE, MEMBERS);
    const handler = file(HANDLER, MEMBERS);
    const cases = [
      [{ 'app/account/[tab]/page.tsx': page }, 'app/account/[tab]/page.tsx', page],
      [
        { 'app/account/[tab]/layout.tsx': MEMBERS, 'app/account/[tab]/page.tsx': PAGE },
        'app/account/[tab]/layout.tsx',
        MEMBERS,
      ],
      [{ 'app/api/[tab]/route.ts': handler }, 'app/api/[tab]/route.ts', handler],
    ] as const;
    for (const [files, where, text] of cases) {
      const { compiled } = await compiledWith({ ...UNDER, ...files });
      const refusal = refusalOf(compiled);
      const at = positionOf(text, 'export async function generateStaticParams');

      expect(refusal.fileName).toBe(where);
      expect([refusal.line, refusal.column]).toStrictEqual([at.line, at.column]);
      expect(refusal.reason).toContain(
        '(`generateStaticParams`), which route middleware is around',
      );
    }
  });

  it('refuses a delivered dynamic route whose rewrite would take the requests of a more specific one no middleware is around, and none that would not', async () => {
    const shadowing = await compiledWith({
      'app/(guarded)/[section]/[id]/page.tsx': PAGE,
      'app/(guarded)/middleware.ts': ENVELOPE,
      'app/admin/[id]/page.tsx': PAGE,
    });
    // The other way about, the delivered route is the more specific: Next.js matches it first too.
    const specific = await compiledWith({
      'app/(guarded)/admin/[id]/page.tsx': PAGE,
      'app/(guarded)/middleware.ts': ENVELOPE,
      'app/[section]/[id]/page.tsx': PAGE,
    });
    const refusal = refusalOf(shadowing.compiled);

    expect(refusal.fileName).toBe('app/(guarded)/[section]/[id]/page.tsx');
    expect(refusal.reason).toContain(
      '`/[section]/[id]` is delivered through its route middleware by a rewrite Next.js runs before its dynamic routes, which would take the requests of `/admin/[id]` (`admin/[id]/page.tsx`) — a route Next.js matches first, with no middleware around it',
    );
    expect(specific.compiled.refusals).toStrictEqual([]);
  });

  it('refuses a delivered dynamic route whose rewrite would take the requests of a more specific route of the Pages Router, an API route among them, and none of its own files or its static pages', async () => {
    const page = file('export default function Page() {', '  return null;', '}');
    const hub = {
      'app/(guarded)/hub/[section]/[id]/page.tsx': PAGE,
      'app/(guarded)/middleware.ts': ENVELOPE,
    };
    const shadowing = await compiledWith({ ...hub, 'pages/hub/admin/[id].tsx': page });
    const handled = await compiledWith({
      'app/(guarded)/[a]/[b]/[c]/[d]/page.tsx': PAGE,
      'app/(guarded)/middleware.ts': ENVELOPE,
      'pages/api/v1/[name]/[b].ts': file('export default function handler() {}'),
    });
    const none = await compiledWith({
      ...hub,
      'pages/_app.tsx': page,
      'pages/_document.tsx': page,
      'pages/hub/admin/new.tsx': page,
      'pages/index.tsx': page,
    });

    expect(refusalOf(shadowing.compiled).reason).toContain(
      "`/hub/[section]/[id]` is delivered through its route middleware by a rewrite Next.js runs before its dynamic routes, which would take the requests of `/hub/admin/[id]` (`pages/hub/admin/[id].tsx`, of the Pages Router) — a route Next.js matches first, with no middleware around it — and deliver them as `/hub/[section]/[id]`'s, through its middleware. Give the two routes paths that do not overlap.",
    );
    expect(refusalOf(handled.compiled).reason).toContain(
      'which would take the requests of `/api/v1/[name]/[b]` (`pages/api/v1/[name]/[b].ts`, of the Pages Router)',
    );
    expect(none.compiled.refusals).toStrictEqual([]);
  });

  it('refuses a metadata file written as code under a guard, and serves one under an envelope alone, or one of no code, as Next.js does', async () => {
    const image = file(
      'export default function Image(): Response {',
      "  return new Response('…');",
      '}',
    );
    const guarded = await compiledWith({ ...UNDER, 'app/account/opengraph-image.tsx': image });
    const enveloped = await compiledWith({
      ...UNDER,
      'app/account/icon.png': 'png',
      'app/opengraph-image.tsx': image,
      'app/sitemap.ts': file('export default function sitemap() {', '  return [];', '}'),
    });
    const refusal = refusalOf(guarded.compiled);

    expect(refusal.fileName).toBe('app/account/opengraph-image.tsx');
    expect(refusal.reason).toContain(
      '`app/account/opengraph-image.tsx` is a metadata file written as code under the guard of `app/account/middleware.ts`',
    );
    expect(enveloped.compiled.refusals).toStrictEqual([]);
  });
});
