import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

import { type CacheLifeConfig, cacheLifeProfiles } from '../compiler/cache-life.ts';
import { prefetchOf } from '../compiler/emit-host.ts';
import { ReactiveCompileError } from '../compiler/errors.ts';
import { PAGE_EXTENSIONS } from '../compiler/page-extensions.ts';
import type { ProjectOptions } from './compile-on-build.ts';

/**
 * How an application connects reactive state to Next.js. A page imports a component's source —
 * `@/components/project.reactive` — as it would any component's; Turbopack hands the import the
 * root entry the compile wrote for it (`<out>/components/project.root.tsx`) in place of the source,
 * through a loader of this package. Turbopack alone: a build with webpack is not supported.
 *
 * An application writes none of it: the platform's commands build through the adapter
 * (`./adapter.ts`), which compiles the components and adds what is here to the config Next.js
 * read. One that wraps its `next.config.ts` in `withReactiveState`, as an application did before
 * the adapter, keeps the rule that sets, and the adapter adds no second one.
 *
 * Read by Next.js as it loads the config — natively, or compiled to CommonJS, where `import.meta.url`
 * is rewritten — and by the adapter; never bundled.
 */

export interface ReactiveStateOptions {
  /** Where the compile writes, from the application's root: `.reactive` unless said. */
  readonly out?: string;
  /** Where the application's components are, from its root: `src` unless said. */
  readonly src?: string;
  /** The application's root: the directory `next` runs in unless said. */
  readonly root?: string;
  /** The module and the export the application's database is: `@/db#db` unless said. */
  readonly database?: string;
  /**
   * The module and the export the application reads its own signed-in session by (`SessionSource`
   * of `./next`), where it signs its users in itself: `<specifier>#<export>`. Unless said, sessions
   * are the demo's.
   */
  readonly session?: string;
  /**
   * The module and the export that applies the change of the application's own session a server
   * operation asks for with `changeSession` (`SessionChange` of `./next`): `<specifier>#<export>`.
   * It runs on the application's server, after the operation succeeded and before its page renders
   * again. Unless said, a change is logged and left unapplied.
   */
  readonly sessionChange?: string;
  /**
   * The module and the export that prepares an operation on the application's server, before its
   * Server Action calls the authority (`OperationPreparation` of `./next`): `<specifier>#<export>`.
   * What it answers, JSON of 4 KiB at most, travels with the call, and the operation reads it with
   * `prepared()` of `./server`. Unless said, nothing is prepared.
   */
  readonly prepareOperation?: string;
  /**
   * The private cache each root the request alone renders is rendered inside, for a link's prefetch
   * to carry it: a `cacheLife` profile of the config, or `<stale>/<revalidate>/<expire>` in seconds.
   * Unless said, no root is cached.
   */
  readonly prefetch?: string;
  /**
   * Where the roots a prefetch carries are kept: `'private'`, by the browser alone, unless said; or
   * `'remote'`, by the deployment's cache too — keyed by the reader's session, for a reload, a new
   * tab or a prefetch to be answered without the authority — of an application that names its
   * `prefetch` and its own `session`. A root of a persistent state, or of a route, stays private.
   */
  readonly prefetchCache?: 'private' | 'remote';
  /**
   * `false` turns sharing off: the compile shares no route's view, and every root renders for its
   * own session. Unless said, it shares what it shows renders alike for every visitor.
   */
  readonly share?: boolean;
}

/** What the loader is given, as Turbopack hands a loader its options: JSON. */
export interface LoaderOptions {
  readonly root: string;
  readonly src: string;
  readonly out: string;
  readonly database?: string;
  readonly session?: string;
  readonly sessionChange?: string;
  readonly prepareOperation?: string;
  readonly prefetch?: string;
  readonly prefetchCache?: string;
  /** `off` where the application turned sharing off (`share: false`). */
  readonly share?: 'off';
  readonly [key: string]: string;
}

/** The rules of a config's Turbopack, by the glob each matches. */
export type TurbopackRules = NonNullable<NonNullable<NextConfig['turbopack']>['rules']>;

/** What a config holds under one glob: a rule, or a list of rules or of loaders. */
type RuleCollection = TurbopackRules[string];

/** One rule: the loaders it runs, on the files its condition holds of. */
export type TurbopackRule = Exclude<RuleCollection, readonly unknown[]>;

/** The sources the loader stands in for. */
export const REACTIVE_SOURCES = '*.reactive.tsx';

/** This package: published as its TypeScript sources, which the application's build compiles. */
const PACKAGE = '@arkorlab/reactive-state';

/** The loader, by its path: Turbopack runs it in Node. */
export const LOADER = fileURLToPath(new URL('loader.cjs', import.meta.url));

/** The loader that lets a page block on its params (`instantRule`), by its path. */
export const INSTANT_LOADER = fileURLToPath(new URL('loader-instant.cjs', import.meta.url));

