import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextAdapter, NextConfig } from 'next';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { SHARING_OFF } from '../src/compiler/emit-host.ts';
import { givenHost, hostOf } from '../src/compiler/host.ts';
import { PAGE_EXTENSIONS } from '../src/compiler/page-extensions.ts';
import { createReactiveAdapter, ROUTE_GATES_ENV } from '../src/next/adapter.ts';
import type * as CompileOnBuild from '../src/next/compile-on-build.ts';
import {
  compileProject,
  EDGE_GATE_ENV,
  PLATFORM_ADAPTER_ENV,
} from '../src/next/compile-on-build.ts';
import {
  INSTANT_LOADER,
  REACTIVE_SOURCES,
  reactiveRule,
  type TurbopackRule,
  withReactiveState,
} from '../src/next/config.ts';
import {
  DELIVERY_KEY_ENV,
  DIRECT_HEADER,
  GATE_NAME,
  type PlainRouteRegistration,
  type RegisteredRoute,
  type RouteRegistration,
  routeKeyOf,
} from '../src/routing.ts';

/**
 * The adapter a platform's command builds an application of reactive state through
 * (`NEXT_ADAPTER_PATH`): the compile run before Next.js reads the application, and what the
 * application's config is given — the components' rule, this package, Cache Components — with
 * what the compile registered of its routes: a blocking page let block, a route under middleware
 * sent to the compile's route, a shared route's gate declared; and the platform's adapter around
 * which it is, handed the config. The compile is the one thing stood in for (`compile-on-build`'s
 * own suite runs it); the routes are a manifest each case writes.
 */

vi.mock(import('../src/next/compile-on-build.ts'), async (importOriginal) => {
  const actual = await importOriginal<typeof CompileOnBuild>();
  return {
    ...actual,
    compileProject: vi.fn((options: CompileOnBuild.ProjectOptions) =>
      Promise.resolve({ ...actual.layoutOf(options), changed: false, compiled: false }),
    ),
  };
});

type BuildConfig = Parameters<NonNullable<NextAdapter['modifyConfig']>>[0];
type Context = Parameters<NonNullable<NextAdapter['modifyConfig']>>[1];
type Rewrites = Awaited<ReturnType<NonNullable<NextConfig['rewrites']>>>;
type Rewrite = Extract<Rewrites, readonly unknown[]>[number];

/** Where the suite's projects are made: in this package, so that Next.js resolves from them. */
const PACKAGE = fileURLToPath(new URL('../', import.meta.url));
const BUILD = 'phase-production-build';

const instantLoader = createRequire(import.meta.url)('../src/next/loader-instant.cjs') as (
  source: string,
) => string;

const projects: string[] = [];

/** A project with a `src`, and a manifest of `routes` where given, as the compile writes it. */
function project(routes?: readonly RegisteredRoute[]): string {
  const dir = mkdtempSync(path.join(PACKAGE, '.reactive-state-adapter-'));
  projects.push(dir);
  mkdirSync(path.join(dir, 'src', 'app'), { recursive: true });
  if (routes !== undefined) {
    mkdirSync(path.join(dir, '.reactive'));
    writeFileSync(path.join(dir, '.reactive', 'manifest.json'), JSON.stringify({ routes }));
  }
  return dir;
}

/** What Next.js read of an application's config, and the file it read it from. */
type ReadConfig = NextConfig & { readonly configFile?: string; readonly configFileName?: string };

/** A config as Next.js hands one to `modifyConfig`: its defaults filled in, `config` over them. */
function completeConfig(config: ReadConfig = {}): BuildConfig {
  return {
    cacheComponents: false,
    configFile: undefined,
    configFileName: 'next.config.js',
    experimental: { cachedNavigations: false, useCache: false },
    pageExtensions: ['tsx', 'ts', 'jsx', 'js'],
    poweredByHeader: true,
    ...config,
  } as unknown as BuildConfig;
}

/** A statement of a config's that counts, in `globalThis[what]`, each time it runs. */
function counted(what: string): string {
  return `globalThis.${what} = (globalThis.${what} ?? 0) + 1;`;
}

/**
 * A project whose `next.config` is `file`, holding `source`, and the config Next.js hands over of
 * it: `read`, what it read of the file, over its defaults.
 */
function configured(
  file: string,
  source: string,
  read: NextConfig = {},
): { readonly dir: string; readonly config: BuildConfig } {
  const dir = project();
  writeFileSync(path.join(dir, file), source);
  return {
    config: completeConfig({ ...read, configFile: path.join(dir, file), configFileName: file }),
    dir,
  };
}

function context(projectDir: string, phase = BUILD): Context {
  return { nextVersion: '16.4.2', phase, projectDir } as Context;
}

async function modified(
  projectDir: string,
  config: BuildConfig = completeConfig(),
  phase = BUILD,
): Promise<BuildConfig> {
  const adapter = createReactiveAdapter();
  const result = await adapter.modifyConfig?.(config, context(projectDir, phase));
  if (result === undefined) {
    throw new Error('the adapter answered no config');
  }
  return result;
}

/** A route as the compile registers one, `overrides` over a route of one param. */
function route(overrides: Partial<RouteRegistration> = {}): RouteRegistration {
  return {
    blocking: false,
    middleware: [],
    page: 'boards/[projectId]/page.tsx',
    params: ['projectId'],
    props: { projectId: 'projectId' },
    root: 'components/public-board',
    route: '/boards/[projectId]',
    shared: false,
    ...overrides,
  };
}

/** The rules a config's Turbopack has. */
function rulesOf(config: BuildConfig): Readonly<Record<string, unknown>> {
  return (config.turbopack as NextConfig['turbopack'])?.rules ?? {};
}

/** The path condition of the rule that lets pages block. */
function instantPathOf(rule: unknown): RegExp {
  const { condition } = rule as TurbopackRule;
  const all = (condition as { readonly all: readonly { readonly path?: unknown }[] }).all;
  const found = all.find((item) => item.path instanceof RegExp)?.path;
  if (!(found instanceof RegExp)) {
    throw new TypeError('the rule holds no path to a page');
  }
  return found;
}

async function rewritesOf(config: BuildConfig): Promise<Rewrites> {
  const rewrites = config.rewrites as NextConfig['rewrites'];
  if (typeof rewrites !== 'function') {
    throw new TypeError('the config has no rewrites');
  }
  return rewrites();
}

/** A rewrite's params, as Next.js's router matches its source: by name, a catch-all's a list. */
type Matched = Readonly<Record<string, string | readonly string[]>>;

