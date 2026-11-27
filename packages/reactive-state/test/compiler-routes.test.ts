import { rm } from 'node:fs/promises';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Compiled, compileApp, openTypeScript, writeOutputs } from '../src/compiler/index.ts';
import { scanApp } from '../src/compiler/route-scan.ts';
import type { RouteRegistration } from '../src/routing.ts';
import {
  application,
  type Application,
  compiledApp,
  node,
  output,
  positionOf,
  refusalOf,
  removed,
  source,
  variant,
  variantSource,
} from './fixtures/application.ts';

/**
 * What a compile learns of an application's routes from its pages, with nothing of the
 * application's naming them: a page that resolves its route's params and hands
 * them to one reactive root registers the route — blocking where it awaits them outside any
 * `<Suspense>` — and whether its document may be one artifact for every visitor, judged of the
 * code that renders it: the root's components, the layouts around it, the page itself.
 */

const BOARD = 'app/boards/[projectId]/page.tsx';

/** The v3 project page's route: the request's, its root given its search params' values beside its param. */
const PROJECT_ROUTE: RouteRegistration = {
  blocking: false,
  middleware: [],
  page: 'projects/[projectId]/page.tsx',
  params: ['projectId'],
  private: "`components/project` is given props beside its route's params (`filter`, `selectedId`)",
  props: { projectId: 'projectId' },
  root: 'components/project',
  route: '/projects/[projectId]',
  shared: false,
};

const BOARD_ROUTE: RouteRegistration = {
  blocking: true,
  middleware: [],
  page: 'boards/[projectId]/page.tsx',
  params: ['projectId'],
  props: { projectId: 'projectId' },
  root: 'components/public-board',
  route: '/boards/[projectId]',
  shared: true,
};

