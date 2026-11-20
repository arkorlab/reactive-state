import path from 'node:path';

import type {
  MiddlewareRegistration,
  PlainRouteRegistration,
  RouteRegistration,
} from '../routing.ts';
import { proxyOf } from './app-route.ts';
import { SHARING_OFF } from './emit-host.ts';
import { ReactiveCompileError } from './errors.ts';
import { checkUnderGuard } from './middleware-order.ts';
import { patternReads } from './middleware-reads.ts';
import { type MiddlewareSplit, readMiddleware } from './middleware.ts';
import type { Modules } from './modules.ts';
import { plainRoutesOf } from './plain-routes.ts';
import { type Facts, mergedFacts, Reach } from './reach.ts';
import { checkRoutes, type Registered } from './route-checks.ts';
import { paramsNotGiven, type RoutingContext, shapedPage } from './route-pages.ts';
import {
  type AppLayout,
  chainOf,
  type RouteFile,
  scanApp,
  unheldSegment,
  unnamedRoute,
  wrappersOf,
} from './route-scan.ts';
import { checkShadows } from './route-shadows.ts';
import { type JudgedMiddleware, type Judgement, judgeRoute, type Judging } from './shareability.ts';
import { byCodeUnits } from './splice.ts';

/**
 * The application's routes, as a compile learns them from its app directory: each page that renders
 * one reactive root of its route's params (`page-shape.ts`), registered with the route middleware
 * around it and whether its document may be shared (`shareability.ts`); each other page and route
 * handler under route middleware, registered with the middleware around it (`plain-routes.ts`);
 * and each route middleware, split into the guard the authority runs and the envelope the host runs
 * (`middleware.ts`). A root's entry names the route that renders it, so that its guards are run
 * wherever it renders: a root is rendered under one chain of route middleware, and a compile that
 * finds it under two refuses.
 */

/** A route middleware, as the compile writes it. */
export interface CompiledMiddleware extends JudgedMiddleware {
  readonly registration: MiddlewareRegistration;
  /** Where its outputs are written in the output directory, without their suffix. */
  readonly path: string;
}

export interface Routing {
  /** The registered routes, by route. */
  readonly routes: readonly RouteRegistration[];
  /** The routes under middleware of no reactive root, by route (`plain-routes.ts`). */
  readonly plain: readonly PlainRouteRegistration[];
  /** Every route middleware, by id. */
  readonly middleware: readonly CompiledMiddleware[];
  /** The route each registered root's entry names, by the root's id. */
  readonly roots: ReadonlyMap<string, string>;
}

/** No routes and no middleware: an application whose app directory holds neither. */
export const NO_ROUTING: Routing = { middleware: [], plain: [], roots: new Map(), routes: [] };

/** The directory a middleware's outputs are written under, in the output directory. */
const MIDDLEWARE_DIRECTORY = 'middleware';

/** What the app directory's own middleware's outputs are named: the app. */
const APP = 'app';

/** Where a middleware of `id` is written, without the suffix of each output. */
function middlewarePath(id: string): string {
  return id === '' ? `${MIDDLEWARE_DIRECTORY}/${APP}` : `${MIDDLEWARE_DIRECTORY}/${APP}/${id}`;
}

/**
 * What `split`'s guard reaches: the imports it reads at run time, and what its own code reads that
 * nothing tracks, or keeps between calls (`Reach.keptIn`): its statements, and the defaults and
 * computed keys of the context's pattern it binds, which run each time the guard does.
 */
function guardFacts(split: MiddlewareSplit, reach: Reach): Facts {
  const { guard, names } = split;
  if (guard === undefined) {
    return {};
  }
  const bindings = [...names.imports.values()].filter((binding) =>
    guard.values.has(binding.name.text),
  );
  const { untracked } = guard;
  const defaults = [...patternReads(guard.context, names).reads.keys()];
  const kept = reach.keptIn([...guard.statements, ...defaults]);
  return mergedFacts(reach.bindingFacts(bindings), {
    ...(untracked !== undefined && { untracked }),
    ...(kept !== undefined && { kept }),
  });
}

