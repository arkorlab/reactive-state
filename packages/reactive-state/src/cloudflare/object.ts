import { DurableObject } from 'cloudflare:workers';

import { AuthorityEngine } from '../authority/engine.ts';
import { AuthorityError } from '../authority/errors.ts';
import type { ExternalStores } from '../authority/external.ts';
import type { Application, AuthorityEngineOptions, Stats } from '../authority/model.ts';
import { registryOf } from '../authority/programs.ts';
import { fieldOperationOf, operationCallOf, rootOf, viewRequestOf } from '../authority/requests.ts';
import { routeRegistryOf } from '../authority/route-registry.ts';
import { sharedEventStream } from '../authority/shared-events.ts';
import type { SiteFetch } from '../authority/shared-generate.ts';
import type {
  AuthorityClient,
  Caller,
  PublicView,
  SessionId,
  SignedIn,
} from '../client/contract.ts';
import type { PublicPage } from '../delivery/site.ts';
import type {
  FieldOperation,
  FieldReceipt,
  OperationCall,
  OperationReceipt,
  RenderResult,
  Result,
  RootRequest,
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
import { ObjectAlarm, scheduleExternalAlarm } from './alarm.ts';
import { DELIVERY_DELAY_MS, pagesOf, SiteDelivery } from './delivery.ts';
import { type AuthorityEnv, siteOf } from './env.ts';
import { durableObjectSql } from './sql.ts';
import { EventStreams } from './stream.ts';

/**
 * The authority as a Durable Object: the engine the Node authority runs (`AuthorityEngine`), over
 * the object's own SQLite, answering the application's server over its binding. Its RPC methods are
 * the client contract's (`AuthorityClient`): a page's root rendered once, with every reactive
 * component its tree renders, at one revision; a write to a field through a binding the render
 * issued; a server operation, run once however often it is sent; and the event stream a page
 * follows its root by. Every one answers a `Result`: a refusal of the authority's is an answer,
 * which the caller reads by its status and code — across an RPC a thrown error is no
 * `AuthorityError` on the caller's side, whatever fields of it the runtime carries. Anything else
 * thrown is a fault, and is thrown — for the caller, an answer it never had.
 *
 * One object is the whole authority — every session, record and change of the application, for
 * every component and server operation it compiled — and every deployment of the application
 * reaches it by one name (`AUTHORITY_OBJECT_NAME`). It delivers its own change log to the
 * application from its alarm (`delivery.ts`).
 */

/**
 * What the object runs, as a compile registers it (`<out>/authority.mts`): every component's
 * program, the `'use server'` modules they import, the application's database, and the build.
 */
export type AuthorityApplication = Application;

export interface AuthorityObjectOptions {
  /**
   * How long after a commit the change log goes out; the commits within it go in one request. A
   * second unless given.
   */
  readonly deliveryDelayMs?: number;
  /**
   * The pages the application renders without a session (`/public`), each with the records whose
   * public fields it shows: a delivery waits for a page to show a change to one of them, and a new
   * deployment has its pages checked. Without any, the site is told of each change, and that is
   * all.
   */
  readonly pages?: readonly PublicPage[];
  /**
   * The stores the application's external tables are read through, by the names the tables
   * declare (`table(fields, { external })`), made of the object's environment as it starts: a D1
   * database it is bound to (`d1Store`), a service of the application's own.
   */
  readonly stores?: ((env: StoreEnv) => ExternalStores) | undefined;
  /** How often each store's change log is read while a stream follows: a second unless given. */
  readonly externalPollMs?: number | undefined;
}

/** The object's environment, as its stores are made of it: its bindings, whatever they are. */
type StoreEnv = AuthorityEnv & Readonly<Record<string, unknown>>;

/** What the object counts: the engine's figures, and the event streams open now. */
export interface AuthorityStats extends Stats {
  readonly streams: number;
}

interface AuthoritySetup extends AuthorityApplication {
  readonly deliveryDelayMs?: number | undefined;
  readonly pages: readonly PublicPage[];
  readonly stores?: ((env: StoreEnv) => ExternalStores) | undefined;
  readonly externalPollMs?: number | undefined;
}

/** How often a shared view's stream with nothing to say says so. */
const HEARTBEAT_MS = 15_000;

/**
 * How the object asks its site for a route's page, to make a shared view's artifacts of: the site
 * its change log goes to, through the project's access protection where it has a bypass; none for
 * an object that knows no site, which makes no artifact.
 */
function siteFetchOf(env: AuthorityEnv): SiteFetch | undefined {
  const site = siteOf(env);
  if (site.kind !== 'site') {
    return undefined;
  }
  const bypass = site.bypass === undefined ? {} : { [site.bypass.header]: site.bypass.value };
  return async (path, headers, signal) => {
    return fetch(`${site.origin}${path}`, {
      headers: { ...headers, ...bypass },
      redirect: 'manual',
      ...(signal !== undefined && { signal }),
    });
  };
}

/** A call's answer as a `Result`: the authority's refusals included, and nothing else caught. */
async function answer<T>(body: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await body() };
  } catch (error) {
    if (error instanceof AuthorityError) {
      return { code: error.code, message: error.message, ok: false, status: error.status };
    }
    throw error;
  }
}

