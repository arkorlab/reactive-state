import { assertedSessionOf } from '../asserted.ts';
import type { Result } from '../program.ts';
import { AUTHORITY_OBJECT_NAME, type AuthorityClient, type SessionId } from './contract.ts';
import { timeoutOf, TOO_SLOW, unavailable, UNREACHABLE } from './results.ts';

/**
 * The authority on Cloudflare — a Durable Object the platform hosts for the application — over its
 * binding: one object, whose RPC methods are the contract's own, so a call is the method called on
 * its stub. Typed by its shape alone, which a native `DurableObjectNamespace` has, so that code
 * `next build` evaluates in Node never reaches for `@cloudflare/workers-types` or
 * `cloudflare:workers`.
 */

/** The object's stub, as much of one as is called: the contract's methods, over RPC. */
export type AuthorityStub = AuthorityClient;

/**
 * A Durable Object namespace, as much of one as is read: an object by its name, placed near where a
 * hint names (`locationHint`) when it is first made — never moved after.
 */
export interface AuthorityNamespace {
  readonly getByName: (name: string, options?: { readonly locationHint?: string }) => AuthorityStub;
}

export interface BindingClientOptions {
  /**
   * The deployment asking (`NEXT_DEPLOYMENT_ID`), which every render names for the authority to
   * catch that deployment's pages up, and each gate's question as the one its request is of.
   */
  readonly deployment?: string | undefined;
  /**
   * How long a call may wait for its answer, and the event stream for its opening: a positive whole
   * number of milliseconds (`timeoutOf`), `REQUEST_TIMEOUT_MS` unless given.
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Where the object is placed when it is first made (`wnam`, `apac`, …): near the data it reads, for
   * an application whose data is elsewhere than its visitors. Cloudflare reads it on the object's
   * first use alone, and never moves an object after.
   */
  readonly locationHint?: string | undefined;
}

/**
 * The session a call names, as it crosses the RPC: a demo session's id, or an asserted session's
 * three fields alone — anything else an object handed in carried would be serialized with them.
 */
function crossing(session: SessionId): SessionId {
  return typeof session === 'object' && session !== null
    ? (assertedSessionOf(session) ?? null)
    : session;
}

const TIMED_OUT = Symbol('timed out');

/**
 * Whether an RPC answered a `Result`, as the contract says it does — and an older class may not: a
 * success carries its value, whatever it is, and a failure its status, code and message.
 */
function isResult(value: unknown): value is Result<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { code, message, ok, status } = value as Partial<Record<string, unknown>>;
  return (
    (ok === true && Object.hasOwn(value, 'value')) ||
    (ok === false &&
      typeof status === 'number' &&
      typeof code === 'string' &&
      typeof message === 'string')
  );
}

/**
 * One call, raced against `timeoutMs`: an RPC takes no signal, so a call that is not answered in
 * time is left behind rather than stopped, and what it answers later goes to `abandon`. A call that
 * throws — the object was reset, overloaded, or never reached — has an unknown outcome, as one that
 * never answered does.
 */
async function settle<T>(
  call: () => Promise<Result<T>>,
  timeoutMs: number,
  abandon?: (late: Promise<Result<T>>) => Promise<void>,
): Promise<Result<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMED_OUT);
    }, timeoutMs);
  });
  // Never refused: whatever the call throws is its answer, so one left behind rejects nothing.
  const answered = (async (): Promise<Result<T>> => {
    try {
      const result = await call();
      return isResult(result)
        ? result
        : unavailable('The authority answered something other than a result.');
    } catch {
      return unavailable(UNREACHABLE);
    }
  })();
  try {
    const first = await Promise.race([answered, timedOut]);
    if (first !== TIMED_OUT) {
      return first;
    }
    if (abandon !== undefined) {
      void abandon(answered).catch(() => {
        // Nobody is left to tell: the call it belonged to was answered already.
      });
    }
    return unavailable(TOO_SLOW);
  } finally {
    clearTimeout(timer);
  }
}