/** Next.js's own matcher of a rewrite's source, and its filler of a rewrite's destination. */
const { getPathMatch } = createRequire(import.meta.url)(
  'next/dist/shared/lib/router/utils/path-match.js',
) as {
  readonly getPathMatch: (
    source: string,
    options: {
      readonly regexModifier: (regex: string) => string;
      readonly removeUnnamedParams: boolean;
      readonly strict: boolean;
      readonly sensitive?: boolean;
    },
  ) => (pathname: string) => Matched | false;
};
/** What Next.js makes of the regex of a rewrite of an application's: a slash after it optional. */
const { modifyRouteRegex } = createRequire(import.meta.url)('next/dist/lib/redirect-status.js') as {
  readonly modifyRouteRegex: (regex: string) => string;
};
const { prepareDestination } = createRequire(import.meta.url)(
  'next/dist/shared/lib/router/utils/prepare-destination.js',
) as {
  readonly prepareDestination: (args: {
    readonly appendParamsToQuery: boolean;
    readonly destination: string;
    readonly params: Matched;
    readonly query: Readonly<Record<string, string>>;
  }) => { readonly parsedDestination: { readonly pathname: string } };
};

/**
 * The path Next.js's router rewrites `pathname` to by `rewrite`, as it matches a rewrite's source
 * (`buildCustomRoute`, `router-utils/filesystem.ts`) and fills its destination in; none where the
 * source does not match.
 */
function rewrittenPath(
  rewrite: { readonly destination: string; readonly source: string },
  pathname: string,
): string | undefined {
  const params = getPathMatch(rewrite.source, {
    regexModifier: (regex) => modifyRouteRegex(regex),
    removeUnnamedParams: true,
    strict: true,
  })(pathname);
  if (params === false) {
    return undefined;
  }
  const { destination } = rewrite;
  const prepared = prepareDestination({
    appendParamsToQuery: true,
    destination,
    params,
    query: {},
  });
  return prepared.parsedDestination.pathname;
}

/** How `@vercel/routing-utils` compiles a rewrite, which Next.js does for an adapter's routing. */
const { convertRewrites } = createRequire(import.meta.url)(
  'next/dist/compiled/@vercel/routing-utils',
) as {
  readonly convertRewrites: (
    rewrites: readonly { readonly destination: string; readonly source: string }[],
  ) => readonly { readonly src: string }[];
};

/**
 * The regex of `rewrite`, as path-to-regexp reads its source (`convertRewrites`): what a router of
 * Vercel's matches; and, a slash after it optional (`modifyRouteRegex`), the `sourceRegex` of the
 * routing Next.js hands an adapter, which upwind's runtime matches with `@next/routing`.
 */
function compiled(
  rewrite: { readonly destination: string; readonly source: string },
  slashed: boolean,
): RegExp {
  const [converted] = convertRewrites([rewrite]);
  const regex = converted?.src ?? '';
  // eslint-disable-next-line security/detect-non-literal-regexp -- a rewrite's, as a router reads it.
  return new RegExp(slashed ? modifyRouteRegex(regex) : regex, 'iu');
}

/** A slash of a static route's rewrite source: as it is, or escaped. */
const SLASH = '(/|%2[fF])';

/**
 * A static segment of a rewrite's source, as the adapter writes one: each character a group of
 * itself and its escape, a hex letter of either case — one byte each of the characters these tests
 * name (`p` is `(p|%70)`; `.` is `(\.|%2[eE])`).
 */
