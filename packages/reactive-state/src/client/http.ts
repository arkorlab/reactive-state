import { ASSERTED_SESSION_HEADER, assertedHeader, assertedSessionOf } from '../asserted.ts';
import {
  type FieldReceipt,
  INTERNAL_HEADER,
  type OperationReceipt,
  type RenderResult,
  type Result,
  SESSION_COOKIE,
} from '../program.ts';
import type { GateAnswer, GuardAnswer, SharedRenderAnswer } from '../routing.ts';
import type { AuthorityClient, PublicView, SessionId, SignedIn } from './contract.ts';
import {
  type Failure,
  refused,
  REQUEST_TIMEOUT_MS,
  TOO_SLOW,
  unavailable,
  UNREACHABLE,
} from './results.ts';

/**
 * The authority on a developer's machine — the Node process `startAuthority` serves on a loopback
 * address — over its HTTP API, as the application's server: every request carries the internal
 * token, without which the authority answers none, and the session — a demo session as the cookie
 * the authority reads it from, one the application asserts in `x-reactive-session`, which the
 * authority reads beside the token alone. Nothing but `fetch`: `next build` runs it in Node, and a
 * local stack's Functions in workerd.
 */

export interface HttpClientOptions {
  /** The authority's origin, as `startAuthority` answers it: `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** The internal token it was started with, which never reaches a browser. */
  readonly token: string;
  /** How long a call may wait for its whole answer, and the event stream for its opening. */
  readonly timeoutMs?: number | undefined;
  /**
   * The deployment asking (`NEXT_DEPLOYMENT_ID`), which each gate's question names as the one its
   * request is of, unless the question names its own.
   */
  readonly deployment?: string | undefined;
}

/** What a session id is made of, as the authority mints them (base64url). */
const SESSION_ID = /^[\w-]+$/u;

interface Call {
  readonly method?: 'DELETE' | 'GET' | 'POST';
  readonly session?: SessionId;
  readonly body?: unknown;
}

/** What the authority's error answers carry. */
interface ErrorBody {
  readonly code?: unknown;
  readonly error?: unknown;
}

/** What a request that ended without an answer was: given up on, or never connected. */
function failureOf(error: unknown): Failure {
  return unavailable(
    error instanceof DOMException && error.name === 'TimeoutError' ? TOO_SLOW : UNREACHABLE,
  );
}

/**
 * The cookie that names `session` to the authority. None for no session — nor for an id the
 * authority could not have minted, which it would read as none, and which has no business in a
 * header.
 */
function cookieOf(session: SessionId | undefined): string | undefined {
  return typeof session === 'string' && SESSION_ID.test(session)
    ? `${SESSION_COOKIE}=${session}`
    : undefined;
}

/**
 * A query of each of `parameters` that is text. One that is not is left out, never made into text —
 * an application's server hands on what a browser sent — so the authority refuses a request that
 * names nothing it reads, as the Durable Object refuses the same arguments.
 */
function queryOf(parameters: Readonly<Record<string, unknown>>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(parameters)) {
    if (typeof value === 'string') {
      query.set(name, value);
    }
  }
  return query.toString();
}

/**
 * How long a call waits, in development alone, for an authority that refused its connection: one a
 * development loop starts again as the application's components change, which `next dev` asks for
 * the page it reloads meanwhile. A refused connection sent nothing, so a write waits as a read does.
 * Counted in tries, not by a clock, which a page's prerendering may not read.
 */
const RESTART = { pollMs: 100, tries: 100 } as const;
/** The variable `next dev` sets to `development`. */
const NODE_ENV = 'NODE_ENV';

/** Whether `error` is a connection the authority's port refused: nothing listened there. */
function connectionRefused(error: unknown): boolean {
  const cause: unknown = error instanceof TypeError ? error.cause : undefined;
  return (
    typeof cause === 'object' && cause !== null && Reflect.get(cause, 'code') === 'ECONNREFUSED'
  );
}

