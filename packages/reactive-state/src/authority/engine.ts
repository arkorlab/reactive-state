import { randomBytes } from 'node:crypto';

import {
  type ChangeEvent,
  type ComponentProgram,
  type FieldReceipt,
  type OperationReceipt,
  type RenderResult,
} from '../program.ts';
import type { GateAnswer, GuardAnswer, SharedRenderAnswer, SiteShape } from '../routing.ts';
import { type DatabaseDefinition, definitionOf } from '../server/schema.ts';
import { watchUntracked } from '../server/untracked.ts';
import {
  BUILD_MISMATCH,
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_NOT_FOUND,
  HTTP_UNAUTHORIZED,
  UNKNOWN_COMPONENT,
} from '../status.ts';
import { verifySubscription } from './bindings.ts';
import { Committer } from './commits.ts';
import { Database } from './database.ts';
import { assertId, refusal } from './errors.ts';
import { timeoutOf } from './evaluation.ts';
import { externalTailOf, readAfterOperation } from './external-engine.ts';
import { type ExternalTail, pollIntervalOf } from './external-tail.ts';
import { storesOf } from './external.ts';
import { writeField } from './fields.ts';
import { frameOf } from './frames.ts';
import { Memo } from './memo.ts';
import type {
  AuthorityEngineOptions,
  CommitListener,
  Core,
  Metrics,
  PublicSnapshot,
  Session,
  Stats,
  Watched,
} from './model.ts';
import { runOperation } from './operations.ts';
import { type Registry, registryOf } from './programs.ts';
import { PublicViews } from './public.ts';
import { publishes } from './records.ts';
import { fieldOperationOf, operationCallOf, rootOf, viewRequestOf } from './requests.ts';
import { guardedRouteOf, guardRequestOf, routeGuards } from './route-guards.ts';
import { routeRegistryOf } from './route-registry.ts';
import { seedDatabase } from './seed.ts';
import { endedResource, Sessions } from './sessions.ts';
import type { SiteFetch } from './shared-generate.ts';
import { gateRequestOf, sharedRequestOf } from './shared-requests.ts';
import { SharedStore } from './shared-store.ts';
import { type SharedFollowing, SharedViews } from './shared-views.ts';
import { Tables } from './tables.ts';
import { type Root, statusView, viewOf } from './views.ts';

/**
 * The authority: one SQLite database (`SqlDriver`: Node's on a developer's machine, a Durable
 * Object's on Cloudflare) holding the tables the application declares, and one queue every call
 * joins, with nothing else of the authority's inside one. A call that runs the application's code —
 * a page's render, a write's replay of the components along its binding's path, a server
 * operation — holds the queue while it awaits that code, so every component of a page reads one
 * snapshot, and a write's last read and its commit run with nothing between them.
 *
 * Only the statements that write are in a transaction; the reads before them are not, and need not
 * be. On a developer's machine nothing else writes the file, nor anything else what the engine keeps
 * in a Durable Object's storage. That storage would refuse the `BEGIN` an operation-long transaction
 * takes, and runs a transaction's body synchronously, which the application's code is not: a server
 * operation's writes wait in its transaction until it is over, and are committed at once.
 */

/** The bytes of the id of this authority's life (`Core['boot']`). */
const BOOT_BYTES = 32;

// Before the authority’s caller loads its application modules.
watchUntracked();

function buildMismatch(): Error {
  return refusal(HTTP_CONFLICT, BUILD_MISMATCH, 'The application was updated. Reload the page.');
}

/** The refusal of a request of no session, or of one that ended: sign in first (401). */
function signInFirst(): Error {
  return refusal(HTTP_UNAUTHORIZED, 'UNAUTHENTICATED', 'Sign in first.');
}