/** A stream that arrives after its caller gave up on it: nobody will read it, so it is let go. */
async function discard(late: Promise<Result<ReadableStream<Uint8Array>>>): Promise<void> {
  const result = await late;
  if (result.ok) {
    await result.value.cancel();
  }
}

export function bindingClient(
  namespace: AuthorityNamespace,
  options: BindingClientOptions = {},
): AuthorityClient {
  const timeoutMs = timeoutOf(options.timeoutMs);
  const placement =
    options.locationHint === undefined ? undefined : { locationHint: options.locationHint };
  // A stub per call: making one is no I/O, and one is not carried from a request into another.
  const stub = (): AuthorityStub => {
    return placement === undefined
      ? namespace.getByName(AUTHORITY_OBJECT_NAME)
      : namespace.getByName(AUTHORITY_OBJECT_NAME, placement);
  };
  const call = async <T>(
    rpc: (authority: AuthorityStub) => Promise<Result<T>>,
    abandon?: (late: Promise<Result<T>>) => Promise<void>,
  ): Promise<Result<T>> => settle(async () => rpc(stub()), timeoutMs, abandon);
  // Only the fields the contract names cross: anything else on an object handed in would be
  // serialized with them, a function as a stub.
  return {
    // Only the opening is timed: the stream lasts as long as the application reads it.
    events: async (session, subscription) =>
      call((authority) => authority.events(crossing(session), subscription), discard),
    gate: async ({ deployment = options.deployment, headers, method, route, site, url }) => {
      const request = {
        headers,
        method,
        route,
        url,
        ...(site !== undefined && { site }),
        ...(deployment !== undefined && { deployment }),
      };
      return call((authority) => authority.gate(request));
    },
    guardRoute: async (session, { admit, route, url }) => {
      return call((authority) =>
        authority.guardRoute(crossing(session), { route, url, ...(admit === true && { admit }) }),
      );
    },
    login: async (user) => call((authority) => authority.login(user)),
    logout: async (session) => call((authority) => authority.logout(crossing(session))),
    endSession: async (key) => call((authority) => authority.endSession(key)),
    operate: async (session, { args, build, module, name, operationId }) => {
      const call$ = { args, build, module, name, operationId };
      return call((authority) => authority.operate(crossing(session), call$));
    },
    publicView: async (table, id) => call((authority) => authority.publicView(table, id)),
    render: async (session, { build, component, props }, caller) => {
      const deployment = caller?.deployment ?? options.deployment;
      const named = deployment === undefined ? {} : { deployment };
      return call((authority) =>
        authority.render(crossing(session), { build, component, props }, named),
      );
    },
    view: async (session, { subscription, view }, caller) => {
      const deployment = caller?.deployment ?? options.deployment;
      const named = deployment === undefined ? {} : { deployment };
      return call((authority) => authority.view(crossing(session), { subscription, view }, named));
    },
    renderShared: async (session, { admission, build, generation, props, route, site }, caller) => {
      const request = {
        build,
        props,
        route,
        ...(admission !== undefined && { admission }),
        ...(generation !== undefined && { generation }),
        ...(site !== undefined && { site }),
      };
      const deployment = caller?.deployment ?? options.deployment;
      const named = deployment === undefined ? {} : { deployment };
      return call((authority) => authority.renderShared(crossing(session), request, named));
    },
    sharedEvents: async (view, head) =>
      call((authority) => authority.sharedEvents(view, head), discard),
    // A `set`'s value crosses as it is — `false`, `0` and `''` included — and an update the
    // authority computes sends none, its captures at most.
    update: async (session, { binding, captures, operationId, updaterId, value }) => {
      const operation = {
        binding,
        operationId,
        updaterId,
        ...(value !== undefined && { value }),
        ...(captures !== undefined && { captures }),
      };
      return call((authority) => authority.update(crossing(session), operation));
    },
  };
}
