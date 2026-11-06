import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { PROTOCOL_VERSION } from '../program.ts';
import {
  HTTP_FORBIDDEN,
  HTTP_INTERNAL_ERROR,
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_UNAUTHORIZED,
} from '../status.ts';
import type { AuthorityEngine as Engine } from './engine.ts';
import { AuthorityError, describeThrown, refusal } from './errors.ts';
import { handleShared } from './http-shared.ts';
import {
  isInternal,
  json,
  presentedSession,
  readJson,
  sessionCookie,
  sessionOf,
} from './respond.ts';
import { openEventStream } from './sse.ts';

/**
 * The authority over HTTP, on a loopback address only, for the application's server alone: every
 * `/api/` route — a page's render, a route's guards, a write to a field, a server operation, the
 * event stream, a session's sign-in and sign-out — and every `/internal/` one — the change log and
 * its delivery cursors — answers a request that carries the internal token, and the session as the
 * cookie the application's server hands on. A browser never reaches the authority itself. `/health`
 * and the authority's own rendering of a record's public fields (`/public/<table>/<id>`) answer
 * anyone.
 */

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);
const SESSION_SECONDS = 86_400;
/** The longest a test may hold a write back (`x-test-delay`), in test mode only. */
const MAX_TEST_DELAY_MS = 1500;
/** The authority's own rendering of a record's public fields: `/public/<table>/<id>`. */
const MATERIALIZED = /^\/public\/([^/]+)\/([^/]+)$/u;

function notFound(): Error {
  return refusal(HTTP_NOT_FOUND, 'NOT_FOUND', 'Not found.');
}

export interface AuthorityServerOptions {
  readonly engine: Engine;
  readonly host?: '127.0.0.1' | '::1';
  /** 0 picks a free port. */
  readonly port?: number;
  readonly internalToken: string;
  /**
   * Lets a request hold its write back (`x-test-delay`) or lose its answer after committing
   * (`x-test-drop`), for tests of what a client does then. Never on in anything served.
   */
  readonly testMode?: boolean;
}

export interface AuthorityServer {
  readonly server: Server;
  readonly engine: Engine;
  readonly url: string;
  /** The event streams open now. */
  readonly streams: () => number;
  readonly close: () => Promise<void>;
}

/** One request, and what the server answers it with. */
interface Exchange {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly method: string;
  readonly engine: Engine;
  readonly testMode: boolean;
  readonly streams: Set<ServerResponse>;
}

export async function createAuthorityServer(
  options: AuthorityServerOptions,
): Promise<AuthorityServer> {
  const host = options.host ?? '127.0.0.1';
  const streams = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    void handle(req, res, { options, streams }).catch((error: unknown) => {
      answerError(res, error);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  let closing: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    // The server stops taking connections before the ones it has are ended: one that came in
    // between would hold the close open, an event stream above all.
    const closed = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    for (const res of streams) {
      res.end();
    }
    server.closeAllConnections();
    await closed;
    await options.engine.close();
  };
  return {
    // Once, however many ask: a run that stops the authority to see what is served without it
    // still has it closed again as the run ends.
    close: async () => {
      closing ??= close();
      return closing;
    },
    engine: options.engine,
    server,
    streams: () => streams.size,
    url: `http://${host === '::1' ? '[::1]' : host}:${String(port)}`,
  };
}

/**
 * Signing in replaces the browser's session: the one its cookie named ends, and with it each stream
 * the browser still holds under it — in another tab too, which a commit tells at once. One that had
 * already ended is no matter.
 */
async function endPrevious(engine: Engine, sessionId: string | null): Promise<void> {
  if (sessionId === null) {
    return;
  }
  try {
    await engine.logout(sessionId);
  } catch (error) {
    if (!(error instanceof AuthorityError) || error.status !== HTTP_UNAUTHORIZED) {
      throw error;
    }
  }
}

/**
 * Only the authority's refusals answer their own status — the engine's, and those the
 * application's code made (`forbidden()`, `requireUser`), which it answers as its own. Anything
 * else is a fault, a plain `Error` of the application's code included, and answers 500 without its
 * message.
 */
function answerError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof AuthorityError) {
    json(res, error.status, { code: error.code, error: error.message });
    return;
  }
  json(res, HTTP_INTERNAL_ERROR, { code: 'INTERNAL_ERROR', error: 'Internal error' });
  // Whatever the application's code threw: a value that cannot be made a string is logged too,
  // rather than throw out of the answer and take the process down.
  process.stderr.write(`${describeThrown(error)}\n`);
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  server: { readonly options: AuthorityServerOptions; readonly streams: Set<ServerResponse> },
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw refusal(HTTP_FORBIDDEN, 'HOST_REJECTED', 'A loopback host is required.');
  }
  const { engine, internalToken, testMode } = server.options;
  const exchange: Exchange = {
    engine,
    method: req.method ?? 'GET',
    req,
    res,
    streams: server.streams,
    testMode: testMode === true,
    url,
  };
  const { pathname } = url;
  if (pathname.startsWith('/api/') || pathname.startsWith('/internal/')) {
    if (!isInternal(req, internalToken)) {
      throw refusal(HTTP_FORBIDDEN, 'INTERNAL_ONLY', 'Internal credentials are required.');
    }
    if (await handleShared(exchange)) {
      return;
    }
    await (pathname.startsWith('/api/') ? handleApi(exchange) : handleInternal(exchange));
    return;
  }
  await handleOpen(exchange);
}

/**
 * `/health`, and `/public/<table>/<id>`: the authority's own rendering of a record's public fields,
 * from its cache while the record is as it was read.
 */
