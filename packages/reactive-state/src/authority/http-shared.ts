import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  GATE_ANSWER_HEADER,
  GATE_DEPLOYMENT_HEADER,
  GATE_PASS,
  GATE_ROUTE_HEADER,
  type GateAnswer,
  GENERATION_HEADER,
  type SharedEvent,
} from '../routing.ts';
import { HTTP_BAD_REQUEST, HTTP_OK } from '../status.ts';
import type { AuthorityEngine as Engine } from './engine.ts';
import { refusal } from './errors.ts';
import { json, presentedSession, readJson } from './respond.ts';
import { SHARED_HEARTBEAT, SHARED_OPENING, SharedBacklog } from './shared-events.ts';

/**
 * A shared view's routes on the Node authority, behind the internal token as every `/api/` and
 * `/internal/` route is: a page's render of a route's root (`/api/shared/render`), a gate's question
 * as JSON (`/api/gate`, for the application's server) and as the request itself (`/internal/gate`,
 * the edge's route gate's protocol: the visitor's request, its URL in `x-upwind-gate-url`), and a
 * shared view's event stream (`/api/shared/events?view=`).
 */

/** The header the edge's gate is told the visitor's URL in, by the host that forwards it. */
const GATE_URL_HEADER = 'x-upwind-gate-url';
/** The visitor's headers a gate reads. */
const GATE_HEADERS: readonly string[] = [
  'if-none-match',
  'next-router-prefetch',
  'next-router-segment-prefetch',
  'next-router-state-tree',
  'rsc',
  GENERATION_HEADER,
];
const HTTP_NO_CONTENT = 204;
/** How often a stream with nothing to say says so. */
const HEARTBEAT_MS = 15_000;

export interface SharedExchange {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly method: string;
  readonly engine: Engine;
  readonly streams: Set<ServerResponse>;
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * The visitor's request the edge forwarded, as a gate's question: of the deployment the edge says
 * it is of (`GATE_DEPLOYMENT_HEADER`), where it says one. A URL that reads as no URL — `//`, `//:80`,
 * `/\`, which the parser takes for a host, empty or invalid — is refused as a question of no URL is
 * (`gateRequestOf`), not thrown by the parser, which the authority would answer as a fault of its own.
 */
function forwardedQuestion(req: IncomingMessage, method: string): unknown {
  const visitor = URL.parse(headerOf(req, GATE_URL_HEADER) ?? '/', 'https://gate.invalid');
  if (visitor === null) {
    throw refusal(
      HTTP_BAD_REQUEST,
      'INVALID_GATE',
      'A gate is asked of a route, a URL, a method and headers.',
    );
  }
  const headers: Record<string, string> = {};
  for (const name of GATE_HEADERS) {
    const value = headerOf(req, name);
    if (value !== undefined) {
      headers[name] = value;
    }
  }
  const deployment = headerOf(req, GATE_DEPLOYMENT_HEADER);
  return {
    headers,
    method,
    route: headerOf(req, GATE_ROUTE_HEADER) ?? '',
    url: `${visitor.pathname}${visitor.search}`,
    ...(deployment !== undefined && { deployment }),
  };
}

/**
 * A gate's answer, as the edge's route gate is answered: the response, or `pass` — its headers
 * written as the answer lists them, a field it repeats (a guard's `Set-Cookie`) once for each
 * value, never one in place of another.
 */
function answerForwarded(res: ServerResponse, answer: GateAnswer): void {
  if (answer.kind === 'pass') {
    res.writeHead(HTTP_NO_CONTENT, { [GATE_ANSWER_HEADER]: GATE_PASS });
    res.end();
    return;
  }
  // Node's raw form: names and values in one list, a name and then its value.
  res.writeHead(answer.status, answer.headers.flat());
  res.end(answer.body === null ? undefined : Buffer.from(answer.body, 'base64'));
}

/** A shared view's stream, as written to its response. */
interface SharedWriter {
  /** Writes an event, or owes it while the client is behind. */
  readonly send: (event: SharedEvent) => void;
  /** Writes what is no event — the opening, a heartbeat — unless the client is behind. */
  readonly say: (text: string) => void;
}

/**
 * A shared view's stream as written to `res`: each event at once while the client takes what it is
 * sent; once the response holds what the client has yet to take (its `write` answered `false`),
 * what comes is owed (`SharedBacklog`) and written as the response drains, and nothing else is
 * written meanwhile — what the authority holds for a slow client stays bounded, as the session
 * streams' does (`sse.ts`).
 */
function writerOf(res: ServerResponse): SharedWriter {
  const owed = new SharedBacklog();
  let full = false;
  const write = (text: string): void => {
    if (text !== '' && !res.write(text)) {
      full = true;
    }
  };
  res.on('drain', () => {
    full = false;
    write(owed.take());
  });
  return {
    say: (text) => {
      if (!full) {
        write(text);
      }
    },
    send: (event) => {
      owed.add(event);
      if (!full) {
        write(owed.take());
      }
    },
  };
}

/** A shared view's event stream: what the page missed, then each event, until it hangs up. */
async function stream(exchange: SharedExchange): Promise<void> {
  const { engine, req, res, streams, url } = exchange;
  const token = url.searchParams.get('view') ?? '';
  if (url.searchParams.get('head') === '1') {
    await engine.checkShared(token);
    res.writeHead(HTTP_OK, {
      'Cache-Control': 'no-store, no-transform',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });
    res.end();
    return;
  }
  const followed = await engine.followShared(token);
  // A client that left while the following waited its turn has no stream to follow, and its
  // `close` came before anything below listened for it: nothing would ever let go of a stream
  // opened for it, nor of the view it keeps (`followed`).
  if (req.destroyed || res.destroyed || res.socket?.destroyed !== false) {
    followed.stop();
    res.end();
    return;
  }
  const { say, send } = writerOf(res);
  let stop: () => void;
  try {
    res.writeHead(HTTP_OK, {
      'Cache-Control': 'no-store, no-transform',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });
    say(SHARED_OPENING);
    for (const event of followed.missed) {
      send(event);
    }
    stop = followed.listen(send);
  } catch (error) {
    // A following nothing listens to is let go of, not left holding what its view moves to.
    followed.stop();
    throw error;
  }
  const heartbeat = setInterval(() => {
    say(SHARED_HEARTBEAT);
  }, HEARTBEAT_MS);
  streams.add(res);
  const end = (): void => {
    clearInterval(heartbeat);
    stop();
    streams.delete(res);
  };
  req.once('close', end);
  res.once('close', end);
}

/** Answers a shared view's route; `false` for a request of any other. */
export async function handleShared(exchange: SharedExchange): Promise<boolean> {
  const { engine, method, req, res, url } = exchange;
  switch (`${method} ${url.pathname}`) {
    case 'POST /api/shared/render': {
      json(res, HTTP_OK, await engine.renderShared(presentedSession(req), await readJson(req)));
      return true;
    }
    case 'POST /api/gate': {
      json(res, HTTP_OK, await engine.gate(await readJson(req)));
      return true;
    }
    case 'GET /internal/gate':
    case 'HEAD /internal/gate': {
      answerForwarded(res, await engine.gate(forwardedQuestion(req, method)));
      return true;
    }
    case 'GET /api/shared/events': {
      await stream(exchange);
      return true;
    }
    default: {
      return false;
    }
  }
}