function compiledMiddleware(split: MiddlewareSplit, reach: Reach): CompiledMiddleware {
  const facts = guardFacts(split, reach);
  return {
    facts,
    path: middlewarePath(split.id),
    registration: {
      envelope: split.before !== undefined || split.after !== undefined,
      guard: split.guard !== undefined,
      id: split.id,
      identity: facts.identity !== undefined,
    },
    split,
  };
}

/** Refuses a middleware file of another extension than `.ts`, which no route would run. */
function refuseMisnamed(file: string, modules: Modules): never {
  throw new ReactiveCompileError(
    'A route middleware is written as `middleware.ts`: a middleware of another extension would be no route middleware — run around no route, its guard left out. Rename it, or the module, if it is no route middleware.',
    { fileName: modules.nameOf(file), position: { character: 0, line: 0 } },
  );
}

/**
 * Refuses a page or a route handler under a dynamic segment Next.js hands it no param of
 * (`unheldSegment`): it would be given nothing of its path, every path of its route alike.
 */
function refuseUnheld(entry: RouteFile, segment: string, modules: Modules): never {
  throw new ReactiveCompileError(
    `\`${entry.page}\` is under the dynamic segment \`${segment}\`, whose param Next.js hands it none of: it matches a path's params into an object by assignment, which makes \`__proto__\` the object's prototype rather than a param, and every path of the route alike. Name the segment otherwise.`,
    { fileName: modules.nameOf(entry.file), position: { character: 0, line: 0 } },
  );
}

/** Refuses each page and route handler of `layout` under a segment Next.js hands no param of. */
function refuseUnheldRoutes(
  layout: AppLayout,
  context: Pick<RoutingContext, 'attempt' | 'modules'>,
): void {
  for (const entries of [layout.pages, layout.handlers]) {
    for (const entry of entries) {
      const segment = unheldSegment(entry.directory);
      if (segment !== undefined) {
        context.attempt(() => refuseUnheld(entry, segment, context.modules));
      }
    }
  }
}

/** The registration of a page of a root. */
function registrationOf(
  each: Registered,
  layout: AppLayout,
  around: {
    readonly judging: Judging;
    readonly middleware: ReadonlyMap<string, CompiledMiddleware>;
    /** The application's proxy, by its name, where it has one (`proxyOf`). */
    readonly proxy: string | undefined;
    /** Whether the application turned sharing off (`share: false`). */
    readonly unshared: boolean;
  },
): RouteRegistration {
  const { exact, name, page, root } = each.shaped;
  const wrappers = wrappersOf(page.directory, layout);
  const chain = each.chain.flatMap((id) => {
    const compiled = around.middleware.get(id);
    return compiled === undefined ? [] : [compiled];
  });
  const interceptor = [...layout.intercepted].find(
    ([, target]) => target === unnamedRoute(name.route),
  )?.[0];
  // A view every visitor shares is one of all the route's params, as the gate names it: a root
  // given fewer is rendered for each request, the page rendering the rest of them as it will.
  const ungiven = paramsNotGiven(each.shaped);
  let judged: Judgement;
  if (around.unshared) {
    // Of a build that shares nothing, that is why, whatever else would have kept it private.
    judged = { reason: SHARING_OFF, shared: false };
  } else if ('reason' in exact) {
    judged = { reason: exact.reason, shared: false };
  } else if (ungiven.length > 0) {
    const named = ungiven.map((param) => `\`${param}\``).join(', ');
    judged = {
      reason: `\`${root}\` is not given every param of its route (${named})`,
      shared: false,
    };
  } else if (around.proxy !== undefined) {
    // A proxy runs ahead of every request, and may change any response: no document is every
    // visitor's, in the edge's gate nor in the delivery route's.
    judged = {
      reason: `the application has a proxy, \`${around.proxy}\`, which runs ahead of every request and may change any response`,
      shared: false,
    };
  } else if (interceptor === undefined) {
    const place = { beside: exact.beside, file: page.file };
    judged = judgeRoute({ chain, page: place, root, wrappers }, around.judging);
  } else {
    judged = {
      reason: `an intercepting route, \`${interceptor}\`, stands in for it on a navigation`,
      shared: false,
    };
  }
  const answers = chain.some((compiled) => (compiled.split.guard?.answers.size ?? 0) > 0);
  const guarded = chain.some((compiled) => compiled.registration.guard);
  return {
    ...(answers && { answers: true }),
    blocking: each.shaped.blocking && wrappers.every((wrapper) => wrapper.kind !== 'loading'),
    ...(guarded && { guarded: true }),
    middleware: each.chain,
    page: page.page,
    params: name.params,
    ...(!judged.shared && { private: judged.reason }),
    props: Object.fromEntries(
      Object.entries(each.shaped.props).toSorted(([a], [b]) => byCodeUnits(a, b)),
    ),
    root,
    route: name.route,
    shared: judged.shared,
  };
}

