import type { SiteShape } from '../routing.ts';

/**
 * Where the site serves its routes, as Next.js compiled this build: its `basePath`, `trailingSlash`
 * and `skipTrailingSlashRedirect`, which Next.js writes into this module as it compiles it
 * (`process.env.__NEXT_ROUTER_BASEPATH`, `process.env.__NEXT_TRAILING_SLASH`,
 * `process.env.__NEXT_MANUAL_TRAILING_SLASH`, its `define-env`) — for the authority to ask for a
 * route's page where the site serves it, its gate to read a request's path as Next.js does, and the
 * delivery route to tell a request of its own path from one of a page's. Outside Next.js, a site
 * that serves each route at its own path.
 */
export function siteShape(): SiteShape {
  // Read by their whole names, as Next.js replaces them: the base path's text, and booleans.
  const basePath: unknown = process.env['__NEXT_ROUTER_BASEPATH'];
  const trailingSlash: unknown = process.env['__NEXT_TRAILING_SLASH'];
  const skipped: unknown = process.env['__NEXT_MANUAL_TRAILING_SLASH'];
  return {
    basePath: typeof basePath === 'string' ? basePath : '',
    trailingSlash: trailingSlash === true || trailingSlash === 'true',
    ...((skipped === true || skipped === 'true') && { skipTrailingSlashRedirect: true }),
  };
}