async function handleOpen({ engine, method, res, url }: Exchange): Promise<void> {
  if (method === 'GET' && url.pathname === '/health') {
    json(res, HTTP_OK, { buildId: engine.buildId, localOnly: true, ok: true });
    return;
  }
  const match = method === 'GET' ? MATERIALIZED.exec(url.pathname) : null;
  if (match === null) {
    throw notFound();
  }
  const snapshot = await engine.publicSnapshot(match[1], match[2]);
  res.writeHead(HTTP_OK, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
    ETag: `"${snapshot.resultVersion}"`,
    'X-Reactive-Cache': snapshot.cache,
  });
  res.end(snapshot.html);
}

async function handleApi(exchange: Exchange): Promise<void> {
  const { engine, method, req, res, url } = exchange;
  switch (`${method} ${url.pathname}`) {
    case 'GET /api/config': {
      json(res, HTTP_OK, configOf(engine));
      return;
    }
    case 'POST /api/session': {
      const { user } = await readJson(req);
      const session = await engine.login(user);
      await endPrevious(engine, sessionOf(req));
      const cookie = sessionCookie(session.sessionId, SESSION_SECONDS);
      json(res, HTTP_OK, { user: { id: session.userId } }, { 'Set-Cookie': cookie });
      return;
    }
    case 'DELETE /api/session': {
      // Every answer clears the cookie, a refusal of a session that had already ended included: the
      // browser is signed out either way, rather than left sending a session that is gone.
      res.setHeader('Set-Cookie', sessionCookie('', 0));
      await engine.logout(presentedSession(req));
      json(res, HTTP_OK, { ok: true });
      return;
    }
    case 'POST /api/session/end': {
      const { key } = await readJson(req);
      await engine.endSession(key);
      json(res, HTTP_OK, { ok: true });
      return;
    }
    case 'POST /api/render': {
      const { root } = await readJson(req);
      json(res, HTTP_OK, await engine.render(presentedSession(req), root));
      return;
    }
    case 'POST /api/view': {
      json(res, HTTP_OK, await engine.view(presentedSession(req), await readJson(req)));
      return;
    }
    case 'POST /api/guard': {
      json(res, HTTP_OK, await engine.guardRoute(presentedSession(req), await readJson(req)));
      return;
    }
    case 'POST /api/update': {
      await write(exchange, async (input) => engine.update(presentedSession(req), input));
      return;
    }
    case 'POST /api/operate': {
      await write(exchange, async (input) => engine.operate(presentedSession(req), input));
      return;
    }
    case 'GET /api/events': {
      const sessionId = presentedSession(req);
      const subscription = url.searchParams.get('subscription') ?? '';
      const initial = await engine.watch(sessionId, subscription);
      const expiresIn = await engine.expiresIn(sessionId);
      openEventStream(req, res, {
        engine,
        expiresIn,
        initial,
        sessionId,
        streams: exchange.streams,
        subscription,
      });
      return;
    }
    case 'GET /api/public': {
      const { cache, id, resultVersion, revision, table, values } = await engine.publicSnapshot(
        url.searchParams.get('table') ?? undefined,
        url.searchParams.get('id') ?? undefined,
      );
      json(res, HTTP_OK, { cache, id, resultVersion, revision, table, values });
      return;
    }
    case 'GET /api/stats': {
      json(res, HTTP_OK, await engine.stats());
      return;
    }
    default: {
      throw notFound();
    }
  }
}

/**
 * A write — to a field, or a server operation — and its receipt. In test mode, the write may be
 * held back (`x-test-delay`), or commit and lose its first answer on the way back (`x-test-drop`).
 */
async function write(
  { req, res, testMode }: Exchange,
  commit: (input: Readonly<Record<string, unknown>>) => Promise<{ readonly deduplicated: boolean }>,
): Promise<void> {
  const input = await readJson(req);
  if (testMode) {
    const asked = Number(req.headers['x-test-delay']) || 0;
    const delay = Math.min(Math.max(asked, 0), MAX_TEST_DELAY_MS);
    if (delay > 0) {
      await sleep(delay);
    }
  }
  const receipt = await commit(input);
  if (testMode && req.headers['x-test-drop'] === '1' && !receipt.deduplicated) {
    req.socket.destroy();
    return;
  }
  json(res, HTTP_OK, receipt);
}

async function handleInternal(exchange: Exchange): Promise<void> {
  const { engine, method, req, res, url } = exchange;
  switch (`${method} ${url.pathname}`) {
    case 'GET /internal/changes': {
      const since = Number(url.searchParams.get('since')) || 0;
      json(res, HTTP_OK, await engine.changes(since));
      return;
    }
    case 'GET /internal/delivery': {
      const consumer = url.searchParams.get('consumer') ?? '';
      json(res, HTTP_OK, { revision: await engine.delivery(consumer) });
      return;
    }
    case 'POST /internal/delivery': {
      const body = await readJson(req);
      await engine.acknowledge(body['consumer'], body['revision']);
      json(res, HTTP_OK, { ok: true });
      return;
    }
    case 'GET /internal/stats': {
      json(res, HTTP_OK, { ...(await engine.stats()), streams: exchange.streams.size });
      return;
    }
    default: {
      throw notFound();
    }
  }
}

/** What the authority serves: its protocol, its build, its components and its operations. */
function configOf(engine: Engine): Record<string, unknown> {
  // Defined, not assigned: a module may be named `__proto__`, which assigning would not keep.
  const operations = Object.fromEntries(engine.operations);
  return {
    buildId: engine.buildId,
    components: [...engine.programs.keys()],
    operations,
    protocol: PROTOCOL_VERSION,
  };
}