/** The application's routes and route middleware: what `appDir` holds of them, read and judged. */
export function scanRouting(context: RoutingContext): Routing {
  const { appDir, attempt, components, database, modules, outDir } = context;
  const layout = scanApp(appDir, outDir);
  for (const file of layout.misnamed) {
    attempt(() => refuseMisnamed(file, modules));
  }
  refuseUnheldRoutes(layout, context);
  const reach = new Reach(modules, database);
  const middleware = new Map<string, CompiledMiddleware>();
  const files = [...layout.middleware].toSorted(([a], [b]) => byCodeUnits(a, b));
  for (const [id, file] of files) {
    const split = attempt(() => readMiddleware({ file, id, modules }));
    if (split !== undefined) {
      middleware.set(id, compiledMiddleware(split, reach));
    }
  }
  // What a middleware runs before `next` runs ahead of every guard around it, as the source runs it.
  for (const [id, compiled] of middleware) {
    const outer = chainOf(id, layout).flatMap((each) => {
      const around = each === id ? undefined : middleware.get(each);
      return around === undefined ? [] : [around];
    });
    attempt(() => {
      checkUnderGuard(compiled, outer);
    });
  }
  const compiled = new Map(components.map((each) => [each.component.id, each]));
  const ids = new Set(compiled.keys());
  const registered = layout.pages.flatMap((page): Registered[] => {
    const shaped = attempt(() => shapedPage(page, context, ids));
    return shaped === undefined ? [] : [{ chain: chainOf(page.directory, layout), shaped }];
  });
  const checked = attempt(() => {
    checkRoutes(registered, { layout, middleware, modules });
    return true;
  });
  if (checked === undefined) {
    return NO_ROUTING;
  }
  const judging: Judging = { components: compiled, judged: new Map(), modules, reach };
  const proxied = proxyOf(appDir);
  const proxy = proxied === undefined ? undefined : path.basename(proxied);
  const unshared = context.unshared === true;
  const routes = registered
    .map((each) => registrationOf(each, layout, { judging, middleware, proxy, unshared }))
    .toSorted((a, b) => byCodeUnits(a.route, b.route));
  const roots = new Map<string, string>();
  for (const route of routes) {
    if (!roots.has(route.root)) {
      roots.set(route.root, route.route);
    }
  }
  const reactive = new Set(registered.map((each) => each.shaped.page.file));
  const plain = plainRoutesOf({ attempt, layout, middleware, modules, reactive }).toSorted((a, b) =>
    byCodeUnits(a.route, b.route),
  );
  const delivered = [
    ...routes.flatMap((route) =>
      route.middleware.length === 0 ? [] : [{ file: route.page, route: route.route }],
    ),
    ...plain.map((route) => ({ file: route.file, route: route.route })),
  ];
  attempt(() => {
    checkShadows(delivered, { appDir, layout, modules });
  });
  return { middleware: [...middleware.values()], plain, roots, routes };
}
