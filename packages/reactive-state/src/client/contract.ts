import type { AssertedSession } from '../asserted.ts';
import type {
  FieldOperation,
  FieldReceipt,
  OperationCall,
  OperationReceipt,
  RenderResult,
  Result,
  RootRequest,
  Value,
  ViewRequest,
} from '../program.ts';
import type {
  GateAnswer,
  GateRequest,
  GuardAnswer,
  GuardRequest,
  SharedRenderAnswer,
  SharedRenderRequest,
} from '../routing.ts';

/**
 * What an application's server asks of the authority, whichever authority it is: the Node process
 * on a developer's machine, over HTTP (`httpClient`), or the Durable Object on Cloudflare, over its
 * binding (`bindingClient`), whose RPC methods have these very signatures. Every answer is a
 * `Result`, refusals included: an error thrown across a Durable Object's RPC reaches the caller as an
 * `Error` of another class, whatever of its own fields the runtime carries over with it.
 *
 * Runtime-neutral: an application imports it from code `next build` evaluates in Node.
 */

/**
 * The one object that is the authority on Cloudflare: every session, record and change of the
 * application is in it, and every deployment of the application reaches it by this name.
 */
export const AUTHORITY_OBJECT_NAME = 'authority';

/**
 * A session's id, as the demo's cookie carries it, or a session the application's server vouches
 * for (`AssertedSession`); `null` when the request carries none.
 */
export type SessionId = string | AssertedSession | null;

/** A session just opened. The application sets the cookie: `SESSION_COOKIE`, `HttpOnly`. */
export interface SignedIn {
  readonly sessionId: string;
  readonly userId: string;
}

/**
 * A record's public fields, as anyone may see them: what a page rendered without a session shows,
 * and the revision it shows them at.
 */
export interface PublicView {
  readonly table: string;
  readonly id: string;
  readonly revision: number;
  readonly values: Readonly<Record<string, Value>>;
  /** A digest of the values, which names what a page rendered from them shows. */
  readonly resultVersion: string;
}

/** Which deployment of the application is asking, for the authority to catch its pages up. */
export interface Caller {
  /** `NEXT_DEPLOYMENT_ID`, as the platform binds it on a deployment's Functions. */
  readonly deployment?: string | undefined;
}

export interface AuthorityClient {
  login: (user: string) => Promise<Result<SignedIn>>;
  logout: (session: SessionId) => Promise<Result<null>>;
  /**
   * Ends every session the application's server asserted under `key` (`AssertedSession.id`), and
   * each stream of one, for good: the application's sign-out. Ending a key that no session was
   * asserted under, or one already ended, is no refusal.
   */
  endSession: (key: string) => Promise<Result<null>>;
  /**
   * A root and every reactive component it renders, evaluated at one revision: the tree, and the
   * frame it was rendered at. A session that may not see the root is answered with the root's
   * status and an empty tree, and a frame to follow it with all the same.
   */
  render: (session: SessionId, root: RootRequest, caller?: Caller) => Promise<Result<RenderResult>>;
  /**
   * The root a frame's signed subscription names, rendered again for the view a page shows: each
   * dynamic site it names with its inputs, at one revision, as `render` renders the root.
   */
  view: (
    session: SessionId,
    request: ViewRequest,
    caller?: Caller,
  ) => Promise<Result<RenderResult>>;
  /** One write to a field; its `value`, for a `set`, crosses as it is — `false`, `0` and `''` included. */
  update: (session: SessionId, operation: FieldOperation) => Promise<Result<FieldReceipt>>;
  /** One server operation, run once however often it is sent under one operation id. */
  operate: (session: SessionId, call: OperationCall) => Promise<Result<OperationReceipt>>;
  /** A record's public fields; a table with none is not found. */
  publicView: (table: string, id: string) => Promise<Result<PublicView>>;
  /**
   * The session's server-sent events for a rendered root, by the frame's signed subscription: a
   * `frame` event saying the revision of each newer render that shows something else, and
   * `revoked` when the session ends, after which the stream ends. A refusal before the stream starts
   * is answered as a failure instead.
   */
  events: (session: SessionId, subscription: string) => Promise<Result<ReadableStream<Uint8Array>>>;
  /**
   * A route's root as the route's page renders it: the shared view every visitor is answered with —
   * the generation the authority asked for, where the request carries its token — or, for a route
   * whose render is the request's and for props of no view, the session's render of it. Named by
   * its deployment, as `render` is: a deployment whose pages render registered routes alone is one
   * the authority hears of too.
   */
  renderShared: (
    session: SessionId,
    request: SharedRenderRequest,
    caller?: Caller,
  ) => Promise<Result<SharedRenderAnswer>>;
  /** A route's gate's answer to a request for its page: the response, or to pass it on. */
  gate: (request: GateRequest) => Promise<Result<GateAnswer>>;
  /**
   * A route's guards, run for the session as a render of the route's root runs them, of the params
   * the authority reads of the URL: `pass`, `refused`, or the response a guard answered itself. A
   * route it does not know is not found (404), and a URL not of the route refused (400).
   */
  guardRoute: (session: SessionId, request: GuardRequest) => Promise<Result<GuardAnswer>>;
  /**
   * A shared view's server-sent events, by the view token its page holds: `ready` for each newer
   * generation published, `denied` once the view is refused. No session reads it. The optional
   * `head` flag is the internal bridge's token check alone: no view is admitted or followed.
   */
  sharedEvents: (view: string, head?: true) => Promise<Result<ReadableStream<Uint8Array>>>;
}