export class AuthorityEngine {
  readonly #db: Database;
  readonly #commits: Committer;
  readonly #sessions: Sessions;
  readonly #definition: DatabaseDefinition;
  readonly #registry: Registry;
  readonly #tables: Tables;
  readonly #memo: Memo;
  /** Whether a page without a session may show what a resource names. */
  readonly #publishes: (resource: string) => boolean;
  readonly #clock: () => number;
  readonly #secret: string;
  readonly #public: PublicViews;
  readonly #listeners = new Set<CommitListener>();
  readonly #metrics: Metrics = {
    appReads: 0,
    artifactBytes: 0,
    artifactReads: 0,
    artifactRenders: 0,
    cacheHits: 0,
    commits: 0,
    deduplicated: 0,
    evaluations: 0,
    gateLookups: 0,
    gateWaits: 0,
    generationFailures: 0,
    generations: 0,
    guardEvaluations: 0,
    invalidations: 0,
    memoEvictions: 0,
    memoHits: 0,
    middlewareReads: 0,
    nextRenders: 0,
    operationRuns: 0,
    queryEvaluations: 0,
    renderQueries: 0,
    renders: 0,
    sharedEvaluations: 0,
    siteRenders: 0,
    updaterRuns: 0,
  };
  readonly #evaluatedBy = new Map<string, number>();
  readonly #core: Core;
  readonly #shared: SharedViews;
  /** What follows the change logs of the stores the external tables are read through. */
  readonly #tail: ExternalTail;
  /** Whether any table is read through a store, whose log an operation may have written to. */
  readonly #external: boolean;
  /** How the authority asks its site for a page: the host's, once it knows the site. */
  #site: SiteFetch | undefined;
  #queue: Promise<undefined> = Promise.resolve(undefined);
  #closed = false;

  /** A stream's hold on external logs, and the host's immediate and scheduled reads. */
  readonly following = (): (() => void) => this.#tail.follow();
  readonly poke = (): Promise<void> => this.#tail.read();
  readonly pollExternal = (): Promise<void> => this.#tail.run();

  constructor(options: AuthorityEngineOptions) {
    // What the authority is given is checked before its database is opened, which a program or a
    // declaration it refuses leaves as it was.
    this.#registry = registryOf(options);
    const routes = routeRegistryOf(options, this.#registry);
    this.#definition = definitionOf(options.database);
    const stores = storesOf(this.#definition, options.stores);
    this.#external = stores.size > 0;
    const externalPollMs = pollIntervalOf(options.externalPollMs);
    this.#publishes = publishes(this.#definition);
    this.#clock = options.clock ?? Date.now;
    this.#memo = new Memo(this.#clock);
    const timeoutMs = timeoutOf(options.timeoutMs);
    this.#db = new Database(options.sql);
    this.#sessions = new Sessions(this.#db, this.#clock, options.sessions);
    seedDatabase(this.#db, this.#definition, this.#clock);
    this.#secret = this.#db.bindingSecret();
    this.#tables = new Tables(this.#db, this.#definition, stores);
    this.#public = new PublicViews(this.#db, this.#tables, this.#definition, this.#metrics);
    this.#core = {
      boot: randomBytes(BOOT_BYTES).toString('base64url'),
      clock: this.#clock,
      commit: (commit) => this.#commits.commit(commit),
      db: this.#db,
      definition: this.#definition,
      evaluatedBy: this.#evaluatedBy,
      memo: this.#memo,
      metrics: this.#metrics,
      registry: this.#registry,
      routes,
      secret: this.#secret,
      current: (session) => {
        const current = this.#sessions.current(session);
        if (current === undefined) {
          throw signInFirst();
        }
        return current;
      },
      session: (id) => this.#session(id),
      sweep: () => {
        this.#sessions.sweep();
      },
      tables: this.#tables,
      timeoutMs,
    };
    this.#shared = new SharedViews({
      core: this.#core,
      gateWaitMs: options.gateWaitMs,
      renderSession: async (route, props, session, admission) =>
        this.#routeRender({ component: route.root, props }, session, admission),
      run: (body) => this.#run(body),
      secret: this.#secret,
      site: () => this.#site,
      store: new SharedStore(options.sql),
    });
    this.#shared.load();
    this.#commits = new Committer({
      clock: this.#clock,
      db: this.#db,
      listeners: this.#listeners,
      memo: this.#memo,
      metrics: this.#metrics,
      publicViews: this.#public,
      sessions: this.#sessions,
      shared: this.#shared,
      tables: this.#tables,
    });
    this.#tail = externalTailOf({
      clock: this.#clock,
      everyMs: externalPollMs,
      host: options.externalHost,
      readTimeoutMs: timeoutMs,
      // What a store's log says changed is announced as a commit is, and writes none of its records.
      ingest: async (rows) => {
        await this.#run(() => {
          this.#commits.commit({ external: true, kind: 'state', rows });
        });
      },
      memo: this.#memo,
      shared: this.#shared,
      stores,
      tables: this.#definition.tables,
    });
    this.#tail.refreshLater();
  }

  /** Runs `body` after everything queued before it, and before anything queued after it. */
  async #run<T>(body: () => Promise<T> | T): Promise<T> {
    const previous = this.#queue;
    const { promise, resolve } = Promise.withResolvers<undefined>();
    this.#queue = promise;
    try {
      await previous;
      if (this.#closed) {
        throw new Error('The authority is closed');
      }
      return await body();
    } finally {
      resolve(undefined);
      this.#tail.refreshLater();
    }
  }

  #session(id: unknown): Session {
    const session = this.#sessionOrNone(id);
    if (session === undefined) {
      throw signInFirst();
    }
    return session;
  }

  #sessionOrNone(id: unknown): Session | undefined {
    return this.#sessions.resolve(id);
  }

  /**
   * A route's root of the props its page gave it, rendered for the request's session — or for none,
   * as a route's page renders it for a visitor of none — guards first, of the params the props give
   * them (`guardedBy`).
   */
  async #routeRender(
    root: Root,
    session: Session | undefined,
    admission?: string,
  ): Promise<RenderResult> {
    const view = await viewOf(this.#core, session, root, { admission, bindings: true });
    return {
      frame: frameOf(this.#core, session, root, view),
      status: view.status,
      tree: view.assembly.tree,
    };
  }

  /** The build the authority runs: every program's, and the one each request must name. */
  get buildId(): string {
    return this.#registry.buildId;
  }

  /**
   * Every component's program the authority runs, by its id: a copy, which whoever holds it may
   * change without changing what the authority runs.
   */
  get programs(): ReadonlyMap<string, ComponentProgram> {
    return new Map(this.#registry.programs);
  }

  /** The functions each server operation module exports, by the module's id, in name order. */
  get operations(): ReadonlyMap<string, readonly string[]> {
    const operations = new Map<string, readonly string[]>();
    for (const [module, exports] of this.#registry.operations) {
      const names = Object.keys(exports).filter((name) => typeof exports[name] === 'function');
      operations.set(
        module,
        names.toSorted((a, b) => a.localeCompare(b)),
      );
    }
    return operations;
  }

  /** Announces each commit to `listener` until the returned function is called. */
  onCommit(listener: CommitListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  revision(): number {
    return this.#db.revision();
  }

  /**
   * The authority's clock, in epoch milliseconds: what it judges whether a session has expired by.
   * The `clock` it was opened with, `Date.now` unless given, which a stream reads to tell a refusal
   * for the expiry of an asserted session's `expires` from one for its end.
   */
  now(): number {
    return this.#clock();
  }

  async login(userId: unknown): Promise<{ readonly sessionId: string; readonly userId: string }> {
    return this.#run(() => this.#sessions.login(userId));
  }

  async session(id: unknown): Promise<Session> {
    return this.#run(() => this.#session(id));
  }

  /**
   * How long the session has before its stream is opened again, by the authority's clock: until it
   * expires, and an asserted session five minutes at most, before its page asks the application
   * again; refused once it has.
   */
  async expiresIn(id: unknown): Promise<number> {
    return this.#run(() => this.#sessions.expiresIn(this.#session(id)));
  }

  async logout(id: unknown): Promise<void> {
    await this.#run(() => {
      const session = this.#session(id);
      // The session's resource says, in this commit's event, that it ended; nothing reads a version
      // of it, so none is kept — one for each session that ever ended would only grow.
      this.#commits.commit({
        kind: 'session',
        resources: [endedResource(session)],
        rows: [],
        with: this.#sessions.ending(session),
      });
    });
  }

  /**
   * Ends every session the application's server asserted under `key`, for good — its sign-out — and
   * each stream of one, which the commit's resource says. A key no session was asserted under is
   * ended all the same, so that none ever is.
   */
  async endSession(key: unknown): Promise<void> {
    const { resource, with: ending } = this.#sessions.keyEnd(key);
    await this.#run(() => {
      this.#commits.commit({ kind: 'session', resources: [resource], rows: [], with: ending });
    });
  }

  /**
   * A page's root (`{ component, props, build }`) and every reactive component its tree renders,
   * rendered for the session at one revision: the tree and the frame it is shown at. A session
   * that may not see the root is answered with the root's status, an empty tree and a frame all
   * the same; a component the authority does not run is not found, and a root of another build is
   * refused (409).
   */
  async render(sessionId: unknown, request: unknown): Promise<RenderResult> {
    const root = rootOf(request);
    if (!this.#registry.programs.has(root.component)) {
      throw refusal(HTTP_NOT_FOUND, UNKNOWN_COMPONENT, 'There is no such component.');
    }
    if (root.build !== this.#registry.buildId) {
      throw buildMismatch();
    }
    const { component, props } = root;
    return this.#run(async () => {
      const session = this.#sessionOrNone(sessionId);
      const view =
        session === undefined
          ? statusView(this.#core, 'unauthenticated')
          : await viewOf(this.#core, session, { component, props }, { bindings: true });
      return {
        frame: frameOf(this.#core, session, { component, props }, view),
        status: view.status,
        tree: view.assembly.tree,
      };
    });
  }

  /**
   * A route's root as the route's page renders it (`SharedRenderRequest`): the shared view every
   * visitor is answered with — the generation the authority asked the page for, where the request
   * carries its token — or the session's render, for a route whose render is the request's and for
   * props that are no view's: another page's render of the root, with props of its own.
   */
  async renderShared(sessionId: unknown, request: unknown): Promise<SharedRenderAnswer> {
    const shared = sharedRequestOf(request);
    if (shared.build !== this.#registry.buildId) {
      throw buildMismatch();
    }
    return this.#run(() => this.#shared.render(shared, this.#sessionOrNone(sessionId)));
  }

  /** A route's gate's answer to a request for its page (`GateRequest`). */
  async gate(request: unknown): Promise<GateAnswer> {
    return this.#shared.gate(gateRequestOf(request));
  }

  /**
   * A route's guards, run for the session — or for none — as a render of the route's root runs
   * them, of the params the authority reads of the URL (`GuardRequest`): what the delivery route
   * asks before it asks for a page of the request's, for the response a guard answers itself, which
   * no render carries. A route it does not know is not found, and a URL not of the route refused.
   */
  async guardRoute(sessionId: unknown, request: unknown): Promise<GuardAnswer> {
    const routed = guardedRouteOf(this.#core, guardRequestOf(request));
    return this.#run(async () => routeGuards(this.#core, this.#sessionOrNone(sessionId), routed));
  }

  /**
   * A shared view's event stream, for the page that holds `token`: what it missed, and each event
   * from now on, until `listen`'s answer is called.
   */
  async followShared(token: unknown): Promise<SharedFollowing> {
    return this.#run(() => this.#shared.follow(token));
  }

  /** A shared stream's HEAD token, checked without observing, evaluating or following its view. */
  async checkShared(token: unknown): Promise<void> {
    await this.#run(() => {
      this.#shared.check(token);
    });
  }

  /**
   * How the authority asks its site for a page, from now on: what makes a view's artifacts — and,
   * where the host knows it of the build it serves, where the site serves its routes (`SiteShape`),
   * which a route's gate reads a request's path by from the first request on.
   */
  site(fetchSite: SiteFetch | undefined, shape?: SiteShape): void {
    this.#site = fetchSite;
    if (shape !== undefined) {
      this.#shared.told(shape);
    }
  }

  /**
   * The root a frame's signed subscription names, rendered again for the session that presents it,
   * for the view its page shows (`ViewRequest`): each part the request names with the sites it
   * names, with the inputs it sends, and every other part as the subscription names it, or at first,
   * at one revision, as `render` renders the root, and a subscription that follows the view. A view
   * the root's parts do not read is refused (400).
   */
  async view(sessionId: unknown, request: unknown): Promise<RenderResult> {
    const { subscription, view: requested } = viewRequestOf(request);
    return this.#run(async () => {
      const session = this.#session(sessionId);
      const claims = verifySubscription(this.#secret, subscription, {
        build: this.#registry.buildId,
        session: session.id,
      });
      const view = await viewOf(this.#core, session, claims.root, {
        bindings: true,
        view: { ...claims.view, ...requested },
      });
      return {
        frame: frameOf(this.#core, session, claims.root, view),
        status: view.status,
        tree: view.assembly.tree,
      };
    });
  }

  /**
   * One write to a field, as a page's setter sends it (`FieldOperation`). A resend under its
   * operation id answers the first one's receipt without writing again, once the binding's path
   * says the session may still write it; an id sent again for another write is refused.
   */
  async update(sessionId: unknown, request: unknown): Promise<FieldReceipt> {
    const operation = fieldOperationOf(request);
    return this.#run(async () => writeField(this.#core, sessionId, operation));
  }

  /**
   * One server operation (`OperationCall`), run once however often it is sent under one operation
   * id: a resend answers the first one's receipt, or its refusal.
   */
  async operate(sessionId: unknown, request: unknown): Promise<OperationReceipt> {
    const call = operationCallOf(request);
    if (call.build !== this.#registry.buildId) {
      throw buildMismatch();
    }
    const module = this.#registry.operations.get(call.module);
    const operation =
      module !== undefined && Object.hasOwn(module, call.name) ? module[call.name] : undefined;
    if (typeof operation !== 'function') {
      throw refusal(HTTP_NOT_FOUND, 'UNKNOWN_OPERATION', 'There is no such server operation.');
    }
    // Whether the application's code ran: a refusal before it — the session, a reused id — wrote
    // nothing, and is answered at once.
    const code: { ran: boolean } = { ran: false };
    const running = (...args: readonly unknown[]): unknown => {
      code.ran = true;
      return (operation as (...args: readonly unknown[]) => unknown)(...args);
    };
    let receipt: OperationReceipt | undefined;
    try {
      receipt = await this.#run(async () => runOperation(this.#core, sessionId, call, running));
      return receipt;
    } finally {
      // An answer again by its id reads it too: the first may not have read it yet, or was lost.
      if ((code.ran || receipt?.deduplicated === true) && this.#external) {
        // The operation may have written an external table by the application's own SQL, though
        // it failed after: the page its answer renders again reads after the log told of it.
        await readAfterOperation(this.#tail);
      }
    }
  }

  /**
   * The root a subscription follows, rendered for the session that presents it, for its event
   * stream: what it shows, and what a commit must change for it to show anything else.
   */
  async watch(sessionId: unknown, subscription: unknown): Promise<Watched> {
    return this.#run(async () => {
      const session = this.#session(sessionId);
      const claims = verifySubscription(this.#secret, subscription, {
        build: this.#registry.buildId,
        session: session.id,
      });
      const view = await viewOf(this.#core, session, claims.root, {
        bindings: false,
        view: claims.view,
      });
      if (view.status === 'unauthenticated') {
        throw signInFirst();
      }
      const ended = endedResource(session);
      const { dependencies } = view;
      return {
        dependsOn: (event) =>
          event.changed.includes(ended) || dependencies?.changedBy(event.rows) === true,
        digest: view.digest,
        issued: claims.digest,
        revision: view.revision,
      };
    });
  }

  /**
   * A record's public fields, rendered by the authority, from its cache while the record is as it
   * was read. A table that declares no public field has none to show, and is not found.
   */
  async publicSnapshot(table: unknown, id: unknown): Promise<PublicSnapshot> {
    const definition = typeof table === 'string' ? this.#definition.tables.get(table) : undefined;
    if (typeof table !== 'string' || definition === undefined || definition.public.length === 0) {
      throw refusal(HTTP_NOT_FOUND, 'NOT_FOUND', 'There is no such public table.');
    }
    assertId(id);
    return this.#run(() => this.#public.snapshot(table, id));
  }

  /**
   * Whether what was rendered from `dependencies` may still be published: a renderer that read
   * before a commit publishes under this fence, not under a wall clock.
   */
  async publishIfCurrent(dependencies: Readonly<Record<string, number>>): Promise<boolean> {
    return this.#run(() => this.#public.current(dependencies));
  }

  /**
   * The change log after `since`, each change saying which of its records a page without a session
   * may show (`published`): those of the tables the declaration gives public fields.
   */
  async changes(since = 0): Promise<readonly ChangeEvent[]> {
    return this.#run(() => {
      return this.#db.changes(since).map((change) => {
        const published = change.changed.filter((resource) => this.#publishes(resource));
        return { ...change, published };
      });
    });
  }

  /** Advances a consumer's delivery cursor; it never moves back, nor past the last revision. */
  async acknowledge(consumer: unknown, revision: unknown): Promise<void> {
    await this.#run(() => {
      if (
        typeof consumer !== 'string' ||
        consumer === '' ||
        typeof revision !== 'number' ||
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        revision > this.#db.revision()
      ) {
        throw refusal(HTTP_BAD_REQUEST, 'INVALID_REVISION', 'The revision is not valid.');
      }
      // The cursor and the changes it lets go of, together.
      this.#db.transaction(() => {
        this.#db.acknowledge(consumer, revision);
      });
    });
  }

  async delivery(consumer: unknown): Promise<number> {
    // A consumer without a name could never acknowledge, and would hold the log back for good.
    if (typeof consumer !== 'string' || consumer === '') {
      throw refusal(HTTP_BAD_REQUEST, 'INVALID_CONSUMER', 'Name the consumer.');
    }
    return this.#run(() => this.#db.delivery(consumer));
  }

  async stats(): Promise<Stats> {
    return this.#run(() => {
      return {
        ...this.#metrics,
        buildId: this.#registry.buildId,
        cacheEntries: this.#public.size,
        evaluationsByComponent: Object.fromEntries(
          [...this.#evaluatedBy].toSorted(([a], [b]) => (a < b ? -1 : Number(a > b))),
        ),
        memoEntries: this.#memo.size,
        operations: this.#db.operationCount(),
        revision: this.#db.revision(),
        sharedStreams: this.#shared.streams,
        sharedViews: this.#shared.size,
      };
    });
  }

  async close(): Promise<void> {
    // What the shared views have under way — a request of the site above all — is let go of first,
    // and what is queued then is let finish: nothing of either outlives the authority. No store's
    // log is read after.
    this.#tail.stop();
    await this.#shared.stop();
    await this.#queue;
    this.#closed = true;
    this.#db.close();
    this.#listeners.clear();
  }
}