/** The loader's options for `options`, the application's root resolved. */
export function loaderOptions(options: ReactiveStateOptions = {}): LoaderOptions {
  const { database, prefetch, prefetchCache, prepareOperation, session, sessionChange } = options;
  return {
    out: options.out ?? '.reactive',
    root: path.resolve(options.root ?? process.cwd()),
    src: options.src ?? 'src',
    ...(database !== undefined && { database }),
    ...(session !== undefined && { session }),
    ...(sessionChange !== undefined && { sessionChange }),
    ...(prepareOperation !== undefined && { prepareOperation }),
    ...(prefetch !== undefined && { prefetch }),
    ...(prefetchCache !== undefined && { prefetchCache }),
    ...(options.share === false && { share: 'off' as const }),
  };
}

/** The rule that hands an import of a `.reactive.tsx` source its root entry, as `loader` says. */
export function reactiveRule(loader: LoaderOptions): TurbopackRule {
  return {
    as: '*.tsx',
    // An application's own sources alone: a dependency's are no compile's of the application.
    condition: { not: 'foreign' },
    loaders: [{ loader: LOADER, options: loader }],
  };
}

/** Whether `loader` is this package's loader, by whichever path to it. */
function isOurLoader(loader: string): boolean {
  if (loader === LOADER) {
    return true;
  }
  try {
    return realpathSync(loader) === realpathSync(LOADER);
  } catch {
    return false;
  }
}

function isLoaderOptions(value: unknown): value is LoaderOptions {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { database, out, root, share, src } = value as Partial<Record<string, unknown>>;
  const { prefetch, prefetchCache, prepareOperation, session, sessionChange } = value as Partial<
    Record<string, unknown>
  >;
  return (
    typeof out === 'string' &&
    typeof root === 'string' &&
    typeof src === 'string' &&
    [database, prefetch, prefetchCache, prepareOperation, session, sessionChange].every(
      (each) => each === undefined || typeof each === 'string',
    ) &&
    (share === undefined || share === 'off')
  );
}

/** The loaders a config lists under one glob: those of each rule, and those listed bare. */
function loadersIn(collection: RuleCollection): readonly unknown[] {
  const items: readonly unknown[] = Array.isArray(collection) ? collection : [collection];
  return items.flatMap((item): readonly unknown[] => {
    if (typeof item === 'object' && item !== null && 'loaders' in item) {
      return Array.isArray(item.loaders) ? item.loaders : [];
    }
    return [item];
  });
}

/**
 * The options of this package's loader in `collection` — what a config holds under
 * `REACTIVE_SOURCES` — where `withReactiveState` set it; none where no loader there is this
 * package's.
 */
export function loaderOptionsOf(collection: RuleCollection): LoaderOptions | undefined {
  for (const loader of loadersIn(collection)) {
    if (typeof loader === 'object' && loader !== null && 'loader' in loader) {
      const { loader: file, options } = loader as {
        readonly loader: unknown;
        readonly options?: unknown;
      };
      if (typeof file === 'string' && isOurLoader(file) && isLoaderOptions(options)) {
        return options;
      }
    }
  }
  return undefined;
}

/** What the compile is given of `loader`, the options of this package's rule. */
export function projectOfLoader(loader: LoaderOptions): ProjectOptions {
  const { database, out, root, share, src } = loader;
  const { prefetch, prefetchCache, prepareOperation, session, sessionChange } = loader;
  return {
    out,
    projectDir: root,
    src,
    ...(database !== undefined && { database }),
    ...(session !== undefined && { session }),
    ...(sessionChange !== undefined && { sessionChange }),
    ...(prepareOperation !== undefined && { prepareOperation }),
    ...(prefetch !== undefined && { prefetch }),
    ...(prefetchCache !== undefined && { prefetchCache }),
    ...(share === 'off' && { share: false }),
  };
}

/** `packages` with this package among them, once. */
export function withPackage(packages: readonly string[] | undefined): string[] {
  return [...new Set([...(packages ?? []), PACKAGE])];
}

/**
 * Refuses the `pageExtensions` of `configFile` where they are other than Next.js's own, in any
 * order — `tsx`, `ts`, `jsx` and `js`, the extensions the compile reads an app directory's pages,
 * layouts and the rest by: a page of another (`page.page.tsx`, `page.mdx`) would be a route the
 * compile never registers, its reactive root rendered with none of the guards of the route
 * middleware around it, and its route never delivered through that middleware. A config that says
 * none has Next.js's own.
 */
