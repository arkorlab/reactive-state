import { describe, expect, it } from 'vitest';

import type { Registry } from '../src/authority/programs.ts';
import { routeRegistryOf } from '../src/authority/route-registry.ts';
import { type ComponentProgram, PROTOCOL_VERSION } from '../src/program.ts';
import type { PlainRouteRegistration, RouteRegistration } from '../src/routing.ts';

/**
 * The routes a compile registered, as the authority checks them before anything is served
 * (`routeRegistryOf`): one whose path names a param in two of its segments — of which Next.js serves
 * no path, and whose params a request's, one value of each name, could not hold.
 */

const BUILD = 'b_routes';

/** The root the pages render. */
const board: ComponentProgram = {
  buildId: BUILD,
  component: 'components/board',
  evaluate: () => null,
  protocolVersion: PROTOCOL_VERSION,
  updaters: {},
  writable: [],
};

/** The programs the authority runs: the board's alone. */
const registry: Registry = {
  buildId: BUILD,
  operations: new Map(),
  programs: new Map([[board.component, board]]),
};

/** A page of the board at `route`, its root given each of `params` as a prop of the param's name. */
function page(route: string, params: readonly string[]): RouteRegistration {
  return {
    blocking: false,
    middleware: [],
    page: `${route.slice(1)}/page.tsx`,
    params,
    props: Object.fromEntries(params.map((param) => [param, param])),
    root: board.component,
    route,
    shared: false,
  };
}

/** A route handler at `route`, under the middleware `m`, which has no guard. */
function handler(route: string, params: readonly string[]): PlainRouteRegistration {
  return { file: `${route.slice(1)}/route.ts`, middleware: ['m'], params, plain: 'handler', route };
}

describe('a route whose path names a param twice', () => {
  it.each([
    ['a page', page('/boards/[id]/cards/[id]', ['id', 'id'])],
    ['a route handler', handler('/boards/[id]/cards/[id]', ['id', 'id'])],
  ])('is refused, as %s', (_what, route) => {
    expect(() => routeRegistryOf({ middleware: { m: null }, routes: [route] }, registry)).toThrow(
      'The route "/boards/[id]/cards/[id]" names the param "id" in two of its segments',
    );
  });

  // A pin, which passes before the change too: params of names of their own are taken.
  it('is not one of two params of names of their own, which is taken', () => {
    const route = page('/boards/[projectId]/cards/[cardId]', ['projectId', 'cardId']);

    expect(routeRegistryOf({ routes: [route] }, registry).routes.get(route.route)).toBe(route);
  });
});