/** `fetch`, again while a development authority is starting, within `signal` and `RESTART`. */
async function fetched(url: URL, init: RequestInit & { readonly signal: AbortSignal }) {
  for (let tried = 1; ; tried += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (
        process.env[NODE_ENV] !== 'development' ||
        !connectionRefused(error) ||
        tried >= RESTART.tries ||
        init.signal.aborted
      ) {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, RESTART.pollMs);
      });
    }
  }
}

async function send(
  options: HttpClientOptions,
  path: string,
  call: Call & { readonly signal: AbortSignal },
): Promise<Result<Response>> {
  try {
    const headers = new Headers({ [INTERNAL_HEADER]: options.token });
    const asserted = assertedSessionOf(call.session);
    const cookie = cookieOf(call.session);
    if (asserted !== undefined) {
      headers.set(ASSERTED_SESSION_HEADER, assertedHeader(asserted));
    } else if (cookie !== undefined) {
      headers.set('cookie', cookie);
    }
    if (call.body !== undefined) {
      headers.set('content-type', 'application/json');
    }
    const response = await fetched(new URL(path, options.url), {
      ...(call.body !== undefined && { body: JSON.stringify(call.body) }),
      cache: 'no-store',
      headers,
      method: call.method ?? 'GET',
      signal: call.signal,
    });
    return { ok: true, value: response };
  } catch (error) {
    return failureOf(error);
  }
}