/** A source file of `lines`. */
function file(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/**
 * A page of the first shape, rendering `root` (an import's specifier) of the `projectId` it is
 * given, of a route of `params`.
 */
function directPage(root: string, params: string): string {
  return file(
    `import Root from '${root}';`,
    '',
    `export default async function Page({ params }: { params: Promise<{ ${params} }> }) {`,
    `  const { ${params.replaceAll(/: string;?/gu, ',').replace(/,\s*$/u, '')} } = await params;`,
    '  return <Root projectId={projectId} />;',
    '}',
  );
}

const BOARD_PAGE = directPage('@/components/public-board.reactive', 'projectId: string;');

/** Why a route is the request's whose `owner` renders a part that reads `useSearchParams`. */
function queriedBy(owner: string): unknown {
  return {
    private: `\`${owner}\` reads the request's query (\`useSearchParams\`), which the server renders it with too`,
    shared: false,
  };
}

/** `text` with a comment more at its end: another source, of the same code. */
function remarked(text: string): string {
  return `${text}// remarked\n`;
}

/**
 * A layout, a template or a loading state that renders what `lines` make of `shown` around its
 * children.
 */
function wrapperOf(...lines: readonly string[]): string {
  return file(
    "import type { ReactNode } from 'react';",
    ...lines,
    '',
    'export default async function W({ children }: { children?: ReactNode }) {',
    '  return <section data-shown={await shown()}>{children}</section>;',
    '}',
  );
}

/** A layout that renders what `call`, an export of `module` (a path in `src`), answers of `'k'`. */
function callingLayout(module: string, call: string): string {
  return wrapperOf(
    `import { ${call} } from '@/${module}';`,
    `const shown = async (): Promise<string> => String(${call}('k'));`,
  );
}

/** A Client Component's module, `'use client'`, of `lines`. */
function clientModule(...lines: readonly string[]): string {
  return file("'use client';", '', ...lines);
}

/** A layout that renders `element` ahead of its children, of what `lines` import. */
function layoutRendering(element: string, ...lines: readonly string[]): string {
  return file(
    "import type { ReactNode } from 'react';",
    ...lines,
    '',
    'export default function L({ children }: { children: ReactNode }) {',
    '  return (',
    '    <section>',
    `      ${element}`,
    '      {children}',
    '    </section>',
    '  );',
    '}',
  );
}

/**
 * The board's root, `components/public-board`, calling `call`, an export of `@/todos`, of its param
 * as its server part runs: code the authority evaluates.
 */
async function rootCalling(call: string): Promise<string> {
  const root = await source('components/public-board.reactive.tsx');
  const imported = "import { requirePublishedProject } from '@/publication';";
  const awaited = '  const project = await requirePublishedProject(projectId);';
  return variant(
    variant(root, imported, `${imported}\nimport { ${call} } from '@/todos';`),
    awaited,
    `${awaited}\n  await ${call}(projectId);`,
  );
}

/** A module that removes a record through a table of `name`, an export of `module`. */
function removingThrough(module: string, name: string): string {
  return file(
    `import { ${name} } from '@/${module}';`,
    '',
    'export function removeTodo(id: string) {',
    `  return ${name}.todos.delete(id);`,
    '}',
  );
}

/** A layout that renders its children as they are, and exports what `lines` export beside them. */
function layoutExporting(...lines: readonly string[]): string {
  return file(
    "import type { ReactNode } from 'react';",
    '',
    ...lines,
    '',
    'export default function L({ children }: { children: ReactNode }) {',
    '  return children;',
    '}',
  );
}

interface Manifested {
  readonly routes: readonly RouteRegistration[];
  readonly middleware: readonly unknown[];
  readonly buildId: string;
}

function manifestOf(compiled: Compiled, app: Application): Manifested {
  return JSON.parse(output(compiled, app, 'manifest.json')) as Manifested;
}

/** The registration of `route` a compile wrote, or none. */
function routeOf(
  compiled: Compiled,
  app: Application,
  route: string,
): RouteRegistration | undefined {
  return manifestOf(compiled, app).routes.find((each) => each.route === route);
}

/** Runs `body`, an expression of `registry` — the authority's registry the compile wrote — in Node. */
function inAuthority(app: Application, body: string): unknown {
  const paths = path.join(import.meta.dirname, '../src/authority/paths.ts');
  const ran = node(
    [
      `import { registerPaths } from ${JSON.stringify(paths)};`,
      `registerPaths(${JSON.stringify(app.tsconfig)});`,
      `const registry = await import(${JSON.stringify(path.join(app.out, 'authority.mts'))});`,
      `process.stdout.write(JSON.stringify(${body}));`,
    ].join('\n'),
    app.root,
  );
  if (ran.status !== 0) {
    throw new Error(ran.stderr);
  }
  return JSON.parse(ran.stdout) as unknown;
}

describe('the compile of Project Todo v4’s routes, as its component-style input writes them (C)', () => {
  let api: API;
  let app: Application;
  let compiled: Compiled;
  const read = (name: string): string =>
    output(compiled, app, name).replaceAll(compiled.buildId, 'b_BUILD');

  beforeAll(async () => {
    api = openTypeScript();
    app = await application();
    compiled = compiledApp(app, api);
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    await removed(app);
  });

  it('registers the board, the project and the publication settings from their pages, with no registry written by hand', () => {
    expect(compiled.refusals).toStrictEqual([]);
    expect(manifestOf(compiled, app).routes).toStrictEqual([
      BOARD_ROUTE,
      PROJECT_ROUTE,
      {
        blocking: false,
        middleware: [],
        page: 'projects/[projectId]/publication/page.tsx',
        params: ['projectId'],
        private: "`components/publication-settings` reads the session's identity (`requireUser`)",
        props: { projectId: 'projectId' },
        root: 'components/publication-settings',
        route: '/projects/[projectId]/publication',
        shared: false,
      },
    ]);
    expect(manifestOf(compiled, app).middleware).toStrictEqual([]);
  });

  it('keeps the manifest’s keys sorted, the routes and the middleware among them', () => {
    const keys = Object.keys(manifestOf(compiled, app));

    expect(keys).toStrictEqual(keys.toSorted((a, b) => a.localeCompare(b, 'en')));
    expect(keys).toContain('routes');
    expect(keys).toContain('middleware');
  });

  it('registers the v3 project page as the request’s: its param mapped, its search params’ values given beside it', () => {
    expect(
      manifestOf(compiled, app).routes.find((each) => each.route === '/projects/[projectId]'),
    ).toStrictEqual(PROJECT_ROUTE);
    expect(read('components/project.root.tsx')).toContain(
      'return renderRoot({ component: "components/project", elements, props, route: "/projects/[projectId]", update, view });',
    );
  });

  it('names the route in the entry of each registered root, and in no other', () => {
    expect(read('components/public-board.root.tsx')).toContain(
      'return renderRoot({ component: "components/public-board", elements, props, route: "/boards/[projectId]", update, view });',
    );
    expect(read('components/publication-settings.root.tsx')).toContain(
      'route: "/projects/[projectId]/publication", update, view });',
    );
    expect(read('components/public-board-stats.root.tsx')).not.toContain('route:');
  });

  it('writes the routes into the authority’s registry and the host’s, with no middleware', () => {
    const registry = read('authority.mts');
    const routes = read('routes.ts');

    expect(registry).toContain(
      "import type { MiddlewareProgram, RouteRegistration } from '@arkorlab/reactive-state/routing';",
    );
    expect(registry).toContain('export const routes: readonly RouteRegistration[] = [');
    expect(registry).toContain(
      'export const middleware: Readonly<Record<string, MiddlewareProgram | null>> = {};',
    );
    expect(routes).toContain('export const routes: readonly RouteRegistration[] = [');
    expect(routes).toContain(
      'export const envelopes: Readonly<Record<string, MiddlewareEnvelope>> = {};',
    );
  });

  it('writes the app route handed the host’s registry of the routes and their envelopes', () => {
    const route = compiled.outputs.get(
      path.join(app.appDir, 'api/reactive-state/[...path]/route.ts'),
    );

    expect(route).toBe(
      file(
        "// Generated by @arkorlab/reactive-state from the application's components. Do not edit: change the components and compile it again.",
        "import { routeHandlers } from '@arkorlab/reactive-state/next/route';",
        '',
        "import { envelopes, routes } from '../../../../../.reactive/routes';",
        '',
        'export const { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } = routeHandlers({ envelopes, routes });',
      ),
    );
  });

  it('writes a registry the Node authority loads, its routes as the manifest says them', () => {
    writeOutputs(compiled.outputs, app.out);

    expect(
      inAuthority(app, '{ routes: registry.routes, middleware: registry.middleware }'),
    ).toStrictEqual({ middleware: {}, routes: manifestOf(compiled, app).routes });
  });
});

describe('the compile of a route’s page, its shapes and its name', () => {
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
    gone: readonly string[] = [],
  ): Promise<{ app: Application; compiled: Compiled }> {
    const app = await application(files);
    apps.push(app);
    for (const each of gone) {
      await rm(path.join(app.src, each), { force: true, recursive: true });
    }
    return { app, compiled: compiledApp(app, api) };
  }

  /**
   * What a compile of `page` at `route` refuses, and registers of the route: the page compiled in an
   * application of its own, with no board beside it — a root is one route's.
   */
  async function registered(
    route: string,
    page: string,
  ): Promise<{ readonly refusals: unknown; readonly registration: unknown }> {
    const { app, compiled } = await compiledWith({ [`app${route}/page.tsx`]: page }, [
      'app/boards',
    ]);
    return { refusals: compiled.refusals, registration: routeOf(compiled, app, route) };
  }

  it('registers the board under another name alike: no route is named in the framework', async () => {
    const { app, compiled } = await compiledWith(
      { 'app/status/[projectId]/page.tsx': await source(BOARD) },
      ['app/boards'],
    );

    expect(compiled.refusals).toStrictEqual([]);
    expect(routeOf(compiled, app, '/status/[projectId]')).toStrictEqual({
      ...BOARD_ROUTE,
      page: 'status/[projectId]/page.tsx',
      route: '/status/[projectId]',
    });
    expect(routeOf(compiled, app, '/boards/[projectId]')).toBeUndefined();
  });

  it('reads a param destructured under another name, and leaves route groups out of the route', async () => {
    const page = variant(
      variant(
        BOARD_PAGE,
        'const { projectId } = await params;',
        'const { projectId: id } = await params;',
      ),
      'projectId={projectId}',
      'projectId={id}',
    );
    const { app, compiled } = await compiledWith(
      { 'app/(public)/shared/[projectId]/page.tsx': page },
      ['app/boards'],
    );

    expect(routeOf(compiled, app, '/shared/[projectId]')).toMatchObject({
      page: '(public)/shared/[projectId]/page.tsx',
      params: ['projectId'],
      props: { projectId: 'projectId' },
      root: 'components/public-board',
    });
  });

  it('leaves a route group out of the route whatever its name holds, under a guard too', async () => {
    const guard = file(
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      "import { requirePublishedProject } from '@/publication';",
      '',
      'export default (async ({ params }, next) => {',
      '  await requirePublishedProject(params.projectId);',
      '  return next();',
      '}) satisfies RouteMiddleware<{ projectId: string }>;',
    );
    const { app, compiled } = await compiledWith(
      {
        'app/(release.v2)/shared/[projectId]/middleware.ts': guard,
        'app/(release.v2)/shared/[projectId]/page.tsx': BOARD_PAGE,
      },
      ['app/boards'],
    );

    expect(compiled.refusals).toStrictEqual([]);
    expect(routeOf(compiled, app, '/shared/[projectId]')).toMatchObject({
      guarded: true,
      middleware: ['(release.v2)/shared/[projectId]'],
      page: '(release.v2)/shared/[projectId]/page.tsx',
    });
  });

  it('reads the segments of a page’s directory as Next.js reads them: a group of any name, an intercepting route by its markers, any other parentheses as written', async () => {
    const directories = [
      '(release.v2)/a/[projectId]',
      '(.hidden)/b/[projectId]',
      'c(2)/[projectId]',
      '(d)e/[projectId]',
      '(.)f/[projectId]',
      '(..)(..)g/[projectId]',
      '(...)h/[projectId]',
      'i/@slot/[projectId]',
    ];
    const app = await application(
      Object.fromEntries(
        directories.map((each) => [`app/${each}/page.tsx`, 'export default function P() {}\n']),
      ),
    );
    apps.push(app);
    const { pages } = scanApp(path.join(app.src, 'app'), app.out);
    const routes = pages
      .filter(({ directory }) => directories.includes(directory))
      .map(({ directory, route }) => [directory, route?.route]);

    expect(Object.fromEntries(routes)).toStrictEqual({
      '(...)h/[projectId]': undefined,
      '(.)f/[projectId]': undefined,
      '(..)(..)g/[projectId]': undefined,
      '(.hidden)/b/[projectId]': '/b/[projectId]',
      '(d)e/[projectId]': '/(d)e/[projectId]',
      '(release.v2)/a/[projectId]': '/a/[projectId]',
      'c(2)/[projectId]': '/c(2)/[projectId]',
      'i/@slot/[projectId]': undefined,
    });
  });

  it('registers a page of the app’s own directory as `/`, and the params of every dynamic segment in order', async () => {
    const root = file(
      "import PublicBoard from '@/components/public-board.reactive';",
      '',
      'export default async function Home({ params }: { params: Promise<Record<string, never>> }) {',
      '  const {} = await params;',
      '  return <PublicBoard />;',
      '}',
    );
    const nested = directPage(
      '@/components/public-board.reactive',
      'team: string; projectId: string;',
    );
    // A root is one route's: each page compiled in an application of its own.
    const home = await compiledWith({ 'app/page.tsx': root }, ['app/boards']);
    const { app, compiled } = await compiledWith(
      { 'app/teams/[team]/boards/[projectId]/page.tsx': nested },
      ['app/boards'],
    );

    expect(routeOf(home.compiled, home.app, '/')).toMatchObject({
      page: 'page.tsx',
      params: [],
      props: {},
    });
    expect(routeOf(compiled, app, '/teams/[team]/boards/[projectId]')).toMatchObject({
      params: ['team', 'projectId'],
      props: { projectId: 'projectId' },
    });
  });

  it('registers a page whose root is not given every param of its route as the request’s, never shared: a view is one of all of them', async () => {
    const nested = directPage(
      '@/components/public-board.reactive',
      'team: string; projectId: string;',
    );
    const { app, compiled } = await compiledWith(
      { 'app/teams/[team]/boards/[projectId]/page.tsx': nested },
      ['app/boards'],
    );

    expect(compiled.refusals).toStrictEqual([]);
    expect(routeOf(compiled, app, '/teams/[team]/boards/[projectId]')).toMatchObject({
      private: '`components/public-board` is not given every param of its route (`team`)',
      shared: false,
    });
  });

  it('registers a page of more than its root of its params as the request’s, never shared: a constant, its search params, JSX around the root', async () => {
    const pages: Readonly<Record<string, string>> = {
      'app/literal/[projectId]/page.tsx': variant(
        BOARD_PAGE,
        'projectId={projectId}',
        'projectId="p1"',
      ),
      'app/searched/[projectId]/page.tsx': variant(
        BOARD_PAGE,
        '{ params }: { params: Promise<{ projectId: string; }> }',
        '{ params, searchParams }: { params: Promise<{ projectId: string; }>; searchParams: Promise<unknown> }',
      ),
      'app/wrapped/[projectId]/page.tsx': variant(
        BOARD_PAGE,
        'return <Root projectId={projectId} />;',
        'return <main><Root projectId={projectId} /></main>;',
      ),
    };
    // A root is one route's: each page compiled in an application of its own.
    const of = async (route: string): Promise<Readonly<Record<string, unknown>>> => {
      const name = `app${route}/page.tsx`;
      const { app, compiled } = await compiledWith({ [name]: pages[name] ?? '' }, ['app/boards']);
      const { private: reason, props, shared } = routeOf(compiled, app, route) ?? {};
      return { private: reason, props, refusals: compiled.refusals, shared };
    };

    await expect(of('/literal/[projectId]')).resolves.toStrictEqual({
      private: "`components/public-board` is given props beside its route's params (`projectId`)",
      props: {},
      refusals: [],
      shared: false,
    });
    await expect(of('/searched/[projectId]')).resolves.toStrictEqual({
      private: 'the page reads its `searchParams`',
      props: { projectId: 'projectId' },
      refusals: [],
      shared: false,
    });
    await expect(of('/wrapped/[projectId]')).resolves.toStrictEqual({
      private: 'the page renders more than its root of its params',
      props: { projectId: 'projectId' },
      refusals: [],
      shared: false,
    });
  });

  it('registers a page whose root is given its search params’ values, computed and conditionally spread', async () => {
    const filters = file(
      "import type { TodoFilter } from '@/navigation';",
      '',
      'export function normalizeFilter(value: string | undefined): TodoFilter {',
      "  return value === 'active' || value === 'done' ? value : 'all';",
      '}',
    );
    const page = file(
      "import Project from '@/components/project.reactive';",
      "import { normalizeFilter } from '@/filters';",
      '',
      'export default async function Lists({ params, searchParams }: {',
      '  params: Promise<{ projectId: string }>;',
      '  searchParams: Promise<Record<string, string | undefined>>;',
      '}) {',
      '  const { projectId } = await params;',
      '  const { filter, todo } = await searchParams;',
      '  return (',
      '    <Project',
      '      projectId={projectId}',
      '      filter={normalizeFilter(filter)}',
      '      {...(todo === undefined ? {} : { selectedId: todo })}',
      '    />',
      '  );',
      '}',
    );
    const { app, compiled } = await compiledWith(
      { 'app/lists/[projectId]/page.tsx': page, 'filters.ts': filters },
      ['app/projects/[projectId]/page.tsx'],
    );

    expect(compiled.refusals).toStrictEqual([]);
    expect(routeOf(compiled, app, '/lists/[projectId]')).toStrictEqual({
      ...PROJECT_ROUTE,
      blocking: true,
      page: 'lists/[projectId]/page.tsx',
      route: '/lists/[projectId]',
    });
  });

  it('registers a page that hands a function of its own its search params under the name of its params, whole, as the request’s: the root is given what the function reads of what it was handed', async () => {
    const page = file(
      "import PublicBoard from '@/components/public-board.reactive';",
      '',
      'export default function Page({ params, searchParams }: {',
      '  params: Promise<{ projectId: string }>;',
      '  searchParams: Promise<{ projectId: string }>;',
      '}) {',
      '  return <Board params={searchParams} />;',
      '}',
      '',
      'async function Board(props: { params: Promise<{ projectId: string }> }) {',
      '  const { projectId } = await props.params;',
      '  return <PublicBoard projectId={projectId} />;',
      '}',
    );
    const { app, compiled } = await compiledWith({ 'app/swapped/[projectId]/page.tsx': page }, [
      'app/boards',
    ]);

    expect(compiled.refusals).toStrictEqual([]);
    expect(routeOf(compiled, app, '/swapped/[projectId]')).toStrictEqual({
      blocking: true,
      middleware: [],
      page: 'swapped/[projectId]/page.tsx',
      params: ['projectId'],
      private: "`components/public-board` is given props beside its route's params (`projectId`)",
      props: {},
      root: 'components/public-board',
      route: '/swapped/[projectId]',
      shared: false,
    });
  });

  it('registers a page that spreads its props whole into a function of its own the root of its params, each prop the param it is given', async () => {
    const page = file(
      "import { Suspense } from 'react';",
      "import PublicBoard from '@/components/public-board.reactive';",
      '',
      'type Props = { params: Promise<{ projectId: string }> };',
      '',
      'export default function Page(props: Props) {',
      '  return (',
      '    <Suspense fallback={null}>',
      '      <Board {...props} />',
      '    </Suspense>',
      '  );',
      '}',
      '',
      'async function Board(props: Props) {',
      '  const { projectId } = await props.params;',
      '  return <PublicBoard projectId={projectId} />;',
      '}',
    );
    const { app, compiled } = await compiledWith({ 'app/spread/[projectId]/page.tsx': page }, [
      'app/boards',
    ]);

    expect(compiled.refusals).toStrictEqual([]);
    expect(routeOf(compiled, app, '/spread/[projectId]')).toStrictEqual({
      blocking: false,
      middleware: [],
      page: 'spread/[projectId]/page.tsx',
      params: ['projectId'],
      private: 'the page renders more than its root of its params',
      props: { projectId: 'projectId' },
      root: 'components/public-board',
      route: '/spread/[projectId]',
      shared: false,
    });
  });

  it('registers a page of no params whose root is given a constant of its file as the request’s', async () => {
    const page = file(
      "import { Suspense } from 'react';",
      "import PublicBoard from '@/components/public-board.reactive';",
      '',
      "const DEMO = 'p1';",
      '',
      'export default function Demo() {',
      '  return (',
      '    <Suspense fallback={null}>',
      '      <PublicBoard projectId={DEMO} />',
      '    </Suspense>',
      '  );',
      '}',
    );
    const { app, compiled } = await compiledWith({ 'app/demo/page.tsx': page }, ['app/boards']);

    expect(routeOf(compiled, app, '/demo')).toStrictEqual({
      blocking: false,
      middleware: [],
      page: 'demo/page.tsx',
      params: [],
      private: "`components/public-board` is given props beside its route's params (`projectId`)",
      props: {},
      root: 'components/public-board',
      route: '/demo',
      shared: false,
    });
  });

  it('registers no page whose root is given a value computed of a param, or of a module’s, and refuses none', async () => {
    const pages = {
      'app/computed/[projectId]/page.tsx': variant(
        BOARD_PAGE,
        'projectId={projectId}',
        'projectId={projectId.trim()}',
      ),
      'app/imported/[projectId]/page.tsx': variant(
        variant(
          BOARD_PAGE,
          "import Root from '@/components/public-board.reactive';",
          "import Root from '@/components/public-board.reactive';\nimport { DEFAULT_PROJECT } from '@/defaults';",
        ),
        'projectId={projectId}',
        'projectId={DEFAULT_PROJECT}',
      ),
      'app/mapped/[projectId]/page.tsx': variant(
        BOARD_PAGE,
        'return <Root projectId={projectId} />;',
        'return <>{[projectId].map((id) => <Root key={id} projectId={id} />)}</>;',
      ),
      'defaults.ts': "export const DEFAULT_PROJECT = 'p1';\n",
    };
    const { app, compiled } = await compiledWith(pages);
    const routes = manifestOf(compiled, app).routes.map((each) => each.route);

    expect(compiled.refusals).toStrictEqual([]);
    expect(routes).not.toContain('/computed/[projectId]');
    expect(routes).not.toContain('/imported/[projectId]');
    expect(routes).not.toContain('/mapped/[projectId]');
  });

  it('registers no page that renders its root on some of the paths it renders alone, and refuses none — under `&&` or `||`, in a branch of `?:` the other of which renders none, past an early `return`, in a callback, in a function of its own that does so — but registers one that renders it on each, in both branches of `?:`', async () => {
    const returned = 'return <Root projectId={projectId} />;';
    const pages: Readonly<Record<string, string>> = {
      '/anded/[projectId]': variant(
        BOARD_PAGE,
        returned,
        'return <>{false && <Root projectId={projectId} />}</>;',
      ),
      '/called/[projectId]': variant(
        BOARD_PAGE,
        returned,
        'return <>{[0].map(() => <Root projectId={projectId} />)}</>;',
      ),
      '/chosen/[projectId]': variant(
        BOARD_PAGE,
        returned,
        'return projectId.length > 0 ? <Root projectId={projectId} /> : null;',
      ),
      '/nested/[projectId]': file(
        "import { Suspense } from 'react';",
        "import Root from '@/components/public-board.reactive';",
        '',
        'type Props = { params: Promise<{ projectId: string }> };',
        '',
        'export default function Page(props: Props) {',
        '  return (',
        '    <Suspense fallback={null}>',
        '      <Board {...props} />',
        '    </Suspense>',
        '  );',
        '}',
        '',
        'async function Board(props: Props) {',
        '  const { projectId } = await props.params;',
        '  return projectId.length > 0 ? <Root projectId={projectId} /> : null;',
        '}',
      ),
      '/ored/[projectId]': variant(
        BOARD_PAGE,
        returned,
        'return <>{projectId.length === 0 || <Root projectId={projectId} />}</>;',
      ),
      '/returned/[projectId]': variant(
        BOARD_PAGE,
        returned,
        `if (projectId.length === 0) {\n    return null;\n  }\n  ${returned}`,
      ),
    };
    for (const [route, page] of Object.entries(pages)) {
      await expect(registered(route, page)).resolves.toStrictEqual({
        refusals: [],
        registration: undefined,
      });
    }
    const branched = variant(
      BOARD_PAGE,
      returned,
      'return projectId.length > 0 ? <Root projectId={projectId} /> : <main><Root projectId={projectId} /></main>;',
    );

    await expect(registered('/branched/[projectId]', branched)).resolves.toMatchObject({
      refusals: [],
      registration: {
        private: 'the page renders more than its root of its params',
        root: 'components/public-board',
        shared: false,
      },
    });
  });

  it('registers nothing of a catch-all, a parallel route’s slot, an intercepting route or a private folder', async () => {
    const catchAll = directPage('@/components/public-board.reactive', 'projectId: string;');
    const { app, compiled } = await compiledWith({
      'app/(.)intercepted/[projectId]/page.tsx': catchAll,
      'app/_private/[projectId]/page.tsx': catchAll,
      'app/all/[...projectId]/page.tsx': catchAll,
      'app/slotted/@panel/[projectId]/page.tsx': catchAll,
    });

    expect(compiled.refusals).toStrictEqual([]);
    expect(manifestOf(compiled, app).routes.map((each) => each.route)).toStrictEqual([
      '/boards/[projectId]',
      '/projects/[projectId]',
      '/projects/[projectId]/publication',
    ]);
  });

  it('registers the route of a folder `%5F` escapes at the segment Next.js serves it at, `_admin`', async () => {
    const { app, compiled } = await compiledWith(
      { 'app/%5Fadmin/[projectId]/page.tsx': await source(BOARD) },
      ['app/boards'],
    );

    expect(compiled.refusals).toStrictEqual([]);
    expect(routeOf(compiled, app, '/_admin/[projectId]')).toStrictEqual({
      ...BOARD_ROUTE,
      page: '%5Fadmin/[projectId]/page.tsx',
      route: '/_admin/[projectId]',
    });
  });

  it.each(['proxy.ts', 'middleware.js'])(
    'shares no route of an application with a proxy, `%s` beside its app directory, which runs ahead of every request',
    async (proxy) => {
      const { app, compiled } = await compiledWith({
        [proxy]: 'export function proxy() {}\n',
      });

      expect(compiled.refusals).toStrictEqual([]);
      expect(routeOf(compiled, app, '/boards/[projectId]')).toStrictEqual({
        ...BOARD_ROUTE,
        private: `the application has a proxy, \`${proxy}\`, which runs ahead of every request and may change any response`,
        shared: false,
      });
      expect(manifestOf(compiled, app).routes.filter((route) => route.shared)).toStrictEqual([]);
    },
  );

  it('refuses a page or a route handler under a dynamic segment named `__proto__`, whose param Next.js hands neither', async () => {
    const { compiled } = await compiledWith({
      'app/feeds/[__proto__]/route.ts': file(
        'export function GET() {',
        "  return new Response('');",
        '}',
      ),
      'app/pins/[__proto__]/page.tsx': file(
        'export default function Page() {',
        '  return <p />;',
        '}',
      ),
    });

    expect(compiled.refusals.map((each) => each.fileName)).toStrictEqual([
      'app/pins/[__proto__]/page.tsx',
      'app/feeds/[__proto__]/route.ts',
    ]);
    expect(compiled.refusals[0]?.reason).toContain(
      '`pins/[__proto__]/page.tsx` is under the dynamic segment `[__proto__]`, whose param Next.js hands it none of',
    );
  });

  it('makes a page none that blocks where a loading state stands around it', async () => {
    const loading = file('export default function Loading() {', '  return <p>…</p>;', '}');
    const { app, compiled } = await compiledWith({ 'app/boards/loading.tsx': loading });

    expect(routeOf(compiled, app, '/boards/[projectId]')).toMatchObject({
      blocking: false,
      shared: true,
    });
  });

  it('refuses one root rendered under two chains of route middleware', async () => {
    const middleware = file(
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      '',
      'export default (async (_context, next) => next()) satisfies RouteMiddleware;',
    );
    // A page of no shape the compile registers, under a chain of its own.
    const status = variant(
      await source(BOARD),
      'projectId={projectId}',
      'projectId={projectId.trim()}',
    );
    const { compiled } = await compiledWith({
      'app/status/[projectId]/middleware.ts': middleware,
      'app/status/[projectId]/page.tsx': status,
    });
    const refusal = refusalOf(compiled);
    const at = positionOf(status, 'import PublicBoard');

    expect(refusal.fileName).toBe('app/status/[projectId]/page.tsx');
    expect([refusal.line, refusal.column]).toStrictEqual([at.line, at.column]);
    expect(refusal.reason).toContain(
      '`components/public-board` is rendered under two chains of route middleware: by `/boards/[projectId]` (`boards/[projectId]/page.tsx`) under none, and by `status/[projectId]/page.tsx` under `status/[projectId]`.',
    );
  });

  it('refuses a route under route middleware whose page prerenders its members, but not one under none', async () => {
    const middleware = file(
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      '',
      'export default (async (_context, next) => next()) satisfies RouteMiddleware;',
    );
    const members = `${await source(BOARD)}\nexport async function generateStaticParams() {\n  return [{ projectId: 'p1' }];\n}\n`;
    const plain = await compiledWith({ [BOARD]: members });

    expect(plain.compiled.refusals).toStrictEqual([]);

    const { compiled } = await compiledWith({
      [BOARD]: members,
      'app/boards/middleware.ts': middleware,
    });

    expect(refusalOf(compiled).reason).toContain(
      '`app/boards/[projectId]/page.tsx` prerenders members of `/boards/[projectId]` (`generateStaticParams`), which route middleware is around',
    );
  });

  it('refuses a route under route middleware a layout along which prerenders its members, at the export, however the layout exports them', async () => {
    const middleware = file(
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      '',
      'export default (async (_context, next) => next()) satisfies RouteMiddleware;',
    );
    const params = file(
      'export async function generateStaticParams() {',
      "  return [{ projectId: 'p1' }];",
      '}',
    );
    const cases: readonly (readonly [string, string, string])[] = [
      // The dynamic segment's own layout, naming another module's export.
      [
        'app/boards/[projectId]/layout.tsx',
        layoutExporting("export { generateStaticParams } from '@/params';"),
        'export { generateStaticParams }',
      ],
      // A layout above it, of a segment of no param, which Next.js asks all the same.
      [
        'app/boards/layout.tsx',
        layoutExporting("export const generateStaticParams = async () => [{ projectId: 'p1' }];"),
        'export const generateStaticParams',
      ],
      // Everything of a module of the application's that exports them.
      [
        'app/boards/[projectId]/layout.tsx',
        layoutExporting("export * from '@/params';"),
        'export *',
      ],
    ];
    for (const [name, text, marker] of cases) {
      const { compiled } = await compiledWith({
        [name]: text,
        'app/boards/middleware.ts': middleware,
        'params.ts': params,
      });
      const refusal = refusalOf(compiled);
      const at = positionOf(text, marker);

      expect(refusal.fileName).toBe(name);
      expect([refusal.line, refusal.column]).toStrictEqual([at.line, at.column]);
      expect(refusal.reason).toContain(
        `\`${name}\` prerenders members of \`/boards/[projectId]\` (\`generateStaticParams\`), which route middleware is around`,
      );
    }

    const plain = await compiledWith({
      'app/boards/[projectId]/layout.tsx': layoutExporting("export * from '@/params';"),
      'params.ts': params,
    });

    expect(plain.compiled.refusals).toStrictEqual([]);
  });

  it('refuses no route under route middleware for a `generateStaticParams` its page or a layout keeps to itself, or exports as its default', async () => {
    const middleware = file(
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      '',
      'export default (async (_context, next) => next()) satisfies RouteMiddleware;',
    );
    // What Next.js reads of a segment is its module's exports by name, none of which these are.
    const cases: readonly Readonly<Record<string, string>>[] = [
      {
        [BOARD]: `${await source(BOARD)}\nasync function generateStaticParams() {\n  return [{ projectId: 'p1' }];\n}\n`,
      },
      {
        'app/boards/[projectId]/layout.tsx': layoutExporting(
          "const generateStaticParams = async () => [{ projectId: 'p1' }];",
        ),
      },
      {
        'app/boards/layout.tsx': file(
          "import type { ReactNode } from 'react';",
          '',
          'export default function generateStaticParams({ children }: { children: ReactNode }) {',
          '  return children;',
          '}',
        ),
      },
    ];
    for (const files of cases) {
      const { compiled } = await compiledWith({ ...files, 'app/boards/middleware.ts': middleware });

      expect(compiled.refusals).toStrictEqual([]);
    }
  });

  it('refuses one root two routes render, whose entry would name one of them', async () => {
    const status = await source(BOARD);
    const { compiled } = await compiledWith({ 'app/status/[projectId]/page.tsx': status });

    expect(refusalOf(compiled).reason).toContain(
      '`components/public-board` is the root of two routes, `/boards/[projectId]` (`boards/[projectId]/page.tsx`) and `/status/[projectId]` (`status/[projectId]/page.tsx`)',
    );
  });

  it('refuses a route two pages are', async () => {
    const { compiled } = await compiledWith({
      'app/(other)/boards/[projectId]/page.tsx': await source(BOARD),
    });

    expect(refusalOf(compiled).reason).toBe(
      '`/boards/[projectId]` is the route of two pages, `(other)/boards/[projectId]/page.tsx` and `boards/[projectId]/page.tsx`: a route is one page.',
    );
  });

  it('writes another build where a page, a layout or a route middleware changes, though no output does', async () => {
    const page = await source(BOARD);
    const layout = file(
      "import type { ReactNode } from 'react';",
      '',
      'export default function L({ children }: { children: ReactNode }) {',
      '  return children;',
      '}',
    );
    const middleware = file(
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      '',
      'export default (async (_context, next) => next()) satisfies RouteMiddleware;',
    );
    const base = {
      [BOARD]: page,
      'app/boards/layout.tsx': layout,
      'app/boards/middleware.ts': middleware,
    };
    const builds = await Promise.all(
      [
        base,
        { ...base, [BOARD]: remarked(page) },
        { ...base, 'app/boards/layout.tsx': remarked(layout) },
        { ...base, 'app/boards/middleware.ts': remarked(middleware) },
      ].map(async (files) => {
        const { app, compiled } = await compiledWith(files);
        return { manifest: { ...manifestOf(compiled, app), buildId: '' }, build: compiled.buildId };
      }),
    );

    expect(new Set(builds.map((each) => JSON.stringify(each.manifest))).size).toBe(1);
    expect(new Set(builds.map((each) => each.build)).size).toBe(builds.length);
  });
});

