/**
 * Next.js 16.4's `cacheLife` profiles, as a root's private cache keeps a render by one: a config's
 * profiles over Next.js's own, `default` filled in as Next.js fills it as it reads the config
 * (`config.js`), and each other profile's missing values `default`'s, as `cacheLife()` leaves what a
 * profile says nothing of to the cache's start (`cache-life.js`, `use-cache-wrapper.js`).
 */

/** A `cacheLife` profile as a config declares it: each value in seconds, where it says one. */
export interface CacheLifeValues {
  readonly stale?: number | undefined;
  readonly revalidate?: number | undefined;
  readonly expire?: number | undefined;
}

/** What a config tells of its profiles, as Next.js reads it: as much of a `NextConfig` as is read. */
export interface CacheLifeConfig {
  readonly cacheLife?: Readonly<Record<string, CacheLifeValues | undefined>> | undefined;
  /** What a `default` of no `expire` of its own expires at. */
  readonly expireTime?: number | undefined;
  readonly experimental?:
    | {
        /** `static`: what a `default` of no `stale` of its own is stale at. */
        readonly staleTimes?: { readonly static?: number | undefined } | undefined;
      }
    | undefined;
}

/** The seconds Next.js's profiles are written in. */
const SECONDS = {
  day: 86_400,
  fifteenMinutes: 900,
  fiveMinutes: 300,
  hour: 3600,
  minute: 60,
  month: 2_592_000,
  thirty: 30,
  week: 604_800,
  year: 31_536_000,
} as const;

/**
 * The profiles Next.js 16.4 declares (`config-shared.js`), which a config's own of the same name
 * replaces. `default` says no `stale`: it is filled in as the config is read (`cacheLifeProfiles`).
 */
const BUILT_IN_PROFILES: ReadonlyMap<string, CacheLifeValues> = new Map([
  ['days', { expire: SECONDS.week, revalidate: SECONDS.day, stale: SECONDS.fiveMinutes }],
  ['default', { expire: Infinity, revalidate: SECONDS.fifteenMinutes }],
  ['hours', { expire: SECONDS.day, revalidate: SECONDS.hour, stale: SECONDS.fiveMinutes }],
  ['max', { expire: SECONDS.year, revalidate: SECONDS.month, stale: SECONDS.fiveMinutes }],
  ['minutes', { expire: SECONDS.hour, revalidate: SECONDS.minute, stale: SECONDS.fiveMinutes }],
  ['seconds', { expire: SECONDS.minute, revalidate: 1, stale: SECONDS.thirty }],
  ['weeks', { expire: SECONDS.month, revalidate: SECONDS.week, stale: SECONDS.fiveMinutes }],
]);

/** What a `default` of no `stale` is stale at where the config sets no `staleTimes.static`. */
const STATIC_STALE = SECONDS.fiveMinutes;

/**
 * The profiles of `config` as Next.js 16.4 reads them: its own over Next.js's, and `default`'s
 * values filled in — `stale` of `experimental.staleTimes.static`, five minutes unless set;
 * `revalidate` Next.js's own; `expire` of `expireTime`, none unless set. Of no config — the command
 * line, which reads none — Next.js's own.
 */
export function cacheLifeProfiles(
  config: CacheLifeConfig = {},
): ReadonlyMap<string, CacheLifeValues> {
  const profiles = new Map(BUILT_IN_PROFILES);
  const own = config.cacheLife;
  if (own !== undefined) {
    for (const [name, values] of Object.entries(own)) {
      if (values !== undefined) {
        profiles.set(name, values);
      }
    }
  }
  const given = profiles.get('default') ?? {};
  const builtIn = BUILT_IN_PROFILES.get('default') ?? {};
  profiles.set('default', {
    expire: given.expire ?? config.expireTime ?? builtIn.expire,
    revalidate: given.revalidate ?? builtIn.revalidate,
    stale: given.stale ?? config.experimental?.staleTimes?.static ?? STATIC_STALE,
  });
  return profiles;
}

/**
 * What the profile `name` keeps a render by, of `profiles` (`cacheLifeProfiles`): each value its
 * own, or `default`'s where it says none; nothing for a profile `profiles` holds none of.
 */
export function profileLife(
  profiles: ReadonlyMap<string, CacheLifeValues>,
  name: string,
): CacheLifeValues | undefined {
  const own = profiles.get(name);
  if (own === undefined) {
    return undefined;
  }
  const fallback = profiles.get('default') ?? {};
  return {
    expire: own.expire ?? fallback.expire,
    revalidate: own.revalidate ?? fallback.revalidate,
    stale: own.stale ?? fallback.stale,
  };
}
