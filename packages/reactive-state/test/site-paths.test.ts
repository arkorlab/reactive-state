import { describe, expect, it } from 'vitest';

import type { SiteShape } from '../src/routing.ts';
import { routePathOf, sameSite, sitePathOf } from '../src/site-paths.ts';

/**
 * A route's path where a site serves it, and back: under its base path, and with a slash after it
 * where Next.js 16.4.2 gives a path one under `trailingSlash` — a last segment of no dot — and none
 * where its redirects take the slash off, a last segment that names a file (`/rss.xml`), or leave
 * a path as it came, a dot in a name of no file's or a path under `/.well-known` at the root.
 */

const SLASHED: SiteShape = { basePath: '', trailingSlash: true };
const BASED: SiteShape = { basePath: '/docs', trailingSlash: true };
/** A base path that names a file, whose own root a redirect gives a slash all the same. */
const DOTTED: SiteShape = { basePath: '/docs.v1', trailingSlash: true };
const PLAIN: SiteShape = { basePath: '', trailingSlash: false };
/** A site that makes no trailing-slash redirect (`skipTrailingSlashRedirect`). */
const UNREDIRECTED: SiteShape = { ...SLASHED, skipTrailingSlashRedirect: true };

describe('the path a site serves a route at', () => {
  it.each([
    [SLASHED, '/', '/'],
    [SLASHED, '/boards/p1', '/boards/p1/'],
    [SLASHED, '/api/reactive-state/events', '/api/reactive-state/events/'],
    [SLASHED, '/rss.xml', '/rss.xml'],
    [SLASHED, '/files/a.txt', '/files/a.txt'],
    [SLASHED, '/files/a%20b.tar.gz', '/files/a%20b.tar.gz'],
    [SLASHED, '/files/v1.2-beta', '/files/v1.2-beta'],
    [SLASHED, '/files/.env', '/files/.env'],
    [SLASHED, '/files/a%2Etxt', '/files/a%2Etxt/'],
    [SLASHED, '/.well-known/keys', '/.well-known/keys'],
    [SLASHED, '/.WELL-KNOWN/keys', '/.WELL-KNOWN/keys'],
    [BASED, '/', '/docs/'],
    [BASED, '/boards/p1', '/docs/boards/p1/'],
    [BASED, '/rss.xml', '/docs/rss.xml'],
    [BASED, '/.well-known/keys', '/docs/.well-known/keys/'],
    [DOTTED, '/', '/docs.v1/'],
    [DOTTED, '/boards/p1', '/docs.v1/boards/p1/'],
    [DOTTED, '/rss.xml', '/docs.v1/rss.xml'],
    [PLAIN, '/', '/'],
    [PLAIN, '/boards/p1', '/boards/p1'],
    [PLAIN, '/rss.xml', '/rss.xml'],
  ])('serves a route of a site of %o at %s at %s', (shape, path, served) => {
    expect(sitePathOf(shape, path)).toBe(served);
    expect(routePathOf(shape, served)).toBe(path);
  });

  it.each([
    [SLASHED, '/boards/p1', '/boards/p1/', '/boards/p1'],
    [SLASHED, '/rss.xml', '/rss.xml', '/rss.xml/'],
    [SLASHED, '/files/a.txt', '/files/a.txt', '/files/a.txt/'],
    [BASED, '/', '/docs/', '/docs'],
    [DOTTED, '/', '/docs.v1/', '/docs.v1'],
    [BASED, '/.well-known/keys', '/docs/.well-known/keys/', '/docs/.well-known/keys'],
    [PLAIN, '/boards/p1', '/boards/p1', '/boards/p1/'],
    [PLAIN, '/.well-known/keys', '/.well-known/keys', '/.well-known/keys/'],
  ])(
    'reads a path of a site of %o as %s where Next.js serves it, %s, and as no route’s where it redirects it, %s',
    (shape, path, served, redirected) => {
      expect(routePathOf(shape, served)).toBe(path);
      expect(routePathOf(shape, redirected)).toBeUndefined();
    },
  );

  it.each([
    ['/files/v1.2-beta', '/files/v1.2-beta/'],
    ['/files/.env', '/files/.env/'],
    ['/.well-known/keys', '/.well-known/keys/'],
  ])(
    'reads a path Next.js serves either way under `trailingSlash`, %s and %s, as the one route’s',
    (bare, slashed) => {
      expect(routePathOf(SLASHED, bare)).toBe(bare);
      expect(routePathOf(SLASHED, slashed)).toBe(bare);
    },
  );

  it.each([
    [UNREDIRECTED, '/boards/p1', '/boards/p1/', '/boards/p1'],
    [UNREDIRECTED, '/rss.xml', '/rss.xml', '/rss.xml/'],
    [{ ...UNREDIRECTED, basePath: '/docs' }, '/', '/docs/', '/docs'],
    [{ ...PLAIN, skipTrailingSlashRedirect: true }, '/boards/p1', '/boards/p1', '/boards/p1/'],
  ] as const)(
    'serves a route of a site of %o that makes no trailing-slash redirect at %s as without one, %s, and reads either form as the route’s, %s too',
    (shape, path, served, other) => {
      expect(sitePathOf(shape, path)).toBe(served);
      expect(routePathOf(shape, served)).toBe(path);
      expect(routePathOf(shape, other)).toBe(path);
    },
  );

  it('tells a site that makes no trailing-slash redirect from one that makes them', () => {
    expect(sameSite(UNREDIRECTED, { ...SLASHED, skipTrailingSlashRedirect: true })).toBe(true);
    expect(sameSite(SLASHED, UNREDIRECTED)).toBe(false);
    expect(sameSite(UNREDIRECTED, SLASHED)).toBe(false);
  });
});
