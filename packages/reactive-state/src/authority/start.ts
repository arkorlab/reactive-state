import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { SiteShape } from '../routing.ts';
import { type AuthorityServer, createAuthorityServer } from './http.ts';
import type { Application, ExternalOptions } from './model.ts';
import { Engine } from './node-engine.ts';
import type { SiteFetch } from './shared-generate.ts';

/** The bytes of a fresh internal token. */
const TOKEN_BYTES = 32;

/**
 * What the authority is started with: what a compile wrote for it (`<out>/authority.mts` exports
 * `buildId`, `programs`, `operations` and `database`), and where and how it serves.
 */
export interface AuthorityOptions extends Application, ExternalOptions {
  /** Where the database is kept (`app.sqlite`); in memory when not given. */
  readonly stateDir?: string;
  /** 0, or nothing, picks a free port. */
  readonly port?: number;
  /** The internal token; a fresh one when not given, which the caller hands to the application. */
  readonly token?: string;
  readonly testMode?: boolean;
  readonly clock?: () => number;
  /** How long a call that runs the application's code may run before it is a fault; 5 s unless given. */
  readonly timeoutMs?: number;
}

export interface Authority extends AuthorityServer {
  readonly token: string;
  /**
   * The site the application is served at (`http://localhost:3000`), which the authority asks for a
   * route's page to make a shared view's artifacts of; none, until it is told, makes none. And, where
   * the host knows it of the build it serves, where that site serves its routes (`basePath`,
   * `trailingSlash`): what a route's gate reads the edge's question by, which says nothing of it.
   */
  readonly site: (origin: string | undefined, shape?: SiteShape) => void;
}

/**
 * How the authority asks the site at `origin` for a page: as a visitor would, with Node's fetch,
 * which lets go of the request, and of its body, once `signal` aborts.
 */
function siteFetch(origin: string): SiteFetch {
  const platformFetch = fetch.bind(globalThis);
  return async (page, headers, signal) => {
    return platformFetch(new URL(page, origin), {
      headers,
      redirect: 'manual',
      ...(signal !== undefined && { signal }),
    });
  };
}

/** Starts an authority on a loopback address, with a database of its own and an internal token. */
export async function startAuthority(options: AuthorityOptions): Promise<Authority> {
  // An empty token would be refused by every internal request — as an unset variable passed on
  // would make one — while the authority looked started.
  if (options.token === '') {
    throw new Error('The internal token is empty: give one, or none to have one made.');
  }
  const token = options.token ?? randomBytes(TOKEN_BYTES).toString('hex');
  let filename: string | undefined;
  if (options.stateDir !== undefined) {
    mkdirSync(options.stateDir, { mode: 0o700, recursive: true });
    filename = path.join(options.stateDir, 'app.sqlite');
  }
  const { buildId, clock, database, middleware, operations, port, programs, routes } = options;
  const { externalPollMs, sessions, shareViews, stores, testMode, timeoutMs } = options;
  const engine = new Engine({
    database,
    programs,
    ...(operations !== undefined && { operations }),
    ...(routes !== undefined && { routes }),
    ...(middleware !== undefined && { middleware }),
    ...(shareViews !== undefined && { shareViews }),
    sessions,
    externalPollMs,
    stores,
    ...(buildId !== undefined && { buildId }),
    ...(filename !== undefined && { filename }),
    ...(clock !== undefined && { clock }),
    ...(timeoutMs !== undefined && { timeoutMs }),
  });
  try {
    const server = await createAuthorityServer({
      engine,
      internalToken: token,
      ...(port !== undefined && { port }),
      ...(testMode !== undefined && { testMode }),
    });
    return {
      ...server,
      site: (origin, shape) => {
        engine.site(origin === undefined ? undefined : siteFetch(origin), shape);
      },
      token,
    };
  } catch (error) {
    await engine.close();
    throw error;
  }
}