function spelled(segment: string): string {
  return Array.from(segment, (character) => {
    const hex = (character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(2, '0');
    const escaped = hex.replaceAll(/[A-F]/gu, (letter) => `[${letter}${letter.toLowerCase()}]`);
    const written = character.replace('.', String.raw`\.`);
    return `(${written}|%${escaped})`;
  }).join('');
}

/** Where a request of `name`'s page is delivered, as Next.js and upwind's runtime match it. */
function deliveredAt(name: string, tail = ''): readonly (boolean | string)[] {
  return [`/api/reactive-state/deliver/${routeKeyOf(name)}${tail}`, true];
}

/** A dynamic route's regex, as Next.js makes one (`getNamedRouteRegex`). */
interface RouteRegex {
  readonly re: RegExp;
}
const { getNamedRouteRegex } = createRequire(import.meta.url)(
  'next/dist/shared/lib/router/utils/route-regex.js',
) as {
  readonly getNamedRouteRegex: (
    page: string,
    options: { readonly includePrefix: boolean; readonly includeSuffix: boolean },
  ) => RouteRegex;
};
const { getRouteMatcher } = createRequire(import.meta.url)(
  'next/dist/shared/lib/router/utils/route-matcher.js',
) as { readonly getRouteMatcher: (regex: RouteRegex) => (pathname: string) => unknown };

/**
 * The params Next.js's router resolves a path to by the dynamic route `name`, as it matches one
 * (`buildFilesystemDynamicRoute`, `router-utils/filesystem.ts`); `false` where it does not.
 */
function resolvedBy(name: string): (pathname: string) => unknown {
  return getRouteMatcher(getNamedRouteRegex(name, { includePrefix: true, includeSuffix: true }));
}

/** A rewrite of a config's, as Next.js hands an adapter one: of a regex it compiled. */
function routed(rule: Rewrite): Rewrite & { readonly sourceRegex: string } {
  return { ...rule, sourceRegex: '^.*$' };
}

/** The delivery rewrites among `rewrites`, the order Next.js matches them in. */
function deliveriesIn(rewrites: Rewrites): readonly Rewrite[] {
  return Array.isArray(rewrites)
    ? rewrites
    : [...(rewrites.beforeFiles ?? []), ...(rewrites.afterFiles ?? [])];
}

/**
 * Where `pathname` is delivered to by the first of `delivered` that Next.js's router matches it by;
 * and whether one matches it as upwind's runtime does (`compiled`).
 */
function deliveryAt(
  delivered: readonly Rewrite[],
  pathname: string,
): readonly (boolean | string | undefined)[] {
  const by = delivered.find((rewrite) => rewrittenPath(rewrite, pathname) !== undefined);
  return [
    by && rewrittenPath(by, pathname),
    delivered.some((rewrite) => compiled(rewrite, true).test(pathname)),
  ];
}

/** A free case-shadow fixture is under middleware only where the case explicitly says so. */
function writeShadowMiddleware(target: string, guarded: boolean): void {
  if (guarded) {
    writeFileSync(
      path.join(path.dirname(target), 'middleware.ts'),
      'export default async function middleware() {}\n',
    );
  }
}

/** The adapter's configuration refusal, or empty text for an admitted configuration. */
async function configReason(
  dir: string,
  config: ReturnType<typeof completeConfig>,
): Promise<string> {
  try {
    await modified(dir, config);
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** What the compile's host reads of options that say nothing of a session or a prefetch. */
const NOTHING = { prefetch: undefined, session: undefined };

/** What `withReactiveState` is told, what the compile is handed of it, and what its host reads. */
const TOLD = [
  { compile: {}, host: NOTHING, id: 'nothing-said', options: {} },
  {
    compile: { share: false },
    host: { ...NOTHING, share: false },
    id: 'share-off',
    options: { share: false },
  },
  { compile: {}, host: NOTHING, id: 'share-on', options: { share: true } },
  {
    compile: { session: '@/session#session' },
    host: { ...NOTHING, session: { name: 'session', specifier: '@/session' } },
    id: 'session',
    options: { session: '@/session#session' },
  },
  {
    compile: { prefetch: '30/60/300' },
    host: { ...NOTHING, prefetch: { expire: 300, revalidate: 60, stale: 30 } },
    id: 'prefetch',
    options: { prefetch: '30/60/300' },
  },
  {
    compile: { database: '@/data#store' },
    host: NOTHING,
    id: 'database',
    options: { database: '@/data#store' },
  },
  {
    compile: {
      database: '@/data#store',
      prefetch: '30/60/300',
      session: '@/session#session',
      share: false,
    },
    host: {
      prefetch: { expire: 300, revalidate: 60, stale: 30 },
      session: { name: 'session', specifier: '@/session' },
      share: false,
    },
    id: 'every-option',
    options: {
      database: '@/data#store',
      prefetch: '30/60/300',
      session: '@/session#session',
      share: false,
    },
  },
] as const;

/** A component, and a page of a route of one param that renders it of the param alone. */
const GREETING = {
  'src/app/greet/[name]/page.tsx': [
    "import Hello from '@/components/hello.reactive';",
    '',
    'export default async function Page({ params }: { params: Promise<{ name: string }> }) {',
    '  const { name } = await params;',
    '  return <Hello name={name} />;',
    '}',
    '',
  ].join('\n'),
  'src/components/hello.reactive.tsx': [
    'export default function Hello({ name }: { readonly name: string }) {',
    '  return <p>Hello, {name}</p>;',
    '}',
    '',
  ].join('\n'),
  'tsconfig.json': JSON.stringify({
    compilerOptions: { jsx: 'react-jsx', paths: { '@/*': ['./src/*'] } },
  }),
};

/** What the compile registered of the greeting's route in `dir`'s manifest, as it wrote it. */
function greeting(dir: string): unknown {
  const manifest = JSON.parse(
    readFileSync(path.join(dir, '.reactive', 'manifest.json'), 'utf8'),
  ) as { readonly routes: readonly { readonly route: string }[] };
  return manifest.routes.find(({ route: each }) => each === '/greet/[name]');
}

describe('the reactive-state adapter', () => {
  beforeEach(() => {
    vi.mocked(compileProject).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of projects.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  describe('the config', () => {
    it('compiles the components, and adds their rule, this package and Cache Components to a project with no next.config', async () => {
      const dir = project();

      const config = await modified(dir);

      expect(compileProject).toHaveBeenCalledExactlyOnceWith({
        out: '.reactive',
        projectDir: dir,
        src: 'src',
      });
      expect(rulesOf(config)).toStrictEqual({
        [REACTIVE_SOURCES]: reactiveRule({ out: '.reactive', root: dir, src: 'src' }),
      });
      expect(config.transpilePackages).toStrictEqual(['@arkorlab/reactive-state']);
      expect(config).toMatchObject({
        cacheComponents: true,
        experimental: { cachedNavigations: true, useCache: true },
        partialPrefetching: true,
      });
    });

    it('keeps the application’s own options, rules, packages and rewrites', async () => {
      const dir = project([route({ middleware: [''] })]);
      const svg = { as: '*.js', loaders: ['@svgr/webpack'] };
      const own = [{ destination: '/new', source: '/old' }];

      const config = await modified(
        dir,
        completeConfig({
          cacheComponents: true,
          partialPrefetching: true,
          poweredByHeader: false,
          rewrites: () => Promise.resolve(own),
          transpilePackages: ['other'],
          turbopack: { resolveAlias: { underscore: 'lodash' }, rules: { '*.svg': svg } },
        }),
      );

      expect(config.poweredByHeader).toBe(false);
      expect(config.transpilePackages).toStrictEqual(['other', '@arkorlab/reactive-state']);
      expect(config.turbopack).toMatchObject({ resolveAlias: { underscore: 'lodash' } });
      expect(rulesOf(config)['*.svg']).toBe(svg);
      await expect(rewritesOf(config)).resolves.toMatchObject({
        afterFiles: [{ source: '/boards/:param0' }, ...own],
        beforeFiles: [],
      });
    });

    it('runs on the config a compile’s phase reads, and compiles in no other phase', async () => {
      const dir = project();

      await modified(dir, completeConfig(), 'phase-development-server');
      await modified(dir, completeConfig(), 'phase-production-server');

      expect(compileProject).toHaveBeenCalledTimes(1);
    });

    it('adds no second rule where withReactiveState added one, and compiles the src it was given', async () => {
      const dir = project();
      const wrapped = withReactiveState({}, { root: dir, src: 'reactive' });
      mkdirSync(path.join(dir, 'reactive'));

      const config = await modified(dir, completeConfig(wrapped));

      expect(rulesOf(config)[REACTIVE_SOURCES]).toBe(wrapped.turbopack?.rules?.[REACTIVE_SOURCES]);
      expect(config.transpilePackages).toStrictEqual(['@arkorlab/reactive-state']);
      expect(compileProject).toHaveBeenCalledExactlyOnceWith({
        out: '.reactive',
        projectDir: dir,
        src: 'reactive',
      });
    });

    it.each(TOLD)('hands the compile what withReactiveState was told: $id', async (row) => {
      const dir = project();
      const wrapped = withReactiveState({}, { root: dir, ...row.options });

      await modified(dir, completeConfig(wrapped));

      expect(compileProject).toHaveBeenCalledExactlyOnceWith({
        out: '.reactive',
        projectDir: dir,
        src: 'src',
        ...row.compile,
      });

      // As the compile reads its host's options: each one given kept, and read as what it names.
      const given = givenHost(row.compile);

      expect(given).toStrictEqual(row.compile);
      expect(hostOf(given)).toStrictEqual(row.host);
    });

    it('builds a route unshared once withReactiveState is told `share: false`, the compile itself run', async () => {
      const { compileProject: compile } = await vi.importActual<typeof CompileOnBuild>(
        '../src/next/compile-on-build.ts',
      );
      vi.mocked(compileProject)
        .mockImplementationOnce((options) => compile(options))
        .mockImplementationOnce((options) => compile(options));
      const dir = project();
      for (const [file, text] of Object.entries(GREETING)) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), text);
      }

      await modified(dir, completeConfig(withReactiveState({}, { root: dir })));

      expect(greeting(dir)).toMatchObject({ shared: true });

      // The build that shared it is on disk: turned off, sharing compiles the application again.
      await modified(dir, completeConfig(withReactiveState({}, { root: dir, share: false })));

      expect(greeting(dir)).toMatchObject({ private: SHARING_OFF, shared: false });
    });

    it('refuses a rule of the application’s own for the components’ sources', async () => {
      const dir = project();

      await expect(
        modified(dir, completeConfig({ turbopack: { rules: { [REACTIVE_SOURCES]: ['x'] } } })),
      ).rejects.toThrow(/has a rule of its own for \*\.reactive\.tsx/u);
      expect(compileProject).not.toHaveBeenCalled();
    });

    it('refuses page extensions other than Next.js’s own before it compiles — a page of another would be no route, its root rendered without its middleware’s guards — and takes them in any order', async () => {
      const dir = project();

      await expect(
        modified(dir, completeConfig({ pageExtensions: ['page.tsx', 'page.ts'] })),
      ).rejects.toThrow('next.config.js sets `pageExtensions` to ["page.tsx","page.ts"]');
      await expect(
        modified(dir, completeConfig({ pageExtensions: ['mdx', 'tsx', 'ts', 'jsx', 'js'] })),
      ).rejects.toThrow('sets `pageExtensions` to ["mdx","tsx","ts","jsx","js"]');
      expect(compileProject).not.toHaveBeenCalled();

      await modified(dir, completeConfig({ pageExtensions: ['js', 'jsx', 'ts', 'tsx'] }));

      expect(compileProject).toHaveBeenCalledTimes(1);
    });

    it('reads the app directory by the page extensions Next.js reads one by where it is told none', () => {
      const { defaultConfig } = createRequire(import.meta.url)(
        'next/dist/server/config-shared.js',
      ) as { readonly defaultConfig: { readonly pageExtensions: readonly string[] } };

      expect(defaultConfig.pageExtensions).toStrictEqual(PAGE_EXTENSIONS);
    });
  });

  describe('turning Cache Components on', () => {
    it('turns it on where the application’s config says nothing of it', async () => {
      const { config, dir } = configured(
        'next.config.mjs',
        'export default { poweredByHeader: false };',
        { poweredByHeader: false },
      );

      await expect(modified(dir, config)).resolves.toMatchObject({
        cacheComponents: true,
        partialPrefetching: true,
        poweredByHeader: false,
      });
    });

    it('refuses it off, in a config Next.js compiles from TypeScript as in one it imports', async () => {
      const mjs = configured('next.config.mjs', 'export default { cacheComponents: false };');
      const ts = configured(
        'next.config.ts',
        'const config: { cacheComponents?: boolean } = { cacheComponents: false };\nexport default config;\n',
      );

      await expect(modified(mjs.dir, mjs.config)).rejects.toThrow(
        /next\.config\.mjs sets `cacheComponents: false`/u,
      );
      await expect(modified(ts.dir, ts.config)).rejects.toThrow(
        /next\.config\.ts sets `cacheComponents: false`/u,
      );
    });

    it('never runs the application’s config again: reads one written plainly from its source, and refuses one it computes unless Next.js read Cache Components on', async () => {
      const plain = configured(
        'next.config.ts',
        `${counted('__reactiveConfigEvaluations')}\nconst config = { poweredByHeader: false };\nexport default config;\n`,
      );
      const computed = configured(
        'next.config.mjs',
        `export default (phase) => { ${counted('__reactiveConfigCalls')} return { poweredByHeader: phase === 'none' }; };`,
      );
      const spread = configured(
        'next.config.mjs',
        'const base = { poweredByHeader: false };\nexport default { ...base };\n',
      );
      onTestFinished(() => {
        Reflect.deleteProperty(globalThis, '__reactiveConfigEvaluations');
        Reflect.deleteProperty(globalThis, '__reactiveConfigCalls');
      });

      await expect(modified(plain.dir, plain.config)).resolves.toMatchObject({
        cacheComponents: true,
      });
      await expect(modified(computed.dir, computed.config)).rejects.toThrow(
        /next\.config\.mjs leaves Cache Components off as Next\.js read it, and computes what it says/u,
      );
      await expect(modified(spread.dir, spread.config)).rejects.toThrow(/computes what it says/u);
      // A config whose run Next.js read Cache Components on of is gone by as it was read.
      await expect(
        modified(computed.dir, { ...computed.config, cacheComponents: true }),
      ).resolves.toMatchObject({ cacheComponents: true });
      expect(Reflect.get(globalThis, '__reactiveConfigEvaluations')).toBeUndefined();
      expect(Reflect.get(globalThis, '__reactiveConfigCalls')).toBeUndefined();
    });

    it('refuses it without Partial Prefetching, and keeps cached navigations a config turned off', async () => {
      const dir = project();
      const off = configured(
        'next.config.mjs',
        'export default { experimental: { cachedNavigations: false } };',
      );

      await expect(modified(dir, completeConfig({ partialPrefetching: false }))).rejects.toThrow(
        /sets `partialPrefetching: false`/u,
      );
      await expect(modified(off.dir, off.config)).resolves.toMatchObject({
        cacheComponents: true,
        experimental: { cachedNavigations: false },
      });
    });
  });

  describe('a blocking route', () => {
    const board = route({ blocking: true });
    const settings = route({
      page: 'projects/[projectId]/publication/page.tsx',
      route: '/projects/[projectId]/publication',
    });

    it('has its page let block, and no other page', async () => {
      const dir = project([board, settings]);

      const rule = rulesOf(await modified(dir))['page.tsx'];
      const page = instantPathOf(rule);

      expect(rule).toMatchObject({ loaders: [INSTANT_LOADER] });
      expect(page.test('src/app/boards/[projectId]/page.tsx')).toBe(true);
      expect(page.test('fixtures/todo/src/app/boards/[projectId]/page.tsx')).toBe(true);
      expect(page.test('src/app/projects/[projectId]/publication/page.tsx')).toBe(false);
      expect(page.test('src/app/xboards/[projectId]/page.tsx')).toBe(false);
      expect(page.test('src/app/boards/[projectId]/page.tsx.map')).toBe(false);
    });

    it('is the one page let block, beside the application’s own rule for such pages', async () => {
      const none = project([settings]);
      const own = project([board]);
      const ownRule = { loaders: ['own-loader'] };

      const kept = rulesOf(
        await modified(own, completeConfig({ turbopack: { rules: { 'page.tsx': ownRule } } })),
      );

      expect(rulesOf(await modified(none))).not.toHaveProperty('page.tsx');
      expect(kept['page.tsx']).toStrictEqual([
        ownRule,
        expect.objectContaining({ loaders: [INSTANT_LOADER] }),
      ]);
    });

    it('is told it may block, unless the page says what it means itself', () => {
      const page = 'export default async function Page() {\n  return null;\n}\n';

      expect(instantLoader(page)).toBe(`${page}\nexport const instant = false;\n`);
      expect(instantLoader(`${page}export const instant = true;\n`)).toBe(
        `${page}export const instant = true;\n`,
      );
      expect(
        instantLoader(`const blocking = false;\nexport { blocking as instant };\n${page}`),
      ).not.toContain('export const instant = false');
      expect(instantLoader(`const instant = 1;\nexport { instant as other };\n${page}`)).toBe(
        `const instant = 1;\nexport { instant as other };\n${page}\nconst instant$1 = false;\nexport { instant$1 as instant };\n`,
      );
    });

    it('is told it may block where its page only mentions an `instant` export: in a comment, a string or a template literal', () => {
      const page = 'export default async function Page() {\n  return null;\n}\n';
      const mentions = [
        '// export const instant = true;\n',
        '/*\nexport { blocking as instant };\n*/\n',
        "const usage = 'export const instant = true';\n",
        `const usage = \`\nexport { instant } from \${"a module"}\n\`;\n`,
      ];

      for (const mention of mentions) {
        expect(instantLoader(`${mention}${page}`)).toBe(
          `${mention}${page}\nexport const instant = false;\n`,
        );
      }
    });

    it('reads the page’s own `instant` export past a quote of JSX’s text, a template literal’s code and a regular expression', () => {
      const page = 'export default async function Page() {\n  return null;\n}\n';
      const exporting = [
        "const note = <p>Don't</p>;\nexport const instant = true;\n",
        `const at = \`\${{ a: 1 }.a}\`;\nexport { at as instant };\n`,
        'const slashes = /\\/*/u;\nexport const instant = true;\n',
      ];

      for (const exported of exporting) {
        expect(instantLoader(`${exported}${page}`)).toBe(`${exported}${page}`);
      }
    });
  });

  describe('a route under middleware', () => {
    it('is sent to the compile’s route, unless that route asks for the page itself', async () => {
      vi.stubEnv(DELIVERY_KEY_ENV, '');
      const dir = project([
        route({ middleware: ['status/[projectId]'], route: '/status/[projectId]' }),
      ]);

      const config = await modified(dir);
      const key = process.env[DELIVERY_KEY_ENV] ?? '';

      expect(key).toMatch(/^[\w-]{43}$/u);
      expect(config.env).toStrictEqual({ [DELIVERY_KEY_ENV]: key });
      await expect(rewritesOf(config)).resolves.toStrictEqual({
        afterFiles: [
          {
            destination: '/api/reactive-state/deliver/L3N0YXR1cy9bcHJvamVjdElkXQ/:param0',
            missing: [{ key: DIRECT_HEADER, type: 'header', value: key }],
            source: '/status/:param0',
          },
        ],
        beforeFiles: [],
      });
    });

    it('makes a delivery key of one spelling — letters, digits, `-` and `_`, which neither a URL, JSON nor HTML escapes — that a page reflects as it is, where the delivery route finds it', async () => {
      vi.stubEnv(DELIVERY_KEY_ENV, '');
      await modified(project([route({ middleware: [''] })]));
      const key = process.env[DELIVERY_KEY_ENV] ?? '';
      const html = key.replaceAll(/[&<>"']/gu, (special) => `&#${String(special.codePointAt(0))};`);

      expect(key).toMatch(/^[\w-]{43}$/u);
      expect([encodeURIComponent(key), encodeURI(key), JSON.stringify(key), html]).toStrictEqual([
        key,
        key,
        `"${key}"`,
        key,
      ]);
    });

    it('is given the delivery key the build’s environment holds, which its other processes read', async () => {
      vi.stubEnv(DELIVERY_KEY_ENV, 'a-key-the-first-process-made_0123');
      const dir = project([route({ middleware: [''] })]);

      const config = await modified(dir);

      expect(config.env).toStrictEqual({ [DELIVERY_KEY_ENV]: 'a-key-the-first-process-made_0123' });
      await expect(rewritesOf(config)).resolves.toMatchObject({
        afterFiles: [
          { missing: [{ key: DIRECT_HEADER, value: 'a-key-the-first-process-made_0123' }] },
        ],
      });
    });

    it('is matched by each of its segments as Next.js names them', async () => {
      const dir = project([
        route({
          middleware: [''],
          params: ['project-id', 'rest'],
          route: '/v1.0/[project-id]/files/[[...rest]]',
        }),
        route({ middleware: [''], params: ['$project'], route: '/boards/[$project]' }),
      ]);

      const rewrites = await rewritesOf(await modified(dir));

      // In the order Next.js matches the routes: of its static segments, by name.
      expect(rewrites).toMatchObject({
        afterFiles: [
          {
            destination: '/api/reactive-state/deliver/L2JvYXJkcy9bJHByb2plY3Rd/:param0',
            source: '/boards/:param0',
          },
          {
            destination:
              '/api/reactive-state/deliver/L3YxLjAvW3Byb2plY3QtaWRdL2ZpbGVzL1tbLi4ucmVzdF1d/:param0/:param1*',
            source: String.raw`/v1\.0/:param0/files/:param1*`,
          },
        ],
      });
    });

    it('delivers a page under every spelling of its path Next.js and upwind’s runtime serve it at: each character as written or escaped, of either case, its slashes too', async () => {
      const page = (name: string, file: string): RouteRegistration =>
        route({ middleware: [''], page: file, params: [], props: {}, route: name });
      const dir = project([
        page('/', 'page.tsx'),
        page('/projects', 'projects/page.tsx'),
        page('/account/settings', 'account/settings/page.tsx'),
        page('/café', 'café/page.tsx'),
        page('/_admin', '%5Fadmin/page.tsx'),
        route({ middleware: [''] }),
      ]);

      const delivered = deliveriesIn(await rewritesOf(await modified(dir)));
      const at = (pathname: string): readonly (boolean | string | undefined)[] =>
        deliveryAt(delivered, pathname);

      for (const spelling of ['/', '/%2F', '/%2f']) {
        expect(at(spelling)).toStrictEqual(deliveredAt('/'));
      }
      for (const spelling of [
        '/projects',
        '/%70rojects',
        '/proj%65cts',
        '/%70%72%6F%6A%65%63%74%73',
        '/%70%72%6f%6a%65%63%74%73',
        '/projects/',
        '/projects%2F',
        '/PROJECTS',
      ]) {
        expect(at(spelling)).toStrictEqual(deliveredAt('/projects'));
      }
      for (const spelling of [
        '/account/settings',
        '/account%2Fsettings',
        '/%61ccount%2fsettings',
      ]) {
        expect(at(spelling)).toStrictEqual(deliveredAt('/account/settings'));
      }
      for (const spelling of ['/caf%C3%A9', '/caf%c3%a9', '/café']) {
        expect(at(spelling)).toStrictEqual(deliveredAt('/café'));
      }
      for (const spelling of ['/_admin', '/%5Fadmin', '/%5fadmin']) {
        expect(at(spelling)).toStrictEqual(deliveredAt('/_admin'));
      }
      for (const spelling of ['/boards/p1', '/boards/p1/', '/BOARDS/p1']) {
        expect(at(spelling)).toStrictEqual(deliveredAt('/boards/[projectId]', '/p1'));
      }
      for (const spelling of ['/projectsx', '/%70roject']) {
        expect(at(spelling)).toStrictEqual([undefined, false]);
      }
      // The root's path as path-to-regexp reads its source, before Next.js makes a slash optional.
      const root = delivered.find(({ destination }) => destination.endsWith(routeKeyOf('/')));

      expect(root && compiled(root, false).test('/')).toBe(true);
    });

    it('matches a route of a dynamic segment as Next.js and upwind’s runtime do: its static segments as written, as one escaped is another route’s path', async () => {
      const section = route({
        middleware: [''],
        page: '[section]/[id]/page.tsx',
        params: ['section', 'id'],
        props: {},
        route: '/[section]/[id]',
      });
      const dir = project([route({ middleware: [''] }), section]);

      const delivered = deliveriesIn(await rewritesOf(await modified(dir)));

      expect(resolvedBy('/boards/[projectId]')('/%62oards/p1')).toBe(false);
      expect(resolvedBy('/[section]/[id]')('/%62oards/p1')).toStrictEqual({
        id: 'p1',
        section: 'boards',
      });
      expect(deliveryAt(delivered, '/%62oards/p1')).toStrictEqual(
        deliveredAt('/[section]/[id]', '/%62oards/p1'),
      );
      expect(deliveryAt(delivered, '/boards/p1')).toStrictEqual(
        deliveredAt('/boards/[projectId]', '/p1'),
      );
    });

    it('names each param of its rewrite by its place, none twice, so that Next.js sends each segment where the delivery route reads it', async () => {
      const placed = '/[$x]/[param0]';
      const files = '/files/[projectId]/[...rest]';
      const dir = project([
        route({ middleware: [''], params: ['$x', 'param0'], props: {}, route: placed }),
        route({ middleware: [''], params: ['projectId', 'rest'], route: files }),
      ]);

      const rewrites = await rewritesOf(await modified(dir));
      // Next.js matches the route of a static first segment first.
      const [second, first] = Array.isArray(rewrites) ? rewrites : (rewrites.afterFiles ?? []);

      expect(first).toMatchObject({
        destination: `/api/reactive-state/deliver/${routeKeyOf(placed)}/:param0/:param1`,
        source: '/:param0/:param1',
      });
      expect(first && rewrittenPath(first, '/a/b')).toBe(
        `/api/reactive-state/deliver/${routeKeyOf(placed)}/a/b`,
      );
      expect(second && rewrittenPath(second, '/files/p1/a/b')).toBe(
        `/api/reactive-state/deliver/${routeKeyOf(files)}/p1/a/b`,
      );
    });

    it('takes no request of the compile’s own route, which Next.js matches after the rewrites, whatever its pattern would match', async () => {
      const anywhere = '/[a]/[b]/[c]';
      const under = '/api/[b]/[c]';
      const dir = project([
        route({ middleware: [''], params: ['a', 'b', 'c'], props: {}, route: anywhere }),
        route({ middleware: [''], params: ['b', 'c'], props: {}, route: under }),
      ]);

      const rewrites = await rewritesOf(await modified(dir));
      const delivered = Array.isArray(rewrites) ? rewrites : (rewrites.afterFiles ?? []);
      const at = (pathname: string): readonly (string | undefined)[] =>
        delivered.map((rewrite) => rewrittenPath(rewrite, pathname));

      expect(delivered.map((rewrite) => rewrite.source)).toStrictEqual([
        '/api/:param0((?!reactive-state/)[^/]+?)/:param1',
        '/:param0((?!api/reactive-state/)[^/]+?)/:param1/:param2',
      ]);
      expect(at('/api/reactive-state/events')).toStrictEqual([undefined, undefined]);
      expect(at('/api/reactive-state/deliver/x')).toStrictEqual([undefined, undefined]);
      expect(at('/api/items/1')).toStrictEqual([
        `/api/reactive-state/deliver/${routeKeyOf(under)}/items/1`,
        `/api/reactive-state/deliver/${routeKeyOf(anywhere)}/api/items/1`,
      ]);
      expect(at('/x/reactive-state/events')).toStrictEqual([
        undefined,
        `/api/reactive-state/deliver/${routeKeyOf(anywhere)}/x/reactive-state/events`,
      ]);
    });

    it.each(['/API', '/aPi', '/api'])(
      'keeps internal requests off case-variant rewrite prefixes %s',
      async (prefix) => {
        const name = `${prefix}/[namespace]/[part]`;
        const dir = project([
          route({ middleware: [''], params: ['namespace', 'part'], props: {}, route: name }),
        ]);
        const delivered = deliveriesIn(await rewritesOf(await modified(dir)));

        expect(deliveryAt(delivered, '/api/reactive-state/events')).toStrictEqual([
          undefined,
          false,
        ]);
        expect(deliveryAt(delivered, `${prefix}/items/1`)).toStrictEqual(
          deliveredAt(name, '/items/1'),
        );
      },
    );

    it('preserves an explicitly sensitive rewrite namespace with a distinct static case', async () => {
      const name = '/API/[namespace]/[part]';
      const dir = project([
        route({ middleware: [''], params: ['namespace', 'part'], props: {}, route: name }),
      ]);
      const config = completeConfig({ experimental: { caseSensitiveRoutes: true } });
      const delivered = deliveriesIn(await rewritesOf(await modified(dir, config)));
      const first = delivered[0];
      const match = getPathMatch(first?.source ?? '', {
        regexModifier: modifyRouteRegex,
        removeUnnamedParams: true,
        strict: true,
        sensitive: true,
      });

      expect(match('/api/reactive-state/events')).toBe(false);
      expect(match('/API/reactive-state/events')).not.toBe(false);
      expect(first?.source).toBe('/API/:param0/:param1');
    });

    it.each([
      {
        name: 'default app dynamic',
        pattern: '/hub/[section]/[id]',
        free: 'src/app/HUB/admin/[id]/page.tsx',
        refused: true,
        sensitive: false,
        guarded: false,
      },
      {
        name: 'default pages dynamic',
        pattern: '/hub/[section]/[id]',
        free: 'src/pages/HUB/admin/[id].tsx',
        refused: true,
        sensitive: false,
        guarded: false,
      },
      {
        name: 'static before-files',
        pattern: '/hub/items',
        free: 'src/app/HUB/items/page.tsx',
        refused: true,
        sensitive: false,
        guarded: false,
      },
      {
        name: 'equal dynamic ranks',
        pattern: '/hub/[section]/[id]',
        free: 'src/app/HUB/[section]/[id]/page.tsx',
        refused: true,
        sensitive: false,
        guarded: false,
      },
      {
        name: 'native-disjoint less specific',
        pattern: '/hub/admin/[id]',
        free: 'src/app/HUB/[section]/[id]/page.tsx',
        refused: true,
        sensitive: false,
        guarded: false,
      },
      {
        name: 'explicit sensitive keeps paths distinct',
        pattern: '/hub/[section]/[id]',
        free: 'src/app/HUB/admin/[id]/page.tsx',
        sensitive: true,
        refused: false,
        guarded: false,
      },
      {
        name: 'unrelated prefix',
        pattern: '/hub/[section]/[id]',
        free: 'src/app/other/admin/[id]/page.tsx',
        refused: false,
        sensitive: false,
        guarded: false,
      },
      {
        name: 'fixed file precedes after-files',
        pattern: '/hub/[section]/[id]',
        free: 'src/app/HUB/admin/new/page.tsx',
        refused: false,
        sensitive: false,
        guarded: false,
      },
      {
        name: 'literal regex metacharacters',
        pattern: '/a+b/[section]/[id]',
        free: 'src/app/aXb/admin/[id]/page.tsx',
        refused: false,
        sensitive: false,
        guarded: false,
      },
      {
        name: 'legacy insensitive Kelvin distinction',
        pattern: '/k/[section]/[id]',
        free: 'src/app/K/admin/[id]/page.tsx',
        refused: false,
        sensitive: false,
        guarded: false,
      },
      {
        name: 'internal namespace stays excluded',
        pattern: '/api/[namespace]/[part]',
        free: 'src/app/API/reactive-state/[part]/page.tsx',
        refused: false,
        sensitive: false,
        guarded: false,
      },
      {
        name: 'optional internal root still overlaps',
        pattern: '/api/[namespace]',
        free: 'src/app/API/reactive-state/[[...rest]]/page.tsx',
        refused: true,
        sensitive: false,
        guarded: false,
      },
      {
        name: 'mixed-case pages dynamic',
        pattern: '/HUB/[id]',
        free: 'src/pages/hub/[id].tsx',
        refused: true,
        sensitive: false,
        guarded: false,
      },
      {
        name: 'other route already has middleware',
        pattern: '/hub/[section]/[id]',
        free: 'src/app/HUB/admin/[id]/page.tsx',
        guarded: true,
        refused: true,
        sensitive: false,
      },
    ])(
      'checks case-variant delivery shadows: $name',
      async ({ pattern, free, sensitive, guarded, refused }) => {
        const params = pattern
          .split('/')
          .flatMap((segment) => (segment.startsWith('[') ? [segment.slice(1, -1)] : []));
        const dir = project([
          route({ middleware: ['guarded'], params, props: {}, route: pattern }),
        ]);
        const target = path.join(dir, free);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, 'export default function Page() { return null; }\n');
        writeShadowMiddleware(target, guarded);
        const config = completeConfig({ experimental: { caseSensitiveRoutes: sensitive } });
        const reason = await configReason(dir, config);
        const expected = ['', expect.stringContaining('case-insensitive delivery rewrite')];

        expect(reason).toStrictEqual(expected[Number(refused)]);
      },
    );

    it('is matched in the order Next.js matches its routes: of two that overlap, the more specific first', async () => {
      const generic = '/[section]/[id]';
      const admin = '/admin/[id]';
      const dir = project([
        route({ middleware: [''], params: ['section', 'id'], props: {}, route: generic }),
        route({ middleware: ['admin'], params: ['id'], props: {}, route: admin }),
      ]);

      const rewrites = await rewritesOf(await modified(dir));
      const delivered = Array.isArray(rewrites) ? rewrites : (rewrites.afterFiles ?? []);
      const first = delivered
        .map((rewrite) => rewrittenPath(rewrite, '/admin/1'))
        .find((rewritten) => rewritten !== undefined);

      expect(first).toBe(`/api/reactive-state/deliver/${routeKeyOf(admin)}/1`);
    });

    it('is sent to the compile’s route where it renders no reactive root too — a page of none, a route handler — before the files where it has no dynamic segment, after them where it has one', async () => {
      const items: PlainRouteRegistration = {
        file: 'api/items/[itemId]/route.ts',
        guarded: true,
        middleware: ['', 'api'],
        params: ['itemId'],
        plain: 'handler',
        route: '/api/items/[itemId]',
      };
      const signIn: PlainRouteRegistration = {
        file: 'sign-in/page.tsx',
        middleware: [''],
        params: [],
        plain: 'page',
        route: '/sign-in',
      };
      const dir = project([items, route({ middleware: [''] }), signIn]);

      const config = await modified(dir);
      const key = process.env[DELIVERY_KEY_ENV] ?? '';

      await expect(rewritesOf(config)).resolves.toStrictEqual({
        afterFiles: [
          {
            destination: `/api/reactive-state/deliver/${routeKeyOf(items.route)}/:param0`,
            missing: [{ key: DIRECT_HEADER, type: 'header', value: key }],
            source: '/api/items/:param0',
          },
          {
            destination: `/api/reactive-state/deliver/${routeKeyOf('/boards/[projectId]')}/:param0`,
            missing: [{ key: DIRECT_HEADER, type: 'header', value: key }],
            source: '/boards/:param0',
          },
        ],
        beforeFiles: [
          {
            destination: `/api/reactive-state/deliver/${routeKeyOf(signIn.route)}`,
            missing: [{ key: DIRECT_HEADER, type: 'header', value: key }],
            source: `/${spelled('sign-in')}{${SLASH}}?`,
          },
        ],
      });

      // A route of no reactive root is let block by nothing, and gated by nothing.
      const alone = await modified(project([signIn]));

      expect(rulesOf(alone)).not.toHaveProperty('page.tsx');
    });

    it('refuses a manifest of a route of no reactive root it cannot read', async () => {
      const dir = project([
        {
          file: 'sign-in/page.tsx',
          middleware: [''],
          params: [],
          plain: 'nothing',
          route: '/sign-in',
        },
      ] as unknown as readonly RegisteredRoute[]);

      await expect(modified(dir)).rejects.toThrow('registers routes this adapter cannot read');
    });

    it('is matched where Next.js matches its page, before the application’s own rewrites there: after the pages and files of no dynamic route where it has a dynamic segment, before them where it has none', async () => {
      // `/boards/new`, a page of its own beside `/boards/[projectId]`, is served before any
      // `afterFiles` rewrite is asked; `/dashboard`'s page is one such, which only `beforeFiles` is
      // asked before.
      const dashboard = route({
        middleware: [''],
        page: 'dashboard/page.tsx',
        params: [],
        props: {},
        route: '/dashboard',
      });
      const dir = project([route({ middleware: [''] }), dashboard]);
      const own = { destination: '/b', source: '/a' };

      const rewrites = await rewritesOf(
        await modified(
          dir,
          completeConfig({
            rewrites: () =>
              Promise.resolve({ afterFiles: [own], beforeFiles: [own], fallback: [own] }),
          }),
        ),
      );

      expect(rewrites).toMatchObject({
        afterFiles: [{ source: '/boards/:param0' }, own],
        beforeFiles: [{ source: `/${spelled('dashboard')}{${SLASH}}?` }, own],
        fallback: [own],
      });
    });

    it('leaves the rewrites of an application without one as they are', async () => {
      const dir = project([route({ shared: true })]);

      await expect(modified(dir)).resolves.not.toHaveProperty('rewrites');
    });
  });

  describe('a shared route', () => {
    it('has its gate declared for the platform’s adapter, beside the gates declared already', async () => {
      vi.stubEnv(EDGE_GATE_ENV, '1');
      vi.stubEnv(ROUTE_GATES_ENV, JSON.stringify({ '/elsewhere': 'other' }));
      const dir = project([
        route({ shared: true }),
        route({ middleware: [''], route: '/delivered/[projectId]', shared: true }),
        route({ route: '/private/[projectId]' }),
      ]);

      await modified(dir);

      expect(JSON.parse(process.env[ROUTE_GATES_ENV] ?? '')).toStrictEqual({
        '/boards/[projectId]': GATE_NAME,
        '/elsewhere': 'other',
      });
    });

    it('is declared by a build alone, and refused where another gate answers it', async () => {
      vi.stubEnv(EDGE_GATE_ENV, '1');
      vi.stubEnv(ROUTE_GATES_ENV, '');
      const dir = project([route({ shared: true })]);

      await modified(dir, completeConfig(), 'phase-development-server');

      expect(process.env[ROUTE_GATES_ENV]).toBe('');

      vi.stubEnv(ROUTE_GATES_ENV, JSON.stringify({ '/boards/[projectId]': 'other' }));

      await expect(modified(dir)).rejects.toThrow(
        /has the gate other answer \/boards\/\[projectId\]/u,
      );
    });

    it('has no gate declared where the platform did not say its edge binds one', async () => {
      vi.stubEnv(EDGE_GATE_ENV, '');
      vi.stubEnv(ROUTE_GATES_ENV, '');

      await modified(project([route({ shared: true })]));

      expect(process.env[ROUTE_GATES_ENV]).toBe('');
    });
  });

  describe('the platform’s adapter', () => {
    it('is handed the config this one made, and its build’s outputs', async () => {
      const dir = project();
      const onBuildComplete = vi.fn();
      const modifyConfig = vi.fn((config: BuildConfig) => ({ ...config, assetPrefix: '/inner' }));
      const adapter = createReactiveAdapter({ modifyConfig, name: 'platform', onBuildComplete });
      const built = { buildId: 'b' } as unknown as Parameters<
        NonNullable<NextAdapter['onBuildComplete']>
      >[0];

      const config = await adapter.modifyConfig?.(completeConfig(), context(dir));
      await adapter.onBuildComplete?.(built);

      expect(adapter.name).toBe('reactive-state, platform');
      expect(modifyConfig).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ cacheComponents: true }),
        context(dir),
      );
      expect(config).toMatchObject({ assetPrefix: '/inner', cacheComponents: true });
      expect(onBuildComplete).toHaveBeenCalledExactlyOnceWith(built);
    });

    it('is none for a build that deploys nowhere, whose outputs nothing reads', () => {
      expect(createReactiveAdapter()).not.toHaveProperty('onBuildComplete');
      expect(createReactiveAdapter({ name: 'platform' })).not.toHaveProperty('onBuildComplete');
    });
  });

  describe('the application’s own rewrites', () => {
    /** The rewrite of `/old-boards/:id` to the board, as Next.js hands an adapter one. */
    const ONTO_BOARD = {
      destination: '/boards/$1',
      source: '/old-boards/:id',
      sourceRegex: String.raw`^\/old-boards(?:\/([^\/]+?))(?:\/)?$`,
    };

    /** The build of `config` as it completes, `own` after the adapter's own rewrites, if any. */
    async function completed(
      config: BuildConfig | undefined,
      own: readonly (typeof ONTO_BOARD)[],
    ): Promise<Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0]> {
      const ours = config?.rewrites === undefined ? [] : deliveriesIn(await rewritesOf(config));
      const afterFiles = ours.map((rule) => routed(rule));
      return {
        config: { ...config, basePath: '', trailingSlash: false },
        outputs: {
          appPages: [],
          appRoutes: [],
          pages: [],
          pagesApi: [],
          prerenders: [],
          staticFiles: [],
        },
        routing: {
          afterFiles: [...afterFiles, ...own],
          beforeFiles: [],
          beforeMiddleware: [],
          dynamicRoutes: [],
          fallback: [],
        },
      } as unknown as Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0];
    }

    it('refuse a build where one may send a request to a route under middleware, naming both, before the platform’s adapter is handed its outputs', async () => {
      const dir = project([route({ middleware: [''] })]);
      const onBuildComplete = vi.fn();
      const adapter = createReactiveAdapter({ name: 'platform', onBuildComplete });

      const config = await adapter.modifyConfig?.(completeConfig(), context(dir));
      const ours = await completed(config, []);
      const theirs = await completed(config, [ONTO_BOARD]);
      await adapter.onBuildComplete?.(ours);
      const refused = adapter.onBuildComplete?.(theirs);

      await expect(refused).rejects.toThrow(
        /^next\.config\.js has rewrites that may send a request/u,
      );
      await expect(refused).rejects.toThrow(
        '\n- the rewrite of /old-boards/:id to /boards/$1 (afterFiles) may send a request to /boards/[projectId], delivered through its route middleware\nMake each a redirect',
      );
      expect(onBuildComplete).toHaveBeenCalledExactlyOnceWith(ours);
    });

    it('are checked for a build that deploys nowhere once its config delivers a route, and Next.js prepares no outputs for one that delivers none', async () => {
      const delivered = context(project([route({ middleware: [''] })]));
      const none = context(project([route()]));
      const delivering = createReactiveAdapter();
      const config = await delivering.modifyConfig?.(completeConfig(), delivered);
      const nothing = createReactiveAdapter();
      await nothing.modifyConfig?.(completeConfig(), none);
      const built = await completed(config, [ONTO_BOARD]);

      await expect(delivering.onBuildComplete?.(built)).rejects.toThrow(
        /may send a request to \/boards\/\[projectId\]/u,
      );
      expect(nothing).not.toHaveProperty('onBuildComplete');
    });

    it('are not checked where no route is under middleware, though the platform’s adapter is handed the outputs', async () => {
      const onBuildComplete = vi.fn();
      const adapter = createReactiveAdapter({ name: 'platform', onBuildComplete });
      const none = context(project([route()]));
      const config = await adapter.modifyConfig?.(completeConfig(), none);
      const built = await completed(config, [ONTO_BOARD]);

      await adapter.onBuildComplete?.(built);

      expect(onBuildComplete).toHaveBeenCalledExactlyOnceWith(built);
    });

    it('is the one the environment names, by its module’s default export', async () => {
      const dir = project();
      const platform = path.join(dir, 'platform.mjs');
      writeFileSync(platform, "export default { name: 'platform' };\n");
      const nothing = path.join(dir, 'nothing.mjs');
      writeFileSync(nothing, 'export default 1;\n');

      vi.stubEnv(PLATFORM_ADAPTER_ENV, platform);
      vi.resetModules();
      const named = await import('../src/next/adapter.ts');
      vi.stubEnv(PLATFORM_ADAPTER_ENV, nothing);
      vi.resetModules();

      expect(named.default.name).toBe('reactive-state, platform');
      await expect(import('../src/next/adapter.ts')).rejects.toThrow(/no Next\.js adapter/u);
    });
  });
});

describe('blocking page instant JSX text', () => {
  it('keeps JSX prose from declaring the segment configuration', () => {
    const page =
      'export default async function Page({params}:{params:Promise<{id:string}>}){const{id}=await params;return <p>export const instant = true{id}</p>;}';

    expect(instantLoader(page)).toBe(`${page}\nexport const instant = false;\n`);
  });
});
