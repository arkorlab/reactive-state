import path from 'node:path';

import type { MiddlewareRegistration, RegisteredRoute } from '../routing.ts';
import { header } from './emit-authority.ts';
import { emitEnvelope, emitGuard } from './emit-middleware.ts';
import type { CompiledMiddleware, Routing } from './routes.ts';
import { byCodeUnits, literal, specifierLiteral, unusedName } from './splice.ts';

/**
 * What a compile writes of the application's routes: each route middleware's guard program and
 * envelope module; the host's registry of the routes and the envelopes (`routes.ts`); what the
 * authority's registry (`authority.mts`) adds of them — the routes, and the guard program of each
 * middleware by its id; and what the manifest says of them.
 */

/** The module the routing contract's types are imported from. */
const ROUTING = '@arkorlab/reactive-state/routing';

/** Where the guard program of a middleware is written: `<path>.guard.mts`. */
const GUARD_SUFFIX = '.guard.mts';

/** Where the envelope module of a middleware is written: `<path>.envelope.ts`. */
const ENVELOPE_SUFFIX = '.envelope.ts';

/** The host's registry, in the output directory. */
export const ROUTES_MODULE = 'routes.ts';

/** A key of a map the compile writes, as an object literal writes it, `__proto__` computed. */
function keyOf(key: string): string {
  return key === '__proto__' ? `[${literal(key)}]` : literal(key);
}

/** A local name for each middleware's module, of `prefix`: its path's segments, joined by `$`. */
function moduleNames(
  middleware: readonly CompiledMiddleware[],
  prefix: string,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const each of middleware) {
    const segments = each.path
      .split('/')
      .slice(1)
      .join('$')
      .replaceAll(/[^\w$]/gu, '_');
    const name = unusedName(`${prefix}$${segments}`, (candidate) => taken.has(candidate));
    taken.add(name);
    names.set(each.registration.id, name);
  }
  return names;
}

/** A specifier of `to` from `from`, both in the output directory, as an output imports it. */
function relativeTo(from: string, to: string): string {
  const relative = path.posix.relative(path.posix.dirname(from), to);
  return specifierLiteral(relative.startsWith('.') ? relative : `./${relative}`);
}

/** The routes `routing` registers, reactive and plain, in the order of their names. */
function registeredOf(routing: Routing): readonly RegisteredRoute[] {
  return [...routing.routes, ...routing.plain].toSorted((a, b) => byCodeUnits(a.route, b.route));
}

/**
 * The type the routes of `routing` are written as, in what the compile writes: the contract's type
 * of a reactive route where every one is such, of either otherwise.
 */
function routesType(routing: Routing): string {
  return routing.plain.length === 0 ? 'RouteRegistration' : 'RegisteredRoute';
}

/** The registrations, as JSON written into a module: each key sorted, as the manifest has it. */
function routesLiteral(routing: Routing): string {
  return JSON.stringify(registeredOf(routing), null, 2);
}

/** The guards and the envelopes the compile writes, by their path in the output directory. */
export function middlewareOutputs(
  routing: Routing,
  outDir: string,
  buildId: string,
): ReadonlyMap<string, string> {
  const outputs = new Map<string, string>();
  for (const each of routing.middleware) {
    const base = path.join(outDir, ...each.path.split('/'));
    if (each.registration.guard) {
      outputs.set(`${base}${GUARD_SUFFIX}`, emitGuard(each.split, buildId));
    }
    if (each.registration.envelope) {
      outputs.set(`${base}${ENVELOPE_SUFFIX}`, emitEnvelope(each.split));
    }
  }
  return outputs;
}

/** The host's registry (`routes.ts`): the routes, and the envelope of each middleware by its id. */
export function emitRoutesModule(routing: Routing): string {
  const enveloped = routing.middleware.filter((each) => each.registration.envelope);
  const names = moduleNames(enveloped, 'envelope');
  const entries = enveloped.map(
    (each) => `  ${keyOf(each.registration.id)}: ${names.get(each.registration.id) ?? ''},`,
  );
  return [
    header("the application's routes", 'routes'),
    `import type { MiddlewareEnvelope, ${routesType(routing)} } from '${ROUTING}';`,
    ...enveloped.map((each) => {
      const specifier = relativeTo(
        ROUTES_MODULE,
        `${each.path}${ENVELOPE_SUFFIX.replace(/\.ts$/u, '')}`,
      );
      return `import * as ${names.get(each.registration.id) ?? ''} from ${specifier};`;
    }),
    '',
    `export const routes: readonly ${routesType(routing)}[] = ${routesLiteral(routing)};`,
    '',
    entries.length === 0
      ? 'export const envelopes: Readonly<Record<string, MiddlewareEnvelope>> = {};'
      : [
          'export const envelopes: Readonly<Record<string, MiddlewareEnvelope>> = {',
          ...entries,
          '};',
        ].join('\n'),
    '',
  ].join('\n');
}

/** The imports the authority's registry adds: the routing contract's types, each guard program. */
export function registryImports(routing: Routing): readonly string[] {
  const guarded = routing.middleware.filter((each) => each.registration.guard);
  const names = moduleNames(guarded, 'guard');
  return [
    `import type { MiddlewareProgram, ${routesType(routing)} } from '${ROUTING}';`,
    ...guarded.map((each) => {
      const specifier = relativeTo('authority.mts', `${each.path}${GUARD_SUFFIX}`);
      return `import * as ${names.get(each.registration.id) ?? ''} from ${specifier};`;
    }),
  ];
}

/**
 * What the authority's registry exports of the routes: the routes, and each middleware by its id —
 * its guard program, or `null` for one with no guard, for the authority to refuse a route under
 * middleware it was told nothing of rather than pass a guard over.
 */
export function registryExports(routing: Routing): readonly string[] {
  const guarded = routing.middleware.filter((each) => each.registration.guard);
  const names = moduleNames(guarded, 'guard');
  const entries = routing.middleware.map(
    (each) => `  ${keyOf(each.registration.id)}: ${names.get(each.registration.id) ?? 'null'},`,
  );
  return [
    `export const routes: readonly ${routesType(routing)}[] = ${routesLiteral(routing)};`,
    entries.length === 0
      ? 'export const middleware: Readonly<Record<string, MiddlewareProgram | null>> = {};'
      : [
          'export const middleware: Readonly<Record<string, MiddlewareProgram | null>> = {',
          ...entries,
          '};',
        ].join('\n'),
  ];
}

/** What the manifest says of the routes and the route middleware. */
export function routingManifest(routing: Routing): {
  readonly middleware: readonly MiddlewareRegistration[];
  readonly routes: readonly RegisteredRoute[];
} {
  return {
    middleware: routing.middleware.map((each) => each.registration),
    routes: registeredOf(routing),
  };
}
