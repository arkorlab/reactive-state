import { describe, expect, it } from 'vitest';

import { AuthorityError } from '../src/authority/errors.ts';
import type { Core } from '../src/authority/model.ts';
import { registryOf } from '../src/authority/programs.ts';
import {
  type GuardedRoute,
  guardedRouteOf,
  guardRequestOf,
} from '../src/authority/route-guards.ts';
import { routeRegistryOf } from '../src/authority/route-registry.ts';

/**
 * The URL a guard request names, as the engine reads the route's params of it: a path and its
 * query, read against a base of the authority's own. One that reads as no URL there — a path the
 * parser takes for an empty host, or an invalid one — is refused as a request of no URL is (400),
 * never thrown as the parser's `TypeError`, which each host answers as a fault of its own.
 */

/** A page of no reactive root, under route middleware of no guard. */
const SETTINGS = '/edit/[projectId]/settings';

/** What the engine's calls share, of which reading a guard request reads the routes alone. */
const core = {
  routes: routeRegistryOf(
    {
      middleware: { account: null },
      routes: [
        {
          file: 'edit/[projectId]/settings/page.tsx',
          middleware: ['account'],
          params: ['projectId'],
          plain: 'page',
          route: SETTINGS,
        },
      ],
    },
    registryOf({ buildId: 'build-1', programs: [] }),
  ),
} as unknown as Core;

/** A guard request of the settings page's route, of `url`, read as the engine reads one. */
function guarded(url: string): GuardedRoute {
  return guardedRouteOf(core, guardRequestOf({ route: SETTINGS, url }));
}

/** What reading a guard request of `url` threw; nothing where it read one. */
function thrownBy(url: string): unknown {
  try {
    guarded(url);
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('the URL a guard request names', () => {
  it.each(['//', '//:80', '//[::1', '/\\'])(
    'refuses %s, which reads as no URL, as a request of none (400)',
    (url) => {
      const thrown = thrownBy(url);

      expect(thrown).toBeInstanceOf(AuthorityError);
      expect(thrown).toMatchObject({ code: 'INVALID_GUARD', status: 400 });
    },
  );

  it('reads the params of a path and its query, and refuses a path not of the route', () => {
    expect(guarded('/edit/p1/settings?tab=members')).toMatchObject({
      params: { projectId: 'p1' },
    });
    expect(thrownBy('/edit/p1/other')).toMatchObject({ code: 'INVALID_ROUTE', status: 400 });
  });
});