describe('the compile’s judgement of whether a route’s document may be shared', () => {
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

  async function boardWith(
    files: Readonly<Record<string, string>>,
  ): Promise<RouteRegistration | undefined> {
    const app = await application(files);
    apps.push(app);
    const compiled = compiledApp(app, api);

    expect(compiled.refusals).toStrictEqual([]);

    return routeOf(compiled, app, '/boards/[projectId]');
  }

  /** The board's registration, of a compile of `files` that names its database `database`. */
  async function boardOf(
    files: Readonly<Record<string, string>>,
    database: string,
  ): Promise<RouteRegistration | undefined> {
    const app = await application(files);
    apps.push(app);
    const compiled = compileApp({
      api,
      appDir: app.appDir,
      database,
      outDir: app.out,
      srcDir: app.src,
    });

    expect(compiled.refusals).toStrictEqual([]);

    return routeOf(compiled, app, '/boards/[projectId]');
  }

  it('shares no document of a route whose layout reads the request, the absent cookie included', async () => {
    const layout = await variantSource(
      'probe-request-dependent-layout',
      'app/boards/[projectId]/layout.tsx',
    );

    await expect(boardWith({ 'app/boards/[projectId]/layout.tsx': layout })).resolves.toMatchObject(
      {
        private: '`app/boards/[projectId]/layout.tsx` reads the request (`next/headers`)',
        shared: false,
      },
    );
  });

  it('shares no document of a route whose layout reaches the request through a module of the application’s', async () => {
    const viewer = file(
      "import { cookies } from 'next/headers';",
      '',
      'export async function viewer(): Promise<string> {',
      "  return (await cookies()).get('v')?.value ?? '';",
      '}',
    );
    const layout = file(
      "import type { ReactNode } from 'react';",
      "import { viewer } from '@/viewer';",
      '',
      'export default async function L({ children }: { children: ReactNode }) {',
      '  return <section data-viewer={await viewer()}>{children}</section>;',
      '}',
    );

    await expect(
      boardWith({ 'app/boards/layout.tsx': layout, 'viewer.ts': viewer }),
    ).resolves.toMatchObject({
      private: '`app/boards/layout.tsx` reads the request (`next/headers`)',
      shared: false,
    });
  });

  it('shares no document of a route whose layout reads `connection()` or the search params', async () => {
    const connected = file(
      "import { connection } from 'next/server';",
      "import type { ReactNode } from 'react';",
      '',
      'export default async function L({ children }: { children: ReactNode }) {',
      '  await connection();',
      '  return children;',
      '}',
    );

    await expect(boardWith({ 'app/boards/template.tsx': connected })).resolves.toMatchObject({
      private: '`app/boards/template.tsx` reads the request (`connection`)',
    });
  });

  /** The board's registration where `files` are the application's, its reason and whether shared. */
  async function judgedBoard(files: Readonly<Record<string, string>>): Promise<unknown> {
    const registered = await boardWith(files);
    return registered === undefined
      ? undefined
      : { private: registered.private, shared: registered.shared };
  }

  /** A Client Component that renders the request's query as `read` reads it, imported as `imported`. */
  function highlightOf(imported: string, read: string): string {
    return file(
      "'use client';",
      '',
      imported,
      '',
      'export function Highlight() {',
      `  return <mark>{${read}.get('q')}</mark>;`,
      '}',
    );
  }

  /** A layout that renders the Client Component `@/highlight` around the page. */
  const HIGHLIGHTED_LAYOUT = file(
    "import type { ReactNode } from 'react';",
    "import { Highlight } from '@/highlight';",
    '',
    'export default function L({ children }: { children: ReactNode }) {',
    '  return <section><Highlight />{children}</section>;',
    '}',
  );

  it('shares no document of a route whose layout renders a Client Component that reads `useSearchParams` — named as it is, renamed, or of the module whole — as the server renders it with the request’s query too', async () => {
    const imports: readonly (readonly [string, string])[] = [
      ["import { useSearchParams } from 'next/navigation';", 'useSearchParams()'],
      ["import { useSearchParams as useQuery } from 'next/navigation';", 'useQuery()'],
      ["import * as navigation from 'next/navigation';", 'navigation.useSearchParams()'],
      // Next.js's own modules of it, either build.
      ["import { useSearchParams } from 'next/dist/api/navigation';", 'useSearchParams()'],
      [
        "import { useSearchParams } from 'next/dist/esm/client/components/navigation.js';",
        'useSearchParams()',
      ],
    ];
    const judged = [];
    for (const [imported, read] of imports) {
      judged.push(
        await judgedBoard({
          'app/boards/layout.tsx': HIGHLIGHTED_LAYOUT,
          'highlight.tsx': highlightOf(imported, read),
        }),
      );
    }

    expect(judged).toStrictEqual(imports.map(() => queriedBy('app/boards/layout.tsx')));
  });

  it('shares the document of a route whose layout imports Next.js’s navigation for React’s server whole — either module of Next.js’s own that holds it, either build of it — which holds `notFound` and `redirect` but no `useSearchParams`', async () => {
    const specifiers: readonly string[] = [
      'next/dist/api/navigation.react-server',
      'next/dist/client/components/navigation.react-server',
      'next/dist/esm/api/navigation.react-server.js',
      'next/dist/esm/client/components/navigation.react-server',
    ];
    const judged = [];
    for (const specifier of specifiers) {
      const layout = file(
        "import type { ReactNode } from 'react';",
        `import * as navigation from '${specifier}';`,
        '',
        'export default function L({ children }: { children?: ReactNode }) {',
        '  return children ?? navigation.notFound();',
        '}',
      );
      judged.push(await judgedBoard({ 'app/boards/layout.tsx': layout }));
    }

    expect(judged).toStrictEqual(specifiers.map(() => ({ private: undefined, shared: true })));
  });

  it('shares no document of a route whose root renders a Client Component that reads `useSearchParams`, reached from its page', async () => {
    const board = await source('components/public-board.reactive.tsx');
    const highlighted = variant(
      variant(
        board,
        "import { requirePublishedProject } from '@/publication';",
        "import { requirePublishedProject } from '@/publication';\nimport { Highlight } from '@/highlight';",
      ),
      '<PublicBoardLayout title={project.title}>',
      '<PublicBoardLayout title={project.title}>\n      <Highlight />',
    );

    await expect(
      judgedBoard({
        'components/public-board.reactive.tsx': highlighted,
        'highlight.tsx': highlightOf(
          "import { useSearchParams } from 'next/navigation';",
          'useSearchParams()',
        ),
      }),
    ).resolves.toStrictEqual(queriedBy('app/boards/[projectId]/page.tsx'));
  });

  it('shares no document of a route whose layout names `searchParams` as text', async () => {
    const layout = file(
      "import type { ReactNode } from 'react';",
      '',
      'export default function L(props: { children: ReactNode }) {',
      "  const query: unknown = (props as Readonly<Record<string, unknown>>)['searchParams'];",
      '  return <section data-query={String(query)}>{props.children}</section>;',
      '}',
    );

    await expect(judgedBoard({ 'app/boards/layout.tsx': layout })).resolves.toStrictEqual({
      private: '`app/boards/layout.tsx` reads `searchParams`',
      shared: false,
    });
  });

  it('shares no document of a route whose page reaches its search params however it spells them: of no shape a root is shared of, or running more than its root', async () => {
    const head = [
      "import PublicBoard from '@/components/public-board.reactive';",
      "import { titleOf } from '@/titles';",
      '',
      'type Props = {',
      '  params: Promise<{ projectId: string }>;',
      '  searchParams: Promise<Record<string, string | undefined>>;',
      '};',
      '',
    ];
    const page = (parameter: string, ...lines: readonly string[]): string => {
      return file(
        ...head,
        `export default async function Page(${parameter}: Props) {`,
        ...lines,
        '  return <PublicBoard projectId={projectId} />;',
        '}',
      );
    };
    const fromProps = '  const { projectId } = await props.params;';
    const fromParams = '  const { projectId } = await params;';
    const pages: readonly (readonly [string, string])[] = [
      ['by text', page('props', fromProps, "  void (await props['searchParams']);")],
      ['renamed', page('{ params, searchParams: query }', fromParams, '  void query;')],
      ['quoted', page("{ params, 'searchParams': query }", fromParams, '  void query;')],
      ['computed', page("{ params, ['searchParams']: query }", fromParams, '  void query;')],
      ['a rest', page('{ params, ...rest }', fromParams, '  void rest;')],
      ['handed on', page('props', fromProps, '  void (await titleOf(props));')],
      ['spread', page('props', fromProps, '  void { ...props };')],
      [
        'beside',
        file(
          ...head,
          'export default async function Page({ params }: Props) {',
          fromParams,
          '  return <PublicBoard projectId={projectId} />;',
          '}',
          '',
          'export async function generateMetadata(props: Props) {',
          "  return { title: await titleOf({ searchParams: props['searchParams'] }) };",
          '}',
        ),
      ],
    ];
    const titles = file(
      'export async function titleOf(props: { searchParams: Promise<{ q?: string }> }) {',
      '  return (await props.searchParams).q;',
      '}',
    );
    const judged: Record<string, unknown> = {};
    for (const [spelling, text] of pages) {
      judged[spelling] = await judgedBoard({
        'app/boards/[projectId]/page.tsx': text,
        'titles.ts': titles,
      });
    }

    // None is shared: a page of no shape of a page of its root's is no registered route at all,
    // which Next.js renders for each request, and one that runs more than its root is the request's.
    expect(judged).toStrictEqual({
      'a rest': undefined,
      beside: { private: '`app/boards/[projectId]/page.tsx` reads `searchParams`', shared: false },
      'by text': undefined,
      computed: undefined,
      'handed on': undefined,
      quoted: undefined,
      renamed: undefined,
      spread: undefined,
    });
  });

  it('shares no document of a route whose layout reads the request by the module’s file, or by the module of Next.js’s own that holds what it reads, either build of it — and shares one that imports a type of it alone', async () => {
    const cookiesOf = (specifier: string): readonly [string, string] => {
      return [
        wrapperOf(
          `import { cookies } from '${specifier}';`,
          "const shown = async (): Promise<string> => (await cookies()).get('v')?.value ?? '';",
        ),
        'next/headers',
      ];
    };
    const connectionOf = (specifier: string): readonly [string, string] => {
      return [
        wrapperOf(
          `import { connection } from '${specifier}';`,
          'const shown = async (): Promise<string> => { await connection(); return String(1); };',
        ),
        'connection',
      ];
    };
    const layouts: readonly (readonly [string, string])[] = [
      cookiesOf('next/headers.js'),
      cookiesOf('next/dist/server/request/cookies'),
      cookiesOf('next/dist/api/headers'),
      cookiesOf('next/dist/esm/api/headers.js'),
      cookiesOf('next/dist/esm/server/request/cookies'),
      connectionOf('next/server.js'),
      connectionOf('next/dist/server/request/connection.js'),
      connectionOf('next/dist/api/server'),
      connectionOf('next/dist/server/web/exports'),
      connectionOf('next/dist/esm/server/web/exports/index.js'),
    ];
    for (const [layout, read] of layouts) {
      await expect(judgedBoard({ 'app/boards/layout.tsx': layout })).resolves.toStrictEqual({
        private: `\`app/boards/layout.tsx\` reads the request (\`${read}\`)`,
        shared: false,
      });
    }

    const typed = wrapperOf(
      "import { type ReadonlyHeaders } from 'next/headers';",
      "const shown = async (): Promise<string> => ((): ReadonlyHeaders | undefined => undefined)() === undefined ? '' : 'x';",
    );

    await expect(judgedBoard({ 'app/boards/layout.tsx': typed })).resolves.toStrictEqual({
      private: undefined,
      shared: true,
    });
  });

  it('shares no document of a route whose layout reads the request’s headers or cookies, however it names them: renamed, of the module whole, loaded as it runs', async () => {
    const layouts: readonly string[] = [
      wrapperOf(
        "import { cookies as jar } from 'next/headers';",
        "const shown = async (): Promise<string> => (await jar()).get('v')?.value ?? '';",
      ),
      wrapperOf(
        "import * as request from 'next/headers';",
        "const shown = async (): Promise<string> => (await request.headers()).get('x-v') ?? '';",
      ),
      wrapperOf(
        "const shown = async (): Promise<string> => (await (await import('next/headers')).headers()).get('x-v') ?? '';",
      ),
    ];
    const judged = [];
    for (const layout of layouts) {
      judged.push(await judgedBoard({ 'app/boards/layout.tsx': layout }));
    }

    const headed = {
      private: '`app/boards/layout.tsx` reads the request (`next/headers`)',
      shared: false,
    };

    expect(judged).toStrictEqual(layouts.map(() => headed));
  });

  it('shares no document of a route whose layout, template or loading state reads an input nothing tracks, a library or the session’s identity as it renders', async () => {
    const cases: readonly (readonly [string, string, string])[] = [
      [
        'app/boards/layout.tsx',
        wrapperOf('const shown = async (): Promise<number> => Date.now();'),
        '`app/boards/layout.tsx` reads `Date`, an input nothing tracks',
      ],
      [
        'app/boards/[projectId]/template.tsx',
        wrapperOf(
          "const shown = async (): Promise<string> => (await fetch('https://cms.test/banner')).text();",
        ),
        '`app/boards/[projectId]/template.tsx` reads `fetch`, an input nothing tracks',
      ],
      [
        'app/boards/loading.tsx',
        wrapperOf("import { shown } from 'spinners';"),
        '`app/boards/loading.tsx` reads the library `spinners`',
      ],
      [
        'app/boards/layout.tsx',
        wrapperOf(
          "import { currentUser } from '@arkorlab/reactive-state/server';",
          'const shown = async (): Promise<string> => (await currentUser())?.id ?? "";',
        ),
        "`app/boards/layout.tsx` reads the session's identity (`currentUser`)",
      ],
    ];
    for (const [name, text, reason] of cases) {
      await expect(boardWith({ [name]: text })).resolves.toMatchObject({
        private: reason,
        shared: false,
      });
    }
  });

  it('shares no document of a route whose layout renders a reactive component of its own that reads the session’s identity, or renders one that does', async () => {
    const badge = file(
      "import { currentUser } from '@arkorlab/reactive-state/server';",
      '',
      'export default async function ViewerBadge() {',
      '  const user = await currentUser();',
      '  return <p data-testid="viewer">{user === null ? \'\' : user.id}</p>;',
      '}',
    );
    const frame = file(
      "import ViewerBadge from '@/components/viewer-badge.reactive';",
      '',
      'export default async function ViewerFrame() {',
      '  return (',
      '    <aside>',
      '      <ViewerBadge />',
      '    </aside>',
      '  );',
      '}',
    );
    const layouts = [
      layoutRendering(
        '<ViewerBadge />',
        "import ViewerBadge from '@/components/viewer-badge.reactive';",
      ),
      layoutRendering(
        '<ViewerFrame />',
        "import ViewerFrame from '@/components/viewer-frame.reactive';",
      ),
    ];
    for (const layout of layouts) {
      await expect(
        boardWith({
          'app/boards/layout.tsx': layout,
          'components/viewer-badge.reactive.tsx': badge,
          'components/viewer-frame.reactive.tsx': frame,
        }),
      ).resolves.toMatchObject({
        private: "`components/viewer-badge` reads the session's identity (`currentUser`)",
        shared: false,
      });
    }
  });

  it('shares no document of a route whose layout or root renders a Client Component that reads, as the server renders it, an input nothing tracks or a library: its body, a hook’s initializer, a form’s action, a helper it exports', async () => {
    const rendering = clientModule(
      'export function Widget() {',
      '  return <p>{String(Date.now())}</p>;',
      '}',
    );
    const cases: readonly (readonly [string, string])[] = [
      [rendering, '`app/boards/layout.tsx` reads `Date`, an input nothing tracks'],
      [
        clientModule(
          "import { useState } from 'react';",
          '',
          'export function Widget() {',
          '  const [face] = useState(() => Math.random());',
          '  return <p>{face}</p>;',
          '}',
        ),
        '`app/boards/layout.tsx` reads `Math.random`, an input nothing tracks',
      ],
      [
        clientModule(
          "import { nanoid } from 'nanoid';",
          '',
          'export function Widget() {',
          '  return <p>{nanoid()}</p>;',
          '}',
        ),
        '`app/boards/layout.tsx` reads the library `nanoid`',
      ],
      [
        clientModule(
          'export function Widget() {',
          '  return (',
          '    <form',
          '      action={() => {',
          '        console.log(Date.now());',
          '      }}',
          '    />',
          '  );',
          '}',
        ),
        '`app/boards/layout.tsx` reads `Date`, an input nothing tracks',
      ],
      [
        clientModule(
          'export function stamp(): number {',
          '  return Date.now();',
          '}',
          '',
          'export function Widget() {',
          '  return <button type="button" onClick={() => console.log(stamp())}>stamp</button>;',
          '}',
        ),
        '`app/boards/layout.tsx` reads `Date`, an input nothing tracks',
      ],
    ];
    const layout = layoutRendering('<Widget />', "import { Widget } from '@/controls/widget';");
    for (const [text, reason] of cases) {
      await expect(
        boardWith({ 'app/boards/layout.tsx': layout, 'controls/widget.tsx': text }),
      ).resolves.toMatchObject({ private: reason, shared: false });
    }
    const root = variant(
      variant(
        await source('components/public-board.reactive.tsx'),
        "import { requirePublishedProject } from '@/publication';",
        "import { requirePublishedProject } from '@/publication';\nimport { Widget } from '@/controls/widget';",
      ),
      '<PublicBoardLayout title={project.title}>',
      '<PublicBoardLayout title={project.title}>\n      <Widget />',
    );

    await expect(
      boardWith({ 'components/public-board.reactive.tsx': root, 'controls/widget.tsx': rendering }),
    ).resolves.toMatchObject({
      private: '`components/public-board` reads `Date`, an input nothing tracks',
      shared: false,
    });
  });

  it('shares the document of a route whose layout renders a Client Component that reads an input nothing tracks in the browser alone: an event’s handler, an effect, a function only one calls, a callback `useCallback` makes for one, a ref', async () => {
    const widgets = [
      clientModule(
        'export function Widget() {',
        '  return <button type="button" onClick={() => console.log(Date.now())}>stamp</button>;',
        '}',
      ),
      clientModule(
        "import { useEffect } from 'react';",
        '',
        'export function Widget() {',
        '  useEffect(() => {',
        '    console.log(Date.now());',
        '  }, []);',
        '  return <p>tick</p>;',
        '}',
      ),
      clientModule(
        'export function Widget() {',
        '  const stamp = (): void => {',
        '    console.log(Date.now());',
        '  };',
        '  return <button type="button" onClick={() => stamp()}>stamp</button>;',
        '}',
      ),
      clientModule(
        'function stamped(): number {',
        '  return Date.now();',
        '}',
        '',
        'export function Widget() {',
        '  return <button type="button" onClick={() => console.log(stamped())}>stamp</button>;',
        '}',
      ),
      clientModule(
        "import { useCallback } from 'react';",
        '',
        'export function Widget() {',
        '  const stamp = useCallback(() => console.log(Date.now()), []);',
        '  return <button type="button" onClick={stamp}>stamp</button>;',
        '}',
      ),
      clientModule(
        'export function Widget() {',
        '  return <p ref={(node) => console.log(node, Date.now())}>tick</p>;',
        '}',
      ),
    ];
    const layout = layoutRendering('<Widget />', "import { Widget } from '@/controls/widget';");
    for (const text of widgets) {
      await expect(
        boardWith({ 'app/boards/layout.tsx': layout, 'controls/widget.tsx': text }),
      ).resolves.toMatchObject({ shared: true });
    }
  });

  it('shares no document of a route whose layout renders a Client Component that hands what reads an input nothing tracks to a component’s prop of an event or of a ref — a function written there, one of the file’s own, a callback `useCallback` makes — which the component may call as the server renders it; but shares it where an element of the platform’s is handed it, which calls none', async () => {
    const invoking = [
      'function Invoke({ onValue }: { onValue: () => number }) {',
      '  return <p>{onValue()}</p>;',
      '}',
      '',
    ];
    const widgets = [
      clientModule(
        ...invoking,
        'export function Widget() {',
        '  return <Invoke onValue={() => Date.now()} />;',
        '}',
      ),
      clientModule(
        ...invoking,
        'function stamped(): number {',
        '  return Date.now();',
        '}',
        '',
        'export function Widget() {',
        '  return <Invoke onValue={stamped} />;',
        '}',
      ),
      clientModule(
        "import { useCallback } from 'react';",
        '',
        ...invoking,
        'export function Widget() {',
        '  const stamp = useCallback(() => Date.now(), []);',
        '  return <Invoke onValue={stamp} />;',
        '}',
      ),
      clientModule(
        'function Measured({ ref }: { ref: (node: null) => void }) {',
        '  ref(null);',
        '  return <p>measured</p>;',
        '}',
        '',
        'export function Widget() {',
        '  return <Measured ref={() => console.log(Date.now())} />;',
        '}',
      ),
    ];
    const layout = layoutRendering('<Widget />', "import { Widget } from '@/controls/widget';");
    for (const text of widgets) {
      await expect(
        boardWith({ 'app/boards/layout.tsx': layout, 'controls/widget.tsx': text }),
      ).resolves.toMatchObject({
        private: '`app/boards/layout.tsx` reads `Date`, an input nothing tracks',
        shared: false,
      });
    }
    const elements = [
      '<button type="button" onClick={() => Date.now()}>stamp</button>',
      '<stamp-button onClick={() => Date.now()} />',
    ];
    for (const element of elements) {
      const text = clientModule('export function Widget() {', `  return ${element};`, '}');

      await expect(
        boardWith({ 'app/boards/layout.tsx': layout, 'controls/widget.tsx': text }),
      ).resolves.toMatchObject({ shared: true });
    }
  });

  it('shares no document of a route whose layout renders a Client Component that hands what reads an input nothing tracks to a function of an effect’s name, or of `useCallback`’s, that is no hook of React’s — the file’s own, another module’s, one a scope around the call declares again — which may call it as the server renders it', async () => {
    const hooks = file('export function useLayoutEffect(run: () => void): void {', '  run();', '}');
    const widgets = [
      clientModule(
        'function useEffect(run: () => void): void {',
        '  run();',
        '}',
        '',
        'export function Widget() {',
        '  useEffect(() => {',
        '    console.log(Date.now());',
        '  });',
        '  return <p>tick</p>;',
        '}',
      ),
      clientModule(
        "import { useLayoutEffect } from '@/controls/hooks';",
        '',
        'export function Widget() {',
        '  useLayoutEffect(() => {',
        '    console.log(Date.now());',
        '  });',
        '  return <p>tick</p>;',
        '}',
      ),
      clientModule(
        "import * as React from '@/controls/hooks';",
        '',
        'export function Widget() {',
        '  React.useLayoutEffect(() => {',
        '    console.log(Date.now());',
        '  });',
        '  return <p>tick</p>;',
        '}',
      ),
      clientModule(
        "import { useEffect } from 'react';",
        '',
        'export function Widget() {',
        '  const useEffect = (run: () => void): void => {',
        '    run();',
        '  };',
        '  useEffect(() => {',
        '    console.log(Date.now());',
        '  });',
        '  return <p>tick</p>;',
        '}',
      ),
      clientModule(
        'function useCallback<T extends () => unknown>(run: T): T {',
        '  run();',
        '  return run;',
        '}',
        '',
        'export function Widget() {',
        '  const stamp = useCallback(() => Date.now());',
        '  return <button type="button" onClick={stamp}>stamp</button>;',
        '}',
      ),
    ];
    const layout = layoutRendering('<Widget />', "import { Widget } from '@/controls/widget';");
    for (const text of widgets) {
      await expect(
        boardWith({
          'app/boards/layout.tsx': layout,
          'controls/hooks.ts': hooks,
          'controls/widget.tsx': text,
        }),
      ).resolves.toMatchObject({
        private: '`app/boards/layout.tsx` reads `Date`, an input nothing tracks',
        shared: false,
      });
    }
  });

  it('shares the document of a route whose layout renders a Client Component that hands what reads an input nothing tracks to React’s own effect or `useCallback`, by whatever name the file imports it by: renamed, or a member of `react` imported whole or by its default', async () => {
    const widgets = [
      clientModule(
        "import { useEffect as onMount } from 'react';",
        '',
        'export function Widget() {',
        '  onMount(() => {',
        '    console.log(Date.now());',
        '  }, []);',
        '  return <p>tick</p>;',
        '}',
      ),
      clientModule(
        "import { useCallback as useHandler } from 'react';",
        '',
        'export function Widget() {',
        '  const stamp = useHandler(() => console.log(Date.now()), []);',
        '  return <button type="button" onClick={stamp}>stamp</button>;',
        '}',
      ),
      clientModule(
        "import * as React from 'react';",
        '',
        'export function Widget() {',
        '  React.useLayoutEffect(() => {',
        '    console.log(Date.now());',
        '  }, []);',
        '  return <p>tick</p>;',
        '}',
      ),
      clientModule(
        "import React from 'react';",
        '',
        'export function Widget() {',
        '  React.useInsertionEffect(() => {',
        '    console.log(Date.now());',
        '  }, []);',
        '  return <p>tick</p>;',
        '}',
      ),
    ];
    const layout = layoutRendering('<Widget />', "import { Widget } from '@/controls/widget';");
    for (const text of widgets) {
      await expect(
        boardWith({ 'app/boards/layout.tsx': layout, 'controls/widget.tsx': text }),
      ).resolves.toMatchObject({ shared: true });
    }
  });

  it('shares no document of a route whose layout calls the database, itself or through a module of the application’s, which the authority alone holds', async () => {
    const listing = file(
      "import { db } from '@/db';",
      '',
      'export const listTodos = (projectId: string) => db.todos.findMany({ where: { projectId } });',
    );
    const layouts = [
      wrapperOf(
        "import { db } from '@/db';",
        "const shown = async (): Promise<number> => (await db.todos.findMany({ where: { projectId: 'p1' } })).length;",
      ),
      wrapperOf(
        "import { listTodos } from '@/listing';",
        "const shown = async (): Promise<number> => (await listTodos('p1')).length;",
      ),
    ];
    for (const layout of layouts) {
      await expect(
        boardWith({ 'app/boards/layout.tsx': layout, 'listing.ts': listing }),
      ).resolves.toMatchObject({
        private:
          '`app/boards/layout.tsx` uses the database (`db.todos.findMany`), which the authority alone holds — render a reactive component that reads it',
        shared: false,
      });
    }
  });

  it('shares no document of a route whose layout uses the database by another name — a table or the handle held by a name, taken apart, handed on, the module read whole, exported again or loaded — which the authority alone holds', async () => {
    const query = "{ where: { projectId: 'p1' } }";
    const cases: readonly (readonly [Readonly<Record<string, string>>, string])[] = [
      [
        {
          'app/boards/layout.tsx': wrapperOf(
            "import { db } from '@/db';",
            'const shown = async (): Promise<number> => {',
            '  const todos = db.todos;',
            `  return (await todos.findMany(${query})).length;`,
            '};',
          ),
        },
        'db.todos',
      ],
      [
        {
          'app/boards/layout.tsx': wrapperOf(
            "import { db } from '@/db';",
            'const shown = async (): Promise<number> => {',
            '  const { todos } = db;',
            `  return (await todos.findMany(${query})).length;`,
            '};',
          ),
        },
        'db',
      ],
      [
        {
          'app/boards/layout.tsx': wrapperOf(
            "import { db } from '@/db';",
            `const load = async (table: typeof db.todos) => table.findMany(${query});`,
            'const shown = async (): Promise<number> => (await load(db.todos)).length;',
          ),
        },
        'db.todos',
      ],
      [
        {
          'app/boards/layout.tsx': wrapperOf(
            "import * as store from '@/db';",
            `const shown = async (): Promise<number> => (await store.db.todos.findMany(${query})).length;`,
          ),
        },
        'db.todos.findMany',
      ],
      [
        {
          'app/boards/layout.tsx': wrapperOf(
            "import { db } from '@/listing';",
            `const shown = async (): Promise<number> => (await db.todos.findMany(${query})).length;`,
          ),
          'listing.ts': file("export { db } from '@/db';"),
        },
        'db',
      ],
      [
        {
          'app/boards/layout.tsx': wrapperOf(
            'const shown = async (): Promise<number> => {',
            "  const { db } = await import('@/db');",
            `  return (await db.todos.findMany(${query})).length;`,
            '};',
          ),
        },
        'db',
      ],
    ];
    for (const [files, use] of cases) {
      await expect(boardWith(files)).resolves.toMatchObject({
        private: `\`app/boards/layout.tsx\` uses the database (\`${use}\`), which the authority alone holds — render a reactive component that reads it`,
        shared: false,
      });
    }
  });

  it('shares the document of a route whose layout reads the database’s module for no use of the handle: a type of it, another export, a name a scope declares again', async () => {
    const database = `${await source('db.ts')}\nexport const LABEL = 'board';\n`;
    const layouts = [
      wrapperOf(
        "import type { db } from '@/db';",
        "const shown = async (): Promise<string> => 'board' satisfies keyof typeof db | string;",
      ),
      wrapperOf(
        "import * as store from '@/db';",
        'const shown = async (): Promise<string> => store.LABEL;',
      ),
      wrapperOf(
        "import { db } from '@/db';",
        'type Table = keyof typeof db;',
        'const shown = async (): Promise<string> => {',
        "  const db = { todos: 'todos' };",
        '  return db.todos satisfies Table | string;',
        '};',
      ),
    ];
    for (const layout of layouts) {
      await expect(
        boardWith({ 'app/boards/layout.tsx': layout, 'db.ts': database }),
      ).resolves.toMatchObject({ shared: true });
    }
  });

  it('shares the document of a route whose reactive root reads the database, which the authority’s evaluation answers', async () => {
    await expect(boardWith({})).resolves.toMatchObject({ shared: true });
  });

  it('shares no document of a route whose layout reaches a reactive component that reads the clock, through a module of the application’s', async () => {
    const clock = file(
      'export default async function ClockBadge() {',
      '  return <p data-testid="clock">{String(Date.now())}</p>;',
      '}',
    );
    const frame = file(
      "import ClockBadge from '@/components/clock-badge.reactive';",
      '',
      'export const ClockFrame = () => <ClockBadge />;',
    );
    const layout = layoutRendering(
      '<ClockFrame />',
      "import { ClockFrame } from '@/controls/clock-frame';",
    );

    await expect(
      boardWith({
        'app/boards/layout.tsx': layout,
        'components/clock-badge.reactive.tsx': clock,
        'controls/clock-frame.tsx': frame,
      }),
    ).resolves.toMatchObject({
      private: '`components/clock-badge` reads `Date`, an input nothing tracks',
      shared: false,
    });
  });

  it('shares no document of a route whose layout renders a reactive component beside its root, though it reads neither the session nor an input nothing tracks, or the root renders it too: the authority renders it for a session alone', async () => {
    const note = file(
      'export default async function BoardNote() {',
      '  return <p data-testid="board-note">公開ボード</p>;',
      '}',
    );
    const cases: readonly (readonly [string, string, string])[] = [
      [
        'components/board-note',
        '<BoardNote />',
        "import BoardNote from '@/components/board-note.reactive';",
      ],
      [
        'components/public-board-layout',
        '<PublicBoardLayout title="board">{null}</PublicBoardLayout>',
        "import PublicBoardLayout from '@/components/public-board-layout.reactive';",
      ],
    ];
    for (const [id, element, imported] of cases) {
      await expect(
        boardWith({
          'app/boards/layout.tsx': layoutRendering(element, imported),
          'components/board-note.reactive.tsx': note,
        }),
      ).resolves.toMatchObject({
        private: `\`app/boards/layout.tsx\` renders \`${id}\` beside the route's root: a component the authority renders for a session alone`,
        shared: false,
      });
    }
  });

  it('shares no document of a route whose layout or page reaches an input nothing tracks through the application’s modules', async () => {
    const sampled = file('export const sample = (): number => Math.random();');
    const layout = file(
      "import type { ReactNode } from 'react';",
      "import { sample } from '@/sampled';",
      '',
      'export default function L({ children }: { children: ReactNode }) {',
      '  return <section data-sample={sample()}>{children}</section>;',
      '}',
    );
    // What a module of the application's runs as the page loads it, whatever the page reads of it.
    const started = file('export const startedAt = Date.now();');
    const page = `import '@/started';\n${await source(BOARD)}`;

    await expect(
      boardWith({ 'app/boards/layout.tsx': layout, 'sampled.ts': sampled }),
    ).resolves.toMatchObject({
      private: '`app/boards/layout.tsx` reads `Math.random`, an input nothing tracks',
      shared: false,
    });
    await expect(boardWith({ [BOARD]: page, 'started.ts': started })).resolves.toMatchObject({
      private: '`app/boards/[projectId]/page.tsx` reads `Date`, an input nothing tracks',
      shared: false,
    });
  });

  it('shares no document of a route whose server part reads an input nothing tracks', async () => {
    const todos = variant(
      await source('components/public-board-todos.reactive.tsx'),
      'if (todos.length === 0) {',
      'if (todos.length === 0 || Date.now() < 0) {',
    );

    await expect(
      boardWith({ 'components/public-board-todos.reactive.tsx': todos }),
    ).resolves.toMatchObject({
      private: '`components/public-board-todos` reads `Date`, an input nothing tracks',
      shared: false,
    });
  });

  it('shares no document of a route whose root reaches an untracked input through the application’s modules', async () => {
    const publication = `${await source('publication.ts')}\nexport const sample = (): number => Math.random();\n`;

    await expect(boardWith({ 'publication.ts': publication })).resolves.toMatchObject({
      private: '`components/public-board` reads `Math.random`, an input nothing tracks',
    });
  });

  it('shares no document of a route whose layout or a module its root reaches holds a weak reference, which answers as its engine collects', async () => {
    const weak = wrapperOf(
      'const shown = async (): Promise<string> => String(new WeakRef({}).deref() === undefined);',
    );
    const publication = `${await source('publication.ts')}\nexport const kept = new FinalizationRegistry(() => undefined);\n`;

    await expect(boardWith({ 'app/boards/layout.tsx': weak })).resolves.toMatchObject({
      private: '`app/boards/layout.tsx` reads `WeakRef`, an input nothing tracks',
      shared: false,
    });
    await expect(boardWith({ 'publication.ts': publication })).resolves.toMatchObject({
      private: '`components/public-board` reads `FinalizationRegistry`, an input nothing tracks',
      shared: false,
    });
  });

  it('shares no document of a route whose layout, page, root, a module they reach or a guard reads the frames an error was made in — `stack` of one made there or caught, by a dot or in brackets — or a member of `Error` one engine alone holds', async () => {
    const made = wrapperOf(
      "const shown = async (): Promise<string> => new Error('shown').stack ?? '';",
    );
    const bracketed = wrapperOf(
      "const shown = async (): Promise<string> => { try { return JSON.stringify(JSON.parse('{')); } catch (error) { return String((error as Error)['stack']); } };",
    );
    const limited = wrapperOf(
      "const shown = async (): Promise<number> => Number(Error['stackTraceLimit']);",
    );
    // What a module of the application's the page loads holds, read whole, whatever the page calls
    // of it.
    const traced = file(
      'export function traced(text: string): string {',
      '  try {',
      '    return JSON.stringify(JSON.parse(text));',
      '  } catch (error) {',
      "    return (error as Error).stack ?? '';",
      '  }',
      '}',
    );
    const page = `import '@/traced';\n${await source(BOARD)}`;
    const root = variant(
      await source('components/public-board.reactive.tsx'),
      '  const project = await requirePublishedProject(projectId);',
      '  const traced = {};\n  Error.captureStackTrace(traced);\n  const project = await requirePublishedProject(projectId);',
    );
    const publication = `${await source('publication.ts')}\nexport const traced = (): string | undefined => new TypeError('traced').stack;\n`;
    const guard = file(
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      "import { requirePublishedProject } from '@/publication';",
      '',
      'export default (async ({ params }, next) => {',
      "  await requirePublishedProject(new Error().stack === undefined ? '' : params.projectId);",
      '  return next();',
      '}) satisfies RouteMiddleware<{ projectId: string }>;',
    );
    const cases: readonly (readonly [Readonly<Record<string, string>>, string])[] = [
      [{ 'app/boards/layout.tsx': made }, '`app/boards/layout.tsx` reads `stack`'],
      [{ 'app/boards/layout.tsx': bracketed }, '`app/boards/layout.tsx` reads `stack`'],
      [
        { 'app/boards/layout.tsx': limited },
        '`app/boards/layout.tsx` reads `Error.stackTraceLimit`',
      ],
      [{ [BOARD]: page, 'traced.ts': traced }, '`app/boards/[projectId]/page.tsx` reads `stack`'],
      [
        { 'components/public-board.reactive.tsx': root },
        '`components/public-board` reads `Error.captureStackTrace`',
      ],
      [{ 'publication.ts': publication }, '`components/public-board` reads `stack`'],
      [
        { 'app/boards/[projectId]/middleware.ts': guard },
        'the guard of `app/boards/[projectId]/middleware.ts` reads `stack`',
      ],
    ];
    for (const [files, reason] of cases) {
      await expect(boardWith(files)).resolves.toMatchObject({
        private: `${reason}, an input nothing tracks`,
        shared: false,
      });
    }
  });

  it('shares no document of a route whose layout, page or guard reads a global nothing tracks where no scope around the read declares its name, though the file declares it elsewhere — a callback’s parameter, a type’s, a nested function’s local', async () => {
    const mapped = wrapperOf(
      'const ids = (items: readonly { id: string }[]): readonly string[] => items.map((fetch) => fetch.id);',
      "const shown = async (): Promise<string> => (await fetch('https://cms.test/banner')).text() + ids([]).join();",
    );
    const typed = wrapperOf(
      'type Stamped = (Date: number) => string;',
      'const stamped: Stamped = (at) => String(at);',
      'const shown = async (): Promise<string> => stamped(Date.now());',
    );
    const traced = wrapperOf(
      'const messages = (errors: readonly { readonly message: string }[]): readonly string[] => errors.map((Error) => Error.message);',
      'const shown = async (): Promise<string> => {',
      "  const target = { stack: '' };",
      '  Error.captureStackTrace(target);',
      '  return target.stack + messages([]).join();',
      '};',
    );
    // What a module of the application's runs as the page loads it, a function of its declaring the
    // name for itself.
    const started = file(
      'export function local(): number {',
      '  const Date = { now: (): number => 0 };',
      '  return Date.now();',
      '}',
      '',
      'export const startedAt = Date.now();',
    );
    const page = `import '@/started';\n${await source(BOARD)}`;
    const guard = file(
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      "import { requirePublishedProject } from '@/publication';",
      '',
      'export default (async ({ params }, next) => {',
      '  const ids = [params.projectId].map((Date) => Date);',
      "  await requirePublishedProject(Date.now() < 0 ? '' : ids.join());",
      '  return next();',
      '}) satisfies RouteMiddleware<{ projectId: string }>;',
    );
    const cases: readonly (readonly [Readonly<Record<string, string>>, string])[] = [
      [{ 'app/boards/layout.tsx': mapped }, '`app/boards/layout.tsx` reads `fetch`'],
      [{ 'app/boards/layout.tsx': typed }, '`app/boards/layout.tsx` reads `Date`'],
      [
        { 'app/boards/layout.tsx': traced },
        '`app/boards/layout.tsx` reads `Error.captureStackTrace`',
      ],
      [{ [BOARD]: page, 'started.ts': started }, '`app/boards/[projectId]/page.tsx` reads `Date`'],
      [
        { 'app/boards/[projectId]/middleware.ts': guard },
        'the guard of `app/boards/[projectId]/middleware.ts` reads `Date`',
      ],
    ];
    for (const [files, reason] of cases) {
      await expect(boardWith(files)).resolves.toMatchObject({
        private: `${reason}, an input nothing tracks`,
        shared: false,
      });
    }
  });

  it('shares the document of a route whose code reads, by the name of a global nothing tracks, what a scope around the read declares of the name', async () => {
    const layouts = [
      wrapperOf(
        'const fetch = async (url: string): Promise<string> => url;',
        "const shown = async (): Promise<string> => fetch('https://cms.test/banner');",
      ),
      wrapperOf(
        'function stamp(Date: { readonly now: () => number }): number {',
        '  return Date.now();',
        '}',
        'const shown = async (): Promise<number> => stamp({ now: () => 0 });',
      ),
      wrapperOf(
        'function traced(Error: { readonly captureStackTrace: (target: object) => void }): string {',
        "  const target = { stack: '' };",
        '  Error.captureStackTrace(target);',
        '  return target.stack;',
        '}',
        'const shown = async (): Promise<string> => traced({ captureStackTrace: () => undefined });',
      ),
    ];
    for (const layout of layouts) {
      await expect(boardWith({ 'app/boards/layout.tsx': layout })).resolves.toMatchObject({
        shared: true,
      });
    }
  });

  it('shares the document of a route whose code reads a date of a value, not the clock', async () => {
    const todos = variant(
      await source('components/public-board-todos.reactive.tsx'),
      'if (todos.length === 0) {',
      'if (todos.length === 0 || new Date(0).getTime() > 0) {',
    );

    await expect(
      boardWith({ 'components/public-board-todos.reactive.tsx': todos }),
    ).resolves.toMatchObject({
      shared: true,
    });
  });

  it('shares no document of a route whose layout, or a module its root reaches, makes a date of values it spreads, which may be none: a date of now', async () => {
    const layout = wrapperOf(
      'const given: [] | [number] = [];',
      'const shown = async (): Promise<number> => new Date(...given).getTime();',
    );
    const publication = `${await source('publication.ts')}\nexport const stamp = (...given: [] | [number]): number => new Date(...given).getTime();\n`;
    const cases: readonly (readonly [Readonly<Record<string, string>>, string])[] = [
      [{ 'app/boards/layout.tsx': layout }, '`app/boards/layout.tsx` reads `Date`'],
      [{ 'publication.ts': publication }, '`components/public-board` reads `Date`'],
    ];
    for (const [files, reason] of cases) {
      await expect(boardWith(files)).resolves.toMatchObject({
        private: `${reason}, an input nothing tracks`,
        shared: false,
      });
    }
  });

  it('shares no document of a route whose layout reads the time by what reads it for the code: a date format’s `format` or `formatToParts` of no date — none, `undefined`, `void 0`, a spread — of one made there, called without `new`, or a variable declared of one; `Temporal.Now`; a date of now’s text in the locale', async () => {
    const cases: readonly (readonly [string, string])[] = [
      [
        wrapperOf(
          "const shown = async (): Promise<string> => new Intl.DateTimeFormat('en-US').format();",
        ),
        'Intl.DateTimeFormat',
      ],
      [
        wrapperOf(
          "const formatter = Intl.DateTimeFormat('en-US');",
          'const shown = async (): Promise<number> => formatter.formatToParts(undefined).length;',
        ),
        'Intl.DateTimeFormat',
      ],
      [
        wrapperOf(
          'const dates: [] | [Date] = [];',
          "const shown = async (): Promise<string> => new Intl.DateTimeFormat('en-US').format(...dates);",
        ),
        'Intl.DateTimeFormat',
      ],
      [
        wrapperOf(
          "const formatter = new Intl.DateTimeFormat('en-US');",
          'const local = formatter;',
          "const shown = async (): Promise<string> => local['format'](void 0);",
        ),
        'Intl.DateTimeFormat',
      ],
      [
        wrapperOf('const shown = async (): Promise<string> => Temporal.Now.instant().toString();'),
        'Temporal.Now',
      ],
      [
        wrapperOf("const shown = async (): Promise<string> => new Date().toLocaleString('en-US');"),
        'Date.localTime',
      ],
    ];
    for (const [layout, read] of cases) {
      await expect(boardWith({ 'app/boards/layout.tsx': layout })).resolves.toMatchObject({
        private: `\`app/boards/layout.tsx\` reads \`${read}\`, an input nothing tracks`,
        shared: false,
      });
    }
  });

  it('shares no document of a route whose layout takes a date format’s `format` or `formatToParts` off it — to a name, apart, handed on, through `call`, by a key the compile cannot read — or makes the format of its class by another name', async () => {
    const formatter = "const formatter = new Intl.DateTimeFormat('en-US');";
    const cases: readonly (readonly [string, string | readonly string[]])[] = [
      [
        wrapperOf(
          "const format = new Intl.DateTimeFormat('en-US').format;",
          'const shown = async (): Promise<string> => format();',
        ),
        'Intl.DateTimeFormat',
      ],
      [
        wrapperOf(
          "const { formatToParts } = new Intl.DateTimeFormat('en-US');",
          'const shown = async (): Promise<number> => formatToParts().length;',
        ),
        'Intl.DateTimeFormat',
      ],
      [
        wrapperOf(
          formatter,
          'let format = (date?: Date): string => String(date);',
          '({ format } = formatter);',
          'const shown = async (): Promise<string> => format();',
        ),
        ['writes a date as text of the time zone where it runs', 'Intl.DateTimeFormat'],
      ],
      [
        wrapperOf(
          formatter,
          'const shown = async (): Promise<string> => [undefined].map(formatter.format).join();',
        ),
        'Intl.DateTimeFormat',
      ],
      [
        wrapperOf(
          formatter,
          'const shown = async (): Promise<string> => formatter.format.call(formatter);',
        ),
        'Intl.DateTimeFormat',
      ],
      [
        wrapperOf(
          formatter,
          "const key: 'format' | 'formatToParts' = 'format';",
          'const shown = async (): Promise<string> => String(formatter[key]());',
        ),
        'Intl.DateTimeFormat',
      ],
      [
        wrapperOf(
          'const DateFormat = Intl.DateTimeFormat;',
          "const shown = async (): Promise<string> => new DateFormat('en-US').format();",
        ),
        'Intl.DateTimeFormat',
      ],
      [
        wrapperOf(
          'const { DateTimeFormat } = Intl;',
          "const shown = async (): Promise<string> => DateTimeFormat('en-US').format();",
        ),
        'Intl.DateTimeFormat',
      ],
    ];
    for (const [layout, read] of cases) {
      const board = await boardWith({ 'app/boards/layout.tsx': layout });
      const reasons = typeof read === 'string' ? [read] : read;

      expect(board).toMatchObject({ shared: false });
      expect(board?.private).toBeOneOf(
        reasons.map(
          (reason) => `\`app/boards/layout.tsx\` reads \`${reason}\`, an input nothing tracks`,
        ),
      );
    }
  });

  it('shares the document of a route whose code formats a date it is given, or the date format of an `Intl` a scope around the read declares', async () => {
    const layouts = [
      wrapperOf(
        "const shown = async (): Promise<string> => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).format(new Date(0));",
      ),
      wrapperOf(
        "const formatter = Intl.DateTimeFormat('en-US', { timeZone: 'UTC' });",
        'const shown = async (): Promise<number> => formatter.formatToParts(new Date(0)).length;',
      ),
      wrapperOf(
        'const shown = async (): Promise<string> => {',
        "  const Intl = { DateTimeFormat: class { format = (): string => 'today'; } };",
        '  return new Intl.DateTimeFormat().format();',
        '};',
      ),
      wrapperOf(
        "const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' });",
        'const shown = async (): Promise<string> => formatter.formatRange(new Date(0), new Date(1));',
      ),
      wrapperOf(
        "const { format } = new Intl.NumberFormat('en-US');",
        'const shown = async (): Promise<string> => format(1);',
      ),
    ];
    for (const layout of layouts) {
      await expect(boardWith({ 'app/boards/layout.tsx': layout })).resolves.toMatchObject({
        shared: true,
      });
    }
  });

  it('shares no document of a route whose root, layout or guard reaches what a function of the code writes between calls — a `let` a setter assigns, an object a method of writes through `this`, a set the guard adds to', async () => {
    const banner = file(
      "export let banner = 'Welcome';",
      '',
      'export function setBanner(text: string): void {',
      '  banner = text;',
      '}',
    );
    const root = variant(
      variant(
        await source('components/public-board.reactive.tsx'),
        "import { requirePublishedProject } from '@/publication';",
        "import { banner } from '@/banner';\nimport { requirePublishedProject } from '@/publication';",
      ),
      '<PublicBoardLayout title={project.title}>',
      '<PublicBoardLayout title={project.title + banner}>',
    );
    const visits = file(
      'const counter = {',
      '  count: 0,',
      '  visit(): number {',
      '    this.count += 1;',
      '    return this.count;',
      '  },',
      '};',
      '',
      'export const nextVisit = (): number => counter.visit();',
    );
    const layout = wrapperOf(
      "import { nextVisit } from '@/visits';",
      'const shown = async (): Promise<number> => nextVisit();',
    );
    const seen = file('export const seen = new Set<string>();');
    const guard = file(
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      "import { requirePublishedProject } from '@/publication';",
      "import { seen } from '@/seen';",
      '',
      'export default (async ({ params }, next) => {',
      '  seen.add(params.projectId);',
      '  await requirePublishedProject(params.projectId);',
      '  return next();',
      '}) satisfies RouteMiddleware<{ projectId: string }>;',
    );
    const cases: readonly (readonly [Readonly<Record<string, string>>, string, string])[] = [
      [
        { 'banner.ts': banner, 'components/public-board.reactive.tsx': root },
        '`components/public-board`',
        'banner',
      ],
      [
        { 'app/boards/layout.tsx': layout, 'visits.ts': visits },
        '`app/boards/layout.tsx`',
        'counter',
      ],
      [
        { 'app/boards/[projectId]/middleware.ts': guard, 'seen.ts': seen },
        'the guard of `app/boards/[projectId]/middleware.ts`',
        'seen',
      ],
    ];
    for (const [files, party, kept] of cases) {
      await expect(boardWith(files)).resolves.toMatchObject({
        private: `${party} keeps what a function of its writes between calls, \`${kept}\``,
        shared: false,
      });
    }
  });

  it('shares the document of a route whose code reaches a module that keeps nothing a function writes: a constant it reads, a `let` it sets as it loads, what a function changes of its own, a date of a value', async () => {
    const helpers = file(
      "export const banner = 'Welcome';",
      "let motto = '';",
      "motto = 'Shared';",
      '',
      'export const mottoOf = (): string => motto;',
      '',
      'export function joined(items: readonly string[]): string {',
      '  const parts: string[] = [];',
      '  for (const item of items) {',
      '    parts.push(item);',
      '  }',
      "  return parts.join(', ');",
      '}',
    );
    const layout = wrapperOf(
      "import { banner, joined, mottoOf } from '@/helpers';",
      'const shown = async (): Promise<string> => joined([banner, mottoOf(), String(new Date(0).getTime())]);',
    );

    await expect(
      boardWith({ 'app/boards/layout.tsx': layout, 'helpers.ts': helpers }),
    ).resolves.toMatchObject({ shared: true });
  });

  it('shares the document of a route whose code reaches a module that writes through a table of the application’s database, of any name it imports it by: a commit the authority tracks', async () => {
    const publication = `${await source('publication.ts')}\n${file(
      'export function listTodos(projectId: string) {',
      '  return db.todos.findMany({ where: { projectId } });',
      '}',
      '',
      'export function removeTodo(id: string) {',
      '  return db.todos.delete(id);',
      '}',
    )}`;
    const todos = file(
      "import { db as database } from '@/db';",
      '',
      'export function listTodos(projectId: string) {',
      '  return database.todos.findMany({ where: { projectId } });',
      '}',
      '',
      'export function removeTodo(id: string) {',
      "  return database['todos'].delete(id);",
      '}',
    );
    const root = await rootCalling('listTodos');

    await expect(boardWith({ 'publication.ts': publication })).resolves.toMatchObject({
      shared: true,
    });
    await expect(
      boardWith({ 'components/public-board.reactive.tsx': root, 'todos.ts': todos }),
    ).resolves.toMatchObject({ shared: true });
  });

  it('shares no document of a route whose code reaches a module that writes into the database’s handle itself, or through what another module exports, whatever its name', async () => {
    const publication = `${await source('publication.ts')}\n${file(
      'export function swap(): void {',
      '  db.todos = db.memberships;',
      '}',
    )}`;
    const seen = file('export const seen = new Map<string, number>();');
    const forget = file(
      "import { seen } from '@/seen';",
      '',
      'export function forget(key: string): void {',
      '  seen.delete(key);',
      '}',
    );
    const cache = file('export const db = { todos: new Map<string, string>() };');
    const evict = file(
      "import { db } from '@/cache';",
      '',
      'export function evict(id: string): void {',
      '  db.todos.delete(id);',
      '}',
    );
    const cases: readonly (readonly [Readonly<Record<string, string>>, string])[] = [
      [
        { 'publication.ts': publication },
        '`components/public-board` keeps what a function of its writes between calls, `db`',
      ],
      [
        {
          'app/boards/layout.tsx': callingLayout('forget', 'forget'),
          'forget.ts': forget,
          'seen.ts': seen,
        },
        '`app/boards/layout.tsx` keeps what a function of its writes between calls, `seen`',
      ],
      [
        {
          'app/boards/layout.tsx': callingLayout('evict', 'evict'),
          'cache.ts': cache,
          'evict.ts': evict,
        },
        '`app/boards/layout.tsx` keeps what a function of its writes between calls, `db`',
      ],
    ];
    for (const [files, reason] of cases) {
      await expect(boardWith(files)).resolves.toMatchObject({ private: reason, shared: false });
    }
  });

  it('takes the database the compile’s `database` option names, and no other, for the one whose tables a write through is a commit', async () => {
    const store = file("export { db as store } from '@/db';");
    const root = await rootCalling('removeTodo');
    const cases: readonly (readonly [string, string, string, Partial<RouteRegistration>])[] = [
      ['@/store#store', 'store', 'store', { shared: true }],
      [
        '@/store#store',
        'db',
        'db',
        {
          private:
            '`components/public-board` keeps what a function of its writes between calls, `db`',
          shared: false,
        },
      ],
      ['@/db#db', 'db', 'db', { shared: true }],
    ];
    for (const [database, module, name, judged] of cases) {
      const files = {
        'components/public-board.reactive.tsx': root,
        'store.ts': store,
        'todos.ts': removingThrough(module, name),
      };

      await expect(boardOf(files, database)).resolves.toMatchObject(judged);
    }
  });

  it('shares the document of a route whose code reaches the database’s own module writing through a table of it, by the name it declares it by', async () => {
    const declared = await source('db.ts');
    const purging = file(
      '',
      'export function purge(id: string) {',
      '  return db.todos.delete(id);',
      '}',
    );
    const renamed = `${variant(declared, 'export const db = database(', 'const handle = database(')}${file(
      '',
      'export { handle as db };',
      '',
      'export function purge(id: string) {',
      '  return handle.todos.delete(id);',
      '}',
    )}`;

    const destructured = `${variant(declared, 'export const db = database(', 'const handle = database(')}${file(
      '',
      'export const { db } = { db: handle };',
      '',
      'export function purge(id: string) {',
      '  return db.todos.delete(id);',
      '}',
    )}`;

    await expect(boardWith({ 'db.ts': `${declared}${purging}` })).resolves.toMatchObject({
      shared: true,
    });
    await expect(boardWith({ 'db.ts': renamed })).resolves.toMatchObject({ shared: true });
    await expect(boardWith({ 'db.ts': destructured })).resolves.toMatchObject({ shared: true });
  });

  it('shares the document of a route whose code writes through a table of the database by a constant that holds it, as written or wrapped, in turn', async () => {
    const todos = file(
      "import { db as database } from '@/db';",
      '',
      'const store = database satisfies typeof database;',
      'const tables = (store as typeof store);',
      '',
      'export function removeTodo(id: string) {',
      '  return tables.todos.delete(id);',
      '}',
    );

    await expect(
      boardWith({
        'components/public-board.reactive.tsx': await rootCalling('removeTodo'),
        'todos.ts': todos,
      }),
    ).resolves.toMatchObject({ shared: true });
  });

  it('shares no document of a route whose code writes through a table of the database by a variable that may be given another value', async () => {
    const todos = file(
      "import { db } from '@/db';",
      '',
      'let store = db;',
      '',
      'export function removeTodo(id: string) {',
      '  return store.todos.delete(id);',
      '}',
    );

    await expect(
      boardWith({
        'components/public-board.reactive.tsx': await rootCalling('removeTodo'),
        'todos.ts': todos,
      }),
    ).resolves.toMatchObject({
      private:
        '`components/public-board` keeps what a function of its writes between calls, `store`',
      shared: false,
    });
  });

  it('shares no document of a route whose server part reads a library', async () => {
    const stats = variant(
      await source('components/public-board-stats.reactive.tsx'),
      "import { db } from '@/db';",
      "import { db } from '@/db';\nimport { round } from 'rounding';",
    );
    const rounded = variant(stats, 'const total = await', 'const total = round(0) + await');

    await expect(
      boardWith({ 'components/public-board-stats.reactive.tsx': rounded }),
    ).resolves.toMatchObject({
      private: '`components/public-board-stats` reads the library `rounding`',
    });
  });

  it('shares no document of a route whose layout, page, root, a module they reach or a guard imports a module of the platform’s — a built-in of Node’s, bare or prefixed, or one of workerd’s — or loads one the compile cannot name', async () => {
    const layout = wrapperOf(
      "import { hostname } from 'os';",
      'const shown = async (): Promise<string> => hostname();',
    );
    const page = `import 'node:crypto';\n${await source(BOARD)}`;
    const root = variant(
      variant(
        await source('components/public-board.reactive.tsx'),
        "import { requirePublishedProject } from '@/publication';",
        "import { hostname } from 'node:os';\nimport { requirePublishedProject } from '@/publication';",
      ),
      'await requirePublishedProject(projectId)',
      "await requirePublishedProject(hostname() === '' ? '' : projectId)",
    );
    const publication = `import { env } from 'cloudflare:workers';\n${await source('publication.ts')}\nexport const region = (): string => String(env);\n`;
    const guard = file(
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';",
      "import { randomInt } from 'node:crypto';",
      "import { requirePublishedProject } from '@/publication';",
      '',
      'export default (async ({ params }, next) => {',
      "  await requirePublishedProject(randomInt(1) === 0 ? params.projectId : '');",
      '  return next();',
      '}) satisfies RouteMiddleware<{ projectId: string }>;',
    );
    // A literal platform load is classified; a computed module name remains untracked.
    const required = wrapperOf(
      "const shown = async (): Promise<string> => String(require('node:os').hostname());",
    );
    const loaded = wrapperOf(
      "const name = 'node:os';",
      'const shown = async (): Promise<string> => String(await import(name));',
    );
    const cases: readonly (readonly [Readonly<Record<string, string>>, string])[] = [
      [{ 'app/boards/layout.tsx': layout }, '`app/boards/layout.tsx` reads `os`'],
      [{ 'app/boards/layout.tsx': required }, '`app/boards/layout.tsx` reads `node:os`'],
      [{ 'app/boards/layout.tsx': loaded }, '`app/boards/layout.tsx` reads `import()`'],
      [{ [BOARD]: page }, '`app/boards/[projectId]/page.tsx` reads `node:crypto`'],
      [
        { 'components/public-board.reactive.tsx': root },
        '`components/public-board` reads `node:os`',
      ],
      [{ 'publication.ts': publication }, '`components/public-board` reads `cloudflare:workers`'],
      [
        { 'app/boards/[projectId]/middleware.ts': guard },
        'the guard of `app/boards/[projectId]/middleware.ts` reads `node:crypto`',
      ],
    ];
    for (const [files, reason] of cases) {
      await expect(boardWith(files)).resolves.toMatchObject({
        private: `${reason}, an input nothing tracks`,
        shared: false,
      });
    }
  });

  it('shares the document of a route whose modules read the framework’s own, which is no library', async () => {
    const publication = variant(
      await source('publication.ts'),
      "import { db } from '@/db';",
      "import { recordTag } from '@arkorlab/reactive-state/program';\nimport { db } from '@/db';\n\nexport const tagOf = (id: string): string => recordTag('projects', id);",
    );

    await expect(boardWith({ 'publication.ts': publication })).resolves.toMatchObject({
      shared: true,
    });
  });

  it('shares no document of a route whose root holds a state the page writes', async () => {
    const editor = file(
      "import { useReactiveState } from 'framework/react';",
      "import { db } from '@/db';",
      '',
      'export default async function TitleEditor({ projectId }: { projectId: string }) {',
      '  const ref = db.projects.ref(projectId);',
      '  const [title, setTitle] = useReactiveState(ref.title);',
      '  return <input value={title} onChange={(event) => setTitle(event.currentTarget.value)} />;',
      '}',
    );
    const page = directPage('@/components/title-editor.reactive', 'projectId: string;');
    const app = await application({
      'app/titles/[projectId]/page.tsx': page,
      'components/title-editor.reactive.tsx': editor,
    });
    apps.push(app);
    const compiled = compiledApp(app, api);

    expect(routeOf(compiled, app, '/titles/[projectId]')).toMatchObject({
      private: '`components/title-editor` holds a state the page writes (`title`)',
      shared: false,
    });
  });

  it('shares no document of a route an intercepting route stands in for on a navigation', async () => {
    const modal = directPage('@/components/public-board.reactive', 'projectId: string;');

    await expect(
      boardWith({ 'app/feed/@modal/(..)boards/[projectId]/page.tsx': modal }),
    ).resolves.toMatchObject({
      private:
        'an intercepting route, `feed/@modal/(..)boards/[projectId]`, stands in for it on a navigation',
      shared: false,
    });
  });

  it('shares no document of a page that runs code beside its root', async () => {
    const page = `${await source(BOARD)}\nexport async function generateMetadata() {\n  return { title: 'x' };\n}\n`;

    await expect(boardWith({ [BOARD]: page })).resolves.toMatchObject({
      private: 'the page runs `generateMetadata` beside its root',
    });
  });

  it('shares the document of a page with a configuration of literals beside its root', async () => {
    const page = `${await source(BOARD)}\nexport const metadata = { title: 'Board' };\n`;

    await expect(boardWith({ [BOARD]: page })).resolves.toMatchObject({ shared: true });
  });

  it('shares no document of a route whose root is the session’s, in a middleware-free application', async () => {
    const board = variant(
      await source('components/public-board.reactive.tsx'),
      'const project = await requirePublishedProject(projectId);',
      'await currentUser();\n  const project = await requirePublishedProject(projectId);',
    );
    const imported = variant(
      board,
      "import { requirePublishedProject } from '@/publication';",
      "import { currentUser } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';",
    );

    await expect(
      boardWith({ 'components/public-board.reactive.tsx': imported }),
    ).resolves.toMatchObject({
      private: "`components/public-board` reads the session's identity (`currentUser`)",
    });
  });
});

describe('the compile of an application whose app directory registers nothing', () => {
  it('writes the host’s registry all the same, empty', async () => {
    using api = openTypeScript();
    const app = await application();
    await rm(path.join(app.src, 'app/boards'), { recursive: true });
    await rm(path.join(app.src, 'app/projects'), { recursive: true });
    const compiled = compiledApp(app, api);
    const routes = output(compiled, app, 'routes.ts');
    await removed(app);

    expect(routes).toContain('export const routes: readonly RouteRegistration[] = [];');
    expect(routes).toContain(
      'export const envelopes: Readonly<Record<string, MiddlewareEnvelope>> = {};',
    );
  });
});
