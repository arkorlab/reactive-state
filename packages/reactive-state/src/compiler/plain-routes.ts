import { COMPILE_ROUTE_DIRECTORY, type PlainRouteRegistration } from '../routing.ts';
import { ReactiveCompileError } from './errors.ts';
import type { Modules } from './modules.ts';
import { checkMembers, memberFiles } from './route-checks.ts';
import {
  type AppLayout,
  chainOf,
  isPrivate,
  type RouteFile,
  type RouteName,
  unplacedSegment,
} from './route-scan.ts';
import type { CompiledMiddleware } from './routes.ts';

/**
 * The routes under route middleware that are no reactive route — each page that renders no
 * reactive root of the compile's, a sign-in page say, and each route handler (`route.ts`) but the
 * compile's own — registered with the chain of middleware around them, so that the delivery route
 * runs the envelopes around every request of them, and the guards ahead of each where the chain
 * has one: a route middleware runs around every route under its directory, whatever renders it.
 *
 * What the compile cannot deliver so is refused where a chain covers it, never left to be served
 * around the middleware: a route no rewrite places exactly — a catch-all, a parallel route's slot,
 * an intercepting route; members a page or a handler prerenders (`checkMembers`); and, under a
 * guard, a metadata file written as code, which Next.js answers as a route of its own at a path it
 * names itself. A private folder (`_folder`) holds no route. Outside the contract, served as
 * Next.js serves them: the framework's own paths (`/_next/…`), a URL no route matches (the root's
 * not-found), and the metadata files — a file, or code under middleware with no guard — which no
 * envelope is around.
 */

/** What the plain routes are read with. */
export interface PlainContext {
  readonly layout: AppLayout;
  readonly modules: Modules;
  /** Each route middleware the compile read, by id. */
  readonly middleware: ReadonlyMap<string, CompiledMiddleware>;
  /** The files of the pages registered as reactive routes. */
  readonly reactive: ReadonlySet<string>;
  /** Runs `run`, recording what it refuses. */
  readonly attempt: <T>(run: () => T) => T | undefined;
}

/** How a chain of route middleware reads in what is refused. */
function chainName(chain: readonly string[]): string {
  return chain.map((id) => `\`${id === '' ? '(app)' : id}\``).join(', ');
}

/** Refuses `file`, of the application's, for `reason`, where it opens. */
function refuseFile(file: string, reason: string, modules: Modules): never {
  throw new ReactiveCompileError(reason, {
    fileName: modules.nameOf(file),
    position: { character: 0, line: 0 },
  });
}

/** The compiled middleware of `chain`, those the compile read. */
function compiledOf(
  chain: readonly string[],
  middleware: ReadonlyMap<string, CompiledMiddleware>,
): readonly CompiledMiddleware[] {
  return chain.flatMap((id) => {
    const compiled = middleware.get(id);
    return compiled === undefined ? [] : [compiled];
  });
}

/** The route `entry` is served at, refused where no rewrite places it exactly. */
function placedOf(entry: RouteFile, chain: readonly string[], modules: Modules): RouteName {
  if (entry.served !== undefined) {
    return entry.served;
  }
  const segment = unplacedSegment(entry.directory) ?? entry.directory;
  return refuseFile(
    entry.file,
    `\`${entry.page}\` is under route middleware (${chainName(chain)}), which runs around every request of the routes under it, but no rewrite places it exactly: its segment \`${segment}\` — a catch-all, a parallel route's slot or an intercepting route — has it served at paths of no one route, which would go around the middleware. Move it out from under the middleware, or give it a route of its own segments.`,
    modules,
  );
}

/** The registration of `entry`, a page of no reactive root or a route handler, under `chain`. */
function plainRouteOf(
  entry: RouteFile,
  plain: PlainRouteRegistration['plain'],
  chain: readonly string[],
  context: PlainContext,
): PlainRouteRegistration {
  const { layout, modules } = context;
  const name = placedOf(entry, chain, modules);
  checkMembers(name, plain === 'page' ? memberFiles(entry, layout) : [entry.file], modules);
  const compiled = compiledOf(chain, context.middleware);
  const answers = compiled.some((each) => (each.split.guard?.answers.size ?? 0) > 0);
  const guarded = compiled.some((each) => each.registration.guard);
  return {
    ...(answers && { answers: true }),
    file: entry.page,
    ...(guarded && { guarded: true }),
    middleware: chain,
    params: name.params,
    plain,
    route: name.route,
  };
}

/** Refuses a metadata file of code under a chain with a guard, which no rewrite places. */
function checkMetadata(
  file: Pick<RouteFile, 'directory' | 'file'>,
  chain: readonly string[],
  context: PlainContext,
): void {
  const guard = compiledOf(chain, context.middleware).find((each) => each.registration.guard);
  if (guard !== undefined) {
    const name = context.modules.nameOf(file.file);
    refuseFile(
      file.file,
      `\`${name}\` is a metadata file written as code under the guard of \`${guard.split.fileName}\`: Next.js answers it as a route of its own, at a path it names itself, which no rewrite places — the guard would be left out where it renders. Write it as a file (an image, \`.xml\`, \`.txt\`), or move it out from under the middleware.`,
      context.modules,
    );
  }
}

/**
 * The plain routes of the application — what `context.layout` holds under route middleware that is
 * no reactive route — in the order of their files; each refusal recorded (`attempt`).
 */
export function plainRoutesOf(context: PlainContext): readonly PlainRouteRegistration[] {
  const { layout } = context;
  const entries = [
    ...layout.pages
      .filter((page) => !context.reactive.has(page.file))
      .map((entry) => ({ entry, plain: 'page' as const })),
    ...layout.handlers
      .filter((handler) => handler.directory !== COMPILE_ROUTE_DIRECTORY)
      .map((entry) => ({ entry, plain: 'handler' as const })),
  ];
  const routes = entries.flatMap(({ entry, plain }) => {
    const chain = chainOf(entry.directory, layout);
    if (chain.length === 0 || isPrivate(entry.directory)) {
      return [];
    }
    const registered = context.attempt(() => plainRouteOf(entry, plain, chain, context));
    return registered === undefined ? [] : [registered];
  });
  for (const file of layout.metadata) {
    const chain = chainOf(file.directory, layout);
    if (chain.length > 0 && !isPrivate(file.directory)) {
      context.attempt(() => {
        checkMetadata(file, chain, context);
      });
    }
  }
  return routes;
}