/** The answer's text; an answer that broke off, or ran out of time, leaves the outcome unknown. */
async function textOf(response: Response): Promise<Result<string>> {
  try {
    return { ok: true, value: await response.text() };
  } catch (error) {
    return failureOf(error);
  }
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A refusal, with the status the authority answered and the code and message it gave. */
async function refusalOf(response: Response): Promise<Failure> {
  const text = await textOf(response);
  if (!text.ok) {
    return text;
  }
  const { code, error } = (parsed(text.value) ?? {}) as ErrorBody;
  return refused(
    response.status,
    typeof code === 'string' ? code : 'AUTHORITY_ERROR',
    typeof error === 'string' ? error : `The authority answered ${String(response.status)}.`,
  );
}

async function valueOf<T>(response: Response): Promise<Result<T>> {
  if (!response.ok) {
    return refusalOf(response);
  }
  const text = await textOf(response);
  if (!text.ok) {
    return text;
  }
  const body = parsed(text.value);
  return body === undefined
    ? unavailable('The authority answered something other than JSON.')
    : { ok: true, value: body as T };
}

/** What anyone may see of a record, and not what the authority's cache made of it (`cache`). */
function publicViewOf({ id, resultVersion, revision, table, values }: PublicView): PublicView {
  return { id, resultVersion, revision, table, values };
}

/** The session the authority's answer opened, from the cookie it set for it. */
function sessionIn(headers: Headers): string | undefined {
  for (const cookie of headers.getSetCookie()) {
    const [pair = ''] = cookie.split(';', 1);
    const separator = pair.indexOf('=');
    if (separator !== -1 && pair.slice(0, separator).trim() === SESSION_COOKIE) {
      const value = pair.slice(separator + 1).trim();
      return SESSION_ID.test(value) ? value : undefined;
    }
  }
  return undefined;
}

export function httpClient(options: HttpClientOptions): AuthorityClient {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  // The whole exchange is timed, its answer's body included: the signal ends the reading as well.
  const exchange = async (path: string, call: Call = {}): Promise<Result<Response>> =>
    send(options, path, { ...call, signal: AbortSignal.timeout(timeoutMs) });
  const json = async <T>(path: string, call: Call = {}): Promise<Result<T>> => {
    const sent = await exchange(path, call);
    return sent.ok ? valueOf<T>(sent.value) : sent;
  };
  // Only the opening is timed: the stream lasts as long as the application reads it, and
  // cancelling it ends the request, which closes the authority's side of it.
  const stream = async (
    path: string,
    session: SessionId,
  ): Promise<Result<ReadableStream<Uint8Array>>> => {
    const opening = new AbortController();
    const timer = setTimeout(() => {
      opening.abort(new DOMException(TOO_SLOW, 'TimeoutError'));
    }, timeoutMs);
    try {
      const sent = await send(options, path, { session, signal: opening.signal });
      if (!sent.ok) {
        return sent;
      }
      const { body, ok } = sent.value;
      if (!ok) {
        return await refusalOf(sent.value);
      }
      return body === null
        ? unavailable('The authority answered the event stream with no stream.')
        : { ok: true, value: body };
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    events: async (session, subscription) =>
      stream(`/api/events?${queryOf({ subscription })}`, session),
    gate: async ({ deployment = options.deployment, headers, method, route, site, url }) => {
      const body = {
        headers,
        method,
        route,
        url,
        ...(site !== undefined && { site }),
        ...(deployment !== undefined && { deployment }),
      };
      return json<GateAnswer>('/api/gate', { body, method: 'POST' });
    },
    guardRoute: async (session, { admit, route, url }) => {
      const body = { route, url, ...(admit === true && { admit }) };
      return json<GuardAnswer>('/api/guard', { body, method: 'POST', session });
    },
    login: async (user) => {
      const sent = await exchange('/api/session', { body: { user }, method: 'POST' });
      if (!sent.ok) {
        return sent;
      }
      const answer = await valueOf<{ readonly user?: { readonly id?: unknown } }>(sent.value);
      if (!answer.ok) {
        return answer;
      }
      const sessionId = sessionIn(sent.value.headers);
      const userId = answer.value.user?.id;
      if (sessionId === undefined || typeof userId !== 'string') {
        return unavailable('The authority answered a sign-in without a session.');
      }
      const signedIn: SignedIn = { sessionId, userId };
      return { ok: true, value: signedIn };
    },
    logout: async (session) => {
      const answer = await json<unknown>('/api/session', { method: 'DELETE', session });
      return answer.ok ? { ok: true, value: null } : answer;
    },
    endSession: async (key) => {
      const answer = await json<unknown>('/api/session/end', { body: { key }, method: 'POST' });
      return answer.ok ? { ok: true, value: null } : answer;
    },
    // Only the operation's own fields, whatever else the object handed in carries.
    operate: async (session, { args, build, module, name, operationId }) => {
      const body = { args, build, module, name, operationId };
      return json<OperationReceipt>('/api/operate', { body, method: 'POST', session });
    },
    publicView: async (table, id) => {
      const answer = await json<PublicView>(`/api/public?${queryOf({ id, table })}`);
      return answer.ok ? { ok: true, value: publicViewOf(answer.value) } : answer;
    },
    // The deployment a render names is the Durable Object's to read; the Node authority serves
    // the one application that started it.
    render: async (session, { build, component, props }) => {
      const body = { root: { build, component, props } };
      return json<RenderResult>('/api/render', { body, method: 'POST', session });
    },
    renderShared: async (session, { admission, build, generation, props, route, site }) => {
      const body = {
        build,
        props,
        route,
        ...(admission !== undefined && { admission }),
        ...(generation !== undefined && { generation }),
        ...(site !== undefined && { site }),
      };
      return json<SharedRenderAnswer>('/api/shared/render', { body, method: 'POST', session });
    },
    sharedEvents: async (view, head) =>
      stream(`/api/shared/events?${queryOf({ view, ...(head === true && { head: '1' }) })}`, null),
    view: async (session, { subscription, view }) => {
      const body = { subscription, view };
      return json<RenderResult>('/api/view', { body, method: 'POST', session });
    },
    // Only the write's own fields; its value as it is — `false`, `0` and `''` included — and none
    // for a write with none, as an update the authority computes is, which may send its captures.
    update: async (session, { binding, captures, operationId, updaterId, value }) => {
      const body = {
        binding,
        operationId,
        updaterId,
        ...(value !== undefined && { value }),
        ...(captures !== undefined && { captures }),
      };
      return json<FieldReceipt>('/api/update', { body, method: 'POST', session });
    },
  };
}
