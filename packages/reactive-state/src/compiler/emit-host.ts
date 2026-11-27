/**
 * What the host — its build, its command — tells the compile beside the application's sources: how
 * the application reads its own signed-in session, where it signs its users in itself (`--session`),
 * how it applies a change of that session a server operation asks for (`--session-change`),
 * the private cache a root renders inside for a link's prefetch to carry it (`--prefetch`), whether
 * the deployment's cache keeps that render too, by the reader's session (`--prefetch-cache`), and
 * whether anything is shared at all (`--no-share`). Each changes what the compile writes around the
 * components, and nothing of how it reads them: given none, it writes what it wrote before any was.
 */

import { type CacheLifeValues, cacheLifeProfiles, profileLife } from './cache-life.ts';
import { ReactiveCompileError } from './errors.ts';

/** A module, and the export of it the compile's outputs import. */
export interface Named {
  readonly specifier: string;
  readonly name: string;
}

/**
 * How long a root's private cache keeps its render, as Next.js's `cacheLife` takes it: a profile the
 * application's config names, or the three values, in seconds.
 */
export type PrefetchLife =
  | { readonly profile: string }
  | { readonly stale: number; readonly revalidate: number; readonly expire: number };

export interface HostOptions {
  /** The application's session source (`SessionSource` of `./next`), where it signs in itself. */
  readonly session?: Named | undefined;
  /** The application's applier of a session change (`SessionChange` of `./next`). */
  readonly sessionChange?: Named | undefined;
  /** The application's hook that prepares an operation (`OperationPreparation` of `./next`). */
  readonly prepareOperation?: Named | undefined;
  /** The lifetime of a private root's cache, where its roots are to be carried by a prefetch. */
  readonly prefetch?: PrefetchLife | undefined;
  /**
   * `'remote'` where the deployment's cache keeps the roots a prefetch carries, by the reader's
   * session (`--prefetch-cache remote`); left out, the browser alone keeps them (`private`).
   */
  readonly prefetchCache?: 'remote' | undefined;
  /**
   * `false` where the application turned sharing off (`share: false`): no route's view is every
   * visitor's — each root renders for its own session alone. Left out, the compile shares what it
   * shows renders alike.
   */
  readonly share?: false | undefined;
}

/** Why nothing is shared of a build whose application turned sharing off (`share: false`). */
export const SHARING_OFF = 'the application turned sharing off (`share: false`)';

/**
 * `written` — `<specifier>#<export>`, as `@/db#db` — as the module and the export it names, or
 * `undefined` where it names no export of one.
 */
export function namedOf(written: string): Named | undefined {
  const at = written.lastIndexOf('#');
  const specifier = written.slice(0, at);
  const name = written.slice(at + 1);
  return at <= 0 || !/^[$A-Z_a-z][\w$]*$/u.test(name) ? undefined : { name, specifier };
}

/** The output the application's session source and session-change applier are re-exported from, beside the elements. */
export const REQUEST_SESSION = 'request-session';

/**
 * The least of each value a link's prefetch carries a private cache's render with, as Next.js 16.4
 * reads them: a `stale` under 30 seconds is no prefetch's, a `revalidate` of none or an `expire` under
 * five minutes makes the render a hole of the request's.
 */
const PREFETCH_FLOORS = { expire: 300, revalidate: 1, stale: 30 } as const;

/**
 * Why `life` is no lifetime a prefetch carries a render by, or nothing where it is one: a `stale`
 * under 30 seconds, a `revalidate` of none, or an `expire` under five minutes. Of the three values
 * written inline, a `revalidate` past its `expire` too, which Next.js throws for as `cacheLife` is
 * called; a profile's it throws for as it reads the config, of the values the config wrote.
 */
function lifeIssue(
  { expire = Infinity, revalidate = Infinity, stale = 0 }: CacheLifeValues,
  inline: boolean,
): string | undefined {
  if (
    stale < PREFETCH_FLOORS.stale ||
    revalidate < PREFETCH_FLOORS.revalidate ||
    expire < PREFETCH_FLOORS.expire
  ) {
    return 'stale 30 s at least, revalidate more than none, expire five minutes at least';
  }
  return inline && revalidate > expire
    ? 'its revalidate is past its expire, which Next.js refuses'
    : undefined;
}
/** What a profile's name may be: what an identifier of a config's key may be, dashes too. */
const PROFILE = /^[A-Za-z][\w-]*$/u;
/** The three values, as `--prefetch` writes them: `<stale>/<revalidate>/<expire>`. */
const VALUES = /^(\d+)\/(\d+)\/(\d+)$/u;

/**
 * `written` (`--prefetch`) as the lifetime it names — a profile's name, or `<stale>/<revalidate>/
 * <expire>` in seconds — or why it names none: a value a prefetch would not carry the render by,
 * or a profile that keeps a render by such values (`profileLife`: its own, `default`'s where it says
 * none). A profile is read of `profiles` (`cacheLifeProfiles`), the config's, where the host read
 * it — `withReactiveState`, the adapter — and a name it does not hold is refused; the command line,
 * which reads no config, holds Next.js's own profiles to that, and leaves any other name to Next.js.
 */