export class AuthorityObject extends DurableObject<AuthorityEnv> implements AuthorityClient {
  readonly #engine: AuthorityEngine;
  readonly #streams: EventStreams;
  readonly #delivery: SiteDelivery;

  constructor(ctx: DurableObjectState, env: AuthorityEnv, setup: AuthoritySetup) {
    super(ctx, env);
    // Opened synchronously, as the object's storage is read: the schema is applied as the engine's
    // database opens, in one transaction, and the data is the object's from then on. A database of
    // another schema is refused, and the object with it, rather than read as something else.
    const sql = durableObjectSql(ctx.storage);
    const alarm = new ObjectAlarm(ctx.storage);
    const options: AuthorityEngineOptions = {
      buildId: setup.buildId,
      database: setup.database,
      // The external stores' turns: the object's one alarm, shared with delivery, armed once what
      // the answer wrote is confirmed; and a read that runs on after an answer, kept meanwhile.
      externalHost: {
        keep: (work) => {
          ctx.waitUntil(work);
        },
        schedule: async (at) => scheduleExternalAlarm(ctx.storage, alarm, at),
      },
      middleware: setup.middleware,
      operations: setup.operations,
      programs: setup.programs,
      routes: setup.routes,
      ...(setup.sessions !== undefined && { sessions: setup.sessions }),
      ...(setup.shareViews !== undefined && { shareViews: setup.shareViews }),
      externalPollMs: setup.externalPollMs,
      sql,
      stores: setup.stores?.(env as StoreEnv),
    };
    this.#engine = new AuthorityEngine(options);
    this.#engine.site(siteFetchOf(env));
    this.#streams = new EventStreams(this.#engine);
    this.#delivery = new SiteDelivery({
      alarm,
      delayMs: setup.deliveryDelayMs ?? DELIVERY_DELAY_MS,
      engine: this.#engine,
      env,
      pages: setup.pages,
      sql,
      storage: ctx.storage,
    });
    this.#engine.onCommit(() => {
      this.#delivery.committed();
    });
    this.#delivery.resume();
  }

  /**
   * A call that may commit, answered once the delivery its commit asks for is armed: an object
   * reset in between would otherwise have a change the site takes only once it starts again. A
   * fault is thrown only then too, since an operation commits before what it does after may fault.
   */
  async #committing<T>(body: () => Promise<T>): Promise<Result<T>> {
    try {
      return await answer(body);
    } finally {
      await this.#delivery.armed();
    }
  }

  async login(user: string): Promise<Result<SignedIn>> {
    return answer(async () => this.#engine.login(user));
  }

  async logout(session: SessionId): Promise<Result<null>> {
    return this.#committing(async () => {
      await this.#engine.logout(session);
      return null;
    });
  }

  /**
   * Reads each external store's change log now, and announces what it says changed: for the
   * application's own code, after a write of its own, which would else be read within a second.
   */
  async poke(): Promise<Result<null>> {
    return this.#committing(async () => {
      await this.#engine.poke();
      return null;
    });
  }

  /** Ends every session the application's server asserted under `key`, and their streams. */
  async endSession(key: string): Promise<Result<null>> {
    return this.#committing(async () => {
      await this.#engine.endSession(key);
      return null;
    });
  }

  /**
   * A page's root and every reactive component its tree renders, for the session, at one
   * revision: the tree, and the frame it is shown at. A deployment the object has not heard from
   * has its pages checked. The root is read for its three fields alone (`rootOf`), whatever else
   * the caller's object carried across the RPC.
   */
  async render(
    session: SessionId,
    root: RootRequest,
    caller?: Caller,
  ): Promise<Result<RenderResult>> {
    const answered = await answer(async () => this.#engine.render(session, rootOf(root)));
    await this.#delivery.noteCaller(caller);
    return answered;
  }

  /**
   * The root a frame's subscription names, rendered again for the view a page shows, as it crossed
   * the RPC: nothing but the request's own fields (`viewRequestOf`).
   */
  async view(
    session: SessionId,
    request: ViewRequest,
    caller?: Caller,
  ): Promise<Result<RenderResult>> {
    const answered = await answer(async () => this.#engine.view(session, viewRequestOf(request)));
    await this.#delivery.noteCaller(caller);
    return answered;
  }

  /**
   * One write to a field, as it crossed the RPC: its `value`, for a `set`, reaches the engine as the
   * caller sent it, and nothing but the fields a write names (`fieldOperationOf`).
   */
  async update(session: SessionId, operation: FieldOperation): Promise<Result<FieldReceipt>> {
    return this.#committing(async () => this.#engine.update(session, fieldOperationOf(operation)));
  }

  /**
   * One server operation, as it crossed the RPC: the fields an operation names alone
   * (`operationCallOf`), its arguments each a form's entries or JSON.
   */
  async operate(session: SessionId, call: OperationCall): Promise<Result<OperationReceipt>> {
    return this.#committing(async () => this.#engine.operate(session, operationCallOf(call)));
  }

  /** A record's public fields, and not what the authority's cache made of them. */
  async publicView(table: string, id: string): Promise<Result<PublicView>> {
    return answer(async (): Promise<PublicView> => {
      const snapshot = await this.#engine.publicSnapshot(table, id);
      return {
        id: snapshot.id,
        resultVersion: snapshot.resultVersion,
        revision: snapshot.revision,
        table: snapshot.table,
        values: snapshot.values,
      };
    });
  }

  /**
   * The session's event stream for a rendered root, by the subscription its frame was issued with.
   * The root is rendered before the stream is handed over: a refusal of it is answered as one, and
   * no stream is left open for it.
   */
  async events(
    session: SessionId,
    subscription: string,
  ): Promise<Result<ReadableStream<Uint8Array>>> {
    return answer(async () => this.#streams.open(session, subscription));
  }

  /**
   * A route's root as its page renders it: the shared view, or the session's render of a route that
   * is the request's or of props of no view — the request read for the fields it names alone
   * (`sharedRequestOf`). A deployment the object has not heard from has its pages checked, as a
   * `render` has them.
   */
  async renderShared(
    session: SessionId,
    request: SharedRenderRequest,
    caller?: Caller,
  ): Promise<Result<SharedRenderAnswer>> {
    const answered = await answer(async () => this.#engine.renderShared(session, request));
    await this.#delivery.noteCaller(caller);
    return answered;
  }

  /** A route's gate's answer to a request for its page. */
  async gate(request: GateRequest): Promise<Result<GateAnswer>> {
    return answer(async () => this.#engine.gate(request));
  }

  /**
   * A route's guards, run for the session as a render of its root runs them: the request read for
   * the route and the URL alone (`guardRequestOf`), the route's params read of the URL.
   */
  async guardRoute(session: SessionId, request: GuardRequest): Promise<Result<GuardAnswer>> {
    return answer(async () => this.#engine.guardRoute(session, request));
  }

  /** A shared view's event stream, by the token its page holds: no session reads it. */
  async sharedEvents(view: string, head?: true): Promise<Result<ReadableStream<Uint8Array>>> {
    return answer(async () => {
      if (head === true) {
        await this.#engine.checkShared(view);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
      }
      return sharedEventStream(await this.#engine.followShared(view), HEARTBEAT_MS);
    });
  }

  /** The engine's figures and the open streams, as the Node authority's `/internal/stats`. */
  async stats(): Promise<AuthorityStats> {
    const stats = await this.#engine.stats();
    return { ...stats, streams: this.#streams.size + stats.sharedStreams };
  }

  override async alarm(): Promise<void> {
    await Promise.all([this.#engine.pollExternal(), this.#delivery.run()]);
  }
}

/** A class of the authority's object for one application, as a Worker exports it. */
export type AuthorityObjectClass = new (
  ctx: DurableObjectState,
  env: AuthorityEnv,
) => AuthorityObject;

/**
 * The authority's Durable Object for an application — what its compile registered, and its
 * database — for a Worker to export under the class name its binding names: a Durable Object
 * module is `authorityObject({ buildId, database, operations, programs })` of the compile's
 * `<out>/authority.mts`, with its public pages, if it has any.
 *
 * What it is given is checked here, as the Worker loads, and not only as the object first starts:
 * a program compiled for another protocol or another build, a server operation module that is
 * none, a declaration that is no `database()`'s, or a page the object could never see show a
 * change fails the Worker's own start, with why, rather than every request — or every delivery —
 * after it.
 */
export function authorityObject(
  application: AuthorityApplication,
  options: AuthorityObjectOptions = {},
): AuthorityObjectClass {
  const { buildId, database, middleware, operations, programs, routes, sessions, shareViews } =
    application;
  routeRegistryOf(
    { middleware, routes, shareViews },
    registryOf({ buildId, operations, programs }),
  );
  const pages = pagesOf(options.pages ?? [], database);
  const { deliveryDelayMs, externalPollMs, stores } = options;
  const setup = {
    buildId,
    database,
    deliveryDelayMs,
    externalPollMs,
    middleware,
    operations,
    pages,
    programs,
    routes,
    sessions,
    shareViews,
    stores,
  };
  return class extends AuthorityObject {
    constructor(ctx: DurableObjectState, env: AuthorityEnv) {
      super(ctx, env, setup);
    }
  };
}