export function requirePageExtensions(
  given: readonly string[] | undefined,
  configFile: string,
): void {
  if (
    given === undefined ||
    (given.length === PAGE_EXTENSIONS.length &&
      PAGE_EXTENSIONS.every((extension) => given.includes(extension)))
  ) {
    return;
  }
  throw new Error(
    `${configFile} sets \`pageExtensions\` to ${JSON.stringify(given)}, and @arkorlab/reactive-state reads an app directory's pages and layouts by Next.js's own, ${JSON.stringify(PAGE_EXTENSIONS)}: a page of another would be a route it never registers, whose reactive root renders without the guards of the route middleware around it. Remove the option, and name the pages by those.`,
  );
}

/**
 * `nextConfig`, with the Turbopack rule that hands an import of a `.reactive.tsx` source its root
 * entry, and with this package among those it compiles. Every rule `nextConfig` has is kept; one of
 * its own for the same sources is refused, as the two could not both apply, and so are page
 * extensions other than Next.js's own (`requirePageExtensions`).
 */
export function withReactiveState(
  nextConfig: NextConfig = {},
  options: ReactiveStateOptions = {},
): NextConfig {
  requirePageExtensions(nextConfig.pageExtensions, 'The config withReactiveState is given');
  const rules = nextConfig.turbopack?.rules ?? {};
  if (Object.hasOwn(rules, REACTIVE_SOURCES)) {
    throw new Error(
      `turbopack.rules already has a rule for ${REACTIVE_SOURCES}, which withReactiveState sets: remove it.`,
    );
  }
  const loader = loaderOptions(options);
  requirePrefetchLife(loader.prefetch, nextConfig, 'withReactiveState');
  return {
    ...nextConfig,
    transpilePackages: withPackage(nextConfig.transpilePackages),
    turbopack: {
      ...nextConfig.turbopack,
      rules: { ...rules, [REACTIVE_SOURCES]: reactiveRule(loader) },
    },
  };
}

/**
 * Refuses a `prefetch` that names no lifetime a link's prefetch carries a render by, of the
 * config's `cacheLife` profiles as Next.js reads them (`cacheLifeProfiles`, `prefetchOf`), as `who`
 * reads the config: as the application wrote it (`withReactiveState`), or as Next.js filled it in
 * (the adapter), alike. A render of each root would else fail, or never be carried.
 */
export function requirePrefetchLife(
  prefetch: string | undefined,
  config: CacheLifeConfig,
  who: string,
): void {
  if (prefetch === undefined) {
    return;
  }
  try {
    prefetchOf(prefetch, cacheLifeProfiles(config));
  } catch (error) {
    if (error instanceof ReactiveCompileError) {
      throw new TypeError(`${who}: ${error.reason}`, { cause: error });
    }
    throw error;
  }
}

/** What a regular expression reads as syntax of its own, each to be escaped. */
const REGEXP_SYNTAX = /[$()*+.?[\\\]^{|}]/gu;

/**
 * The rule that lets each of `pages` — files from the application's root, `/`-separated — block on
 * its params as Cache Components prerenders it: a page that awaits its params outside any
 * `<Suspense>` to render a root of them, which the build refuses unless the page says it may
 * (`export const instant = false`). Its loader says so for a page that says nothing of it, and
 * leaves alone one that exports `instant` itself. Held to those very files by their path, under
 * whatever glob their file name has.
 */
export function instantRule(pages: readonly string[]): TurbopackRule {
  const alternatives = pages.map((page) => page.replaceAll(REGEXP_SYNTAX, String.raw`\$&`));
  return {
    condition: {
      all: [
        { not: 'foreign' },
        // Turbopack matches a path from the project, anywhere in it: anchored at its end and at a
        // directory's start, this is each page and nothing beside it. Each path is escaped whole.
        // eslint-disable-next-line security/detect-non-literal-regexp -- see above
        { path: new RegExp(`(?:^|/)(?:${alternatives.join('|')})$`, 'u') },
      ],
    },
    loaders: [INSTANT_LOADER],
  };
}

/** A loader a rule runs: by its path or its package, with its options or without. */
type LoaderItem = NonNullable<TurbopackRule['loaders']>[number];

/** Whether a listed `item` is a loader rather than a rule of its own. */
function isLoaderItem(item: LoaderItem | TurbopackRule): item is LoaderItem {
  return typeof item === 'string' || !('loaders' in item || 'type' in item || 'condition' in item);
}

/**
 * `rules` with `rule` under `glob`, after whatever the application has there: Turbopack runs every
 * rule that matches a file, in order.
 */
export function withRule(
  rules: TurbopackRules | undefined,
  glob: string,
  rule: TurbopackRule,
): TurbopackRules {
  const own = rules?.[glob];
  if (own === undefined) {
    return { ...rules, [glob]: rule };
  }
  if (!Array.isArray(own)) {
    return { ...rules, [glob]: [own, rule] };
  }
  // A list of loaders alone is one rule that runs them; a list with rules in it, each as it is.
  const loaders = own.filter(isLoaderItem);
  return {
    ...rules,
    [glob]: loaders.length === own.length ? [{ loaders }, rule] : [...own, rule],
  };
}