export function prefetchOf(
  written: string,
  profiles?: ReadonlyMap<string, CacheLifeValues>,
): PrefetchLife {
  const values = VALUES.exec(written);
  if (values === null) {
    if (!PROFILE.test(written)) {
      throw refusedPrefetch(
        `\`${written}\` is no cacheLife profile's name, nor <stale>/<revalidate>/<expire> in seconds.`,
      );
    }
    const life = profileLife(profiles ?? cacheLifeProfiles(), written);
    if (life === undefined && profiles !== undefined) {
      throw refusedPrefetch(
        `\`${written}\` names no cacheLife profile of the config, nor of Next.js.`,
      );
    }
    const issue = life === undefined ? undefined : lifeIssue(life, false);
    if (issue !== undefined) {
      throw refusedPrefetch(
        `The cacheLife profile \`${written}\` is no lifetime a prefetch carries a render by: ${issue}.`,
      );
    }
    return { profile: written };
  }
  const [stale, revalidate, expire] = values.slice(1).map(Number) as [number, number, number];
  const issue = lifeIssue({ expire, revalidate, stale }, true);
  if (issue !== undefined) {
    throw refusedPrefetch(
      `\`${written}\` is no lifetime a prefetch carries a render by: ${issue}.`,
    );
  }
  return { expire, revalidate, stale };
}

/** The refusal of a `--prefetch` that names no lifetime a prefetch carries a render by. */
function refusedPrefetch(message: string): ReactiveCompileError {
  return new ReactiveCompileError(message, {
    fileName: '--prefetch',
    position: { character: 0, line: 0 },
  });
}

/**
 * `written` (`--prefetch-cache`) as where the roots a prefetch carries are kept: `'remote'` for the
 * deployment's cache, or nothing for the browser's alone (`private`, as where it is not said).
 * Refused: a cache of another name; and a remote one where no prefetch names how long it keeps a
 * render (`host.prefetch`), or where sessions are the demo's — their id is the cookie's value, a
 * bearer, which no cache's key may hold — rather than the application's own (`host.session`).
 */
export function prefetchCacheOf(
  written: string | undefined,
  host: Pick<HostOptions, 'prefetch' | 'session'>,
): 'remote' | undefined {
  if (written === undefined || written === 'private') {
    return undefined;
  }
  if (written !== 'remote') {
    throw refusedCache(`\`${written}\` is no prefetch cache: \`private\` or \`remote\`.`);
  }
  if (host.prefetch === undefined) {
    throw refusedCache(
      "`--prefetch-cache remote` keeps the roots a link's prefetch carries in the deployment's cache, and no `--prefetch` names how long: name a lifetime.",
    );
  }
  if (host.session === undefined) {
    throw refusedCache(
      "`--prefetch-cache remote` keys each root it keeps by the reader's session, and the demo's session is its cookie's value, a bearer no cache's key may hold: name the application's own session source (`--session`).",
    );
  }
  return 'remote';
}

/** The refusal of a `--prefetch-cache` of no cache the roots may be kept in. */
function refusedCache(message: string): ReactiveCompileError {
  return new ReactiveCompileError(message, {
    fileName: '--prefetch-cache',
    position: { character: 0, line: 0 },
  });
}

/**
 * What a root's entry writes of its private cache, where it has one: the import, the lines its body
 * opens with, and the field `renderRoot` is told of it by.
 */
export function prefetchParts(life: PrefetchLife | undefined): {
  readonly imports: readonly string[];
  readonly body: readonly string[];
  readonly field: string;
} {
  return life === undefined
    ? { body: [], field: '', imports: [] }
    : {
        body: prefetchLines(life),
        field: 'prefetchable: true, ',
        imports: ["import { cacheLife } from 'next/cache';", ''],
      };
}

/** `life` as `cacheLife` is called with it: the profile's name, or the three values. */
function cacheLifeArgument(life: PrefetchLife): string {
  return 'profile' in life
    ? JSON.stringify(life.profile)
    : `{ expire: ${String(life.expire)}, revalidate: ${String(life.revalidate)}, stale: ${String(life.stale)} }`;
}

/**
 * The lines a prefetchable root's entry opens its body with: its private cache, kept by the browser
 * alone for as long as `life` says, which a link's prefetch carries — and those a kept root's
 * entry opens the function it reads the session by with (`keptBody`).
 */
export function prefetchLines(life: PrefetchLife): readonly string[] {
  return ["  'use cache: private';", `  cacheLife(${cacheLifeArgument(life)});`];
}

/**
 * The lines the function a root's entry keeps its render by opens with (`--prefetch-cache
 * remote`): the deployment's cache, for as long as `life` says — a prefetch carries what it keeps
 * by the same floors — under the tag of the bucket of the session it renders for (`keptRootTag`),
 * and that of the bucket of the session's user (`keptUserTag`), which every session of the user
 * shares, for the application to expire where it takes the reader's access away or grants it
 * (`expireKeptRootsOfUser`).
 */
export function keptLines(life: PrefetchLife): readonly string[] {
  return [
    "  'use cache: remote';",
    `  cacheLife(${cacheLifeArgument(life)});`,
    '  cacheTag(await keptRootTag(session), await keptUserTag(session.user));',
  ];
}

/** The line that re-exports the application's `named` export as `as`. */
function reexport(named: Named, as: string): string {
  return `export { ${named.name} as ${as} } from ${JSON.stringify(named.specifier)};`;
}

/**
 * The re-export of the application's session source, of its applier of a session change and of its
 * hook that prepares an operation (`<out>/request-session.ts`), which the elements, the stubs and
 * the route import them by: one name each, whatever the application's is.
 */
export function emitRequestSession(
  host: Pick<HostOptions, 'prepareOperation' | 'session' | 'sessionChange'>,
  header: string,
): string {
  return [
    header,
    ...(host.session === undefined ? [] : [reexport(host.session, 'session')]),
    ...(host.sessionChange === undefined ? [] : [reexport(host.sessionChange, 'sessionChange')]),
    ...(host.prepareOperation === undefined
      ? []
      : [reexport(host.prepareOperation, 'prepareOperation')]),
    '',
  ].join('\n');
}
