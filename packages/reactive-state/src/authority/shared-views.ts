import type { Json, RenderResult } from '../program.ts';
import {
  type GateAnswer,
  type GateRequest,
  GENERATION_HEADER,
  type RouteParams,
  type RouteRegistration,
  type SharedRenderAnswer,
  type SharedRenderRequest,
  type SiteShape,
} from '../routing.ts';
import { routePathOf, sitePathOf } from '../site-paths.ts';
import { HTTP_CONFLICT, HTTP_FORBIDDEN, HTTP_NOT_FOUND } from '../status.ts';
import { type ArtifactFit, fitOf, REMAKING } from './artifact-deployments.ts';
import { digest } from './canonical.ts';
import { Dependencies, type RowChange } from './dependencies.ts';
import { refusal } from './errors.ts';
import {
  artifactAnswer,
  decidedBy,
  forbiddenAnswer,
  GENERATION_PASS,
  PASS,
  profileOf,
  representationOf,
  respondedAnswer,
  unavailableAnswer,
} from './gate-answers.ts';
import type { Core, Session } from './model.ts';
import { paramsOfPath, rootPropsOf, viewParamsOf } from './route-registry.ts';
import {
  type Entry,
  dirtyViewKeys,
  forbiddenResult,
  missedOf,
  storedOf,
  viewInfo,
  retainedView,
  WAIT,
  type Wait,
  type Waiting,
} from './shared-entry.ts';
import { assertFollowerRoom, type SharedFollowing, sharedFollowing } from './shared-following.ts';
import { bytesOf, pagePathOf } from './shared-generate.ts';
import { SharedJobs, type SharedJobsHost } from './shared-jobs.ts';
import { type SharedOutcome, sharedOutcome } from './shared-render.ts';
import type { SharedStore } from './shared-store.ts';
import { SiteShapes } from './site-shapes.ts';
import { generationOf, verifyView } from './view-tokens.ts';

/** The origin a question's URL — a path and a query — is read against, of no site's own. */
const GATE_ORIGIN = 'https://gate.invalid';

/**
 * The shared views of the application's routes: each route's document as every visitor is
 * answered with it, for each set of params a request named — kept from the first request on, with
 * what its guards and root read, followed by every commit, and made again behind it without anybody
 * asking (`SharedJobs`).
 *
 * A view is `ready` — its generation's artifacts published, nothing it read changed since — or not:
 * `dirty`, a commit changed what it read and it is to be evaluated again; `pending`, evaluated to
 * something else than it shows, its next generation's artifacts being made; `denied`, its guards or
 * root refused; `responded`, a guard answered a response itself; `private`, its render is the
 * request's. A commit marks the views it makes dirty in its own transaction, so a request that
 * reaches the gate after the commit was answered never meets the old artifact: the gate holds it
 * until the view settles, and answers 503 if it does not in time.
 */

export interface SharedViewsHost extends SharedJobsHost {
  /** The longest the gate holds a request for a view that is settling. */
  readonly gateWaitMs?: number | undefined;
  /**
   * The route's root of `props`, rendered for the request's session — or for none — as any root is
   * rendered (`viewOf`): its route's guards first, of the params the props give them (`guardedBy`).
   */
  readonly renderSession: (
    route: RouteRegistration,
    props: Readonly<Record<string, Json>>,
    session: Session | undefined,
    admission?: string,
  ) => Promise<RenderResult>;
}

/** Longest a gate holds a request for a view that is settling. */
const GATE_WAIT_MS = 10_000;
/**
 * The most views kept: past it, the one asked for longest ago is let go of, of those nothing is
 * under way for and no page follows (`#held`); and while every one is held so, no other view is
 * taken in.
 */
export const MAX_VIEWS = 1000;
/** The status a view is refused with while there is no room for it: ask again shortly. */
const HTTP_UNAVAILABLE = 503;
/**
 * How long a view nobody asks for is kept after it was last asked for: for as long as a page
 * follows it, besides.
 */
const RETENTION_MS = 86_400_000;
/** How often the views nobody asked for in `RETENTION_MS` are looked for. */
const SWEEP_MS = 60_000;

export class SharedViews {
  readonly #host: SharedViewsHost;
  readonly #core: Core;
  readonly #store: SharedStore;
  readonly #entries = new Map<string, Entry>();
  readonly #jobs: SharedJobs;
  #swept = 0;
  /** Where the site serves its routes: the build's, and each deployment's. */
  readonly #sites: SiteShapes;

  constructor(host: SharedViewsHost) {
    this.#host = host;
    this.#core = host.core;
    this.#store = host.store;
    this.#sites = new SiteShapes(host.store, host.core.registry.buildId);
    this.#jobs = new SharedJobs(host, {
      current: (entry) => this.#entries.get(entry.key) === entry,
      evaluate: (entry) => this.#evaluate(entry),
      privatize: (entry, reason) => {
        this.#jobs.apply(entry, { kind: 'private', reason });
        this.#persist(entry);
      },
      publish: (entry, candidate, artifacts) => {
        this.#jobs.publish(entry, candidate, artifacts);
        this.#persist(entry);
      },
      sitePath: (entry) =>
        sitePathOf(this.#sites.orBuild(entry.site), pagePathOf(entry.route.route, entry.params)),
    });
  }

  /** The params of `route` a request's URL names, as a site of `site` serves it; none otherwise. */
  #paramsOf(route: RouteRegistration, url: string, site: SiteShape): RouteParams | undefined {
    const pathname = new URL(url, GATE_ORIGIN).pathname;
    const path = routePathOf(site, pathname);
    return path === undefined ? undefined : paramsOfPath(route.route, path);
  }

  async #rendered(
    entry: Entry,
    session: Session | undefined,
    admission?: string,
  ): Promise<SharedRenderAnswer> {
    if (entry.status === 'private') {
      const props = rootPropsOf(entry.route, entry.params);
      return {
        kind: 'session',
        result: await this.#host.renderSession(entry.route, props, session, admission),
      };
    }
    const shown = entry.status === 'pending' ? entry.candidate : entry.published;
    const view = viewInfo(this.#host.secret, this.#core.registry.buildId, entry);
    if (shown === undefined || entry.status === 'denied' || entry.status === 'responded') {
      return { kind: 'shared', result: forbiddenResult(this.#core, entry), view };
    }
    // A page shows it from now on, published or not — a candidate a prefetch let through to the
    // page among them: revoked as a published view is, should it be shown no more, and whatever is
    // published next numbered past it — kept, for a restarted authority to number past it too.
    entry.exposed = true;
    if (shown.generation > (entry.handed ?? 0)) {
      entry.handed = shown.generation;
      this.#persist(entry);
    }
    return {
      kind: 'shared',
      result: shown.result,
      view: viewInfo(this.#host.secret, this.#core.registry.buildId, entry, shown),
    };
  }

  /** The render a generation token asks for, where the token is of this view's; none otherwise. */
  #generationRender(key: string, token: string): SharedRenderAnswer | undefined {
    const claims = generationOf(this.#host.secret, token, this.#core.clock());
    if (claims?.view !== key) {
      return undefined;
    }
    const entry = this.#entries.get(key);
    const rendering = entry && this.#jobs.rendering(entry, claims);
    if (entry === undefined || rendering === undefined) {
      throw refusal(HTTP_CONFLICT, 'GENERATION_GONE', 'The generation asked for is gone.');
    }
    this.#jobs.asks.rendered(token);
    return {
      kind: 'shared',
      result: rendering.result,
      view: viewInfo(this.#host.secret, this.#core.registry.buildId, entry, rendering),
    };
  }

  /**
   * In the queue: what the gate answers of a view whose artifact is to be made (`fit`) — to wait for
   * it, its making started — or, while the authority knows no site to make it of, the 503 at once:
   * nothing would make it in time, and each job, ended as it starts, would wake the request only for
   * its next decision to start another. One to be made again for the request's deployment in place
   * of another's (`remake`) lets the request through to its page instead, made or not; and one the
   * artifact kept is not to answer (`pass`), at once.
   */
  #toMake(request: GateRequest, fit: ArtifactFit, make: () => void): GateAnswer | Wait {
    if (fit === 'pass' || this.#host.site() === undefined) {
      return fit === 'make' ? unavailableAnswer(request) : PASS;
    }
    make();
    return fit === 'remake' ? REMAKING : WAIT;
  }

  /** In the queue: what the gate answers of `entry` now, or to wait for it to settle. */
  #decide(entry: Entry, profile: 'document' | 'rsc', request: GateRequest): GateAnswer | Wait {
    switch (entry.status) {
      case 'private': {
        return PASS;
      }
      case 'denied': {
        return decidedBy(forbiddenAnswer(request), entry.by, true);
      }
      case 'responded': {
        return entry.response === undefined
          ? forbiddenAnswer(request)
          : decidedBy(respondedAnswer(entry.response, request), entry.by, false);
      }
      case 'ready': {
        // Of the request's deployment alone (`fitOf`): another's is made again for it, or passed.
        // One payload (`rsc`) answers the router's request whatever tree (`Next-Router-State-Tree`)
        // and query it carries: made of the route's bare path with `RSC: 1` alone, it is Next.js's
        // render from the root (`walkTreeWithFlightRouterState`), the whole payload it answers a
        // request of no tree with, as its own prerendered pages are served, which its router applies
        // from the root down (`decodeTransportNode`, `writeDynamicDataIntoNavigationTask`). Of the
        // request's URL it holds the query it was rendered with alone (`q`), none, which costs a
        // predicted navigation with a query one soft retry of the router's own and no request.
        const artifact = this.#store.artifact(entry.key, entry.generation, profile);
        const fit = fitOf(artifact, request, this.#core.clock());
        if (fit !== 'answer' || artifact === undefined) {
          return this.#toMake(request, fit, () => {
            this.#jobs.makeProfile(entry, profile);
          });
        }
        this.#core.metrics.artifactReads += 1;
        this.#core.metrics.artifactBytes += bytesOf(artifact.body);
        return artifactAnswer(artifact, request);
      }
      case 'pending': {
        return this.#toMake(request, 'make', () => {
          this.#jobs.kick(entry);
        });
      }
      case 'dirty':
      case 'new': {
        this.#jobs.kick(entry);
        return WAIT;
      }
    }
  }

  /**
   * In the queue: a prefetch or another path spelling, answered without an artifact once settled.
   * Only a prefetch asks for artifacts to be made as well (`generate`). A prefetch is the page's to
   * answer — what the build prerendered of it, or a render the view gates
   * itself — once the view is known to be shown: never of a view the authority refused, nor of one a
   * write may have refused since, which it waits for as a document does.
   */
  #decidePrefetch(entry: Entry, request: GateRequest, generate = true): GateAnswer | Wait {
    switch (entry.status) {
      case 'denied':
      case 'responded': {
        return this.#decide(entry, 'document', request);
      }
      case 'dirty':
      case 'new': {
        if (generate) {
          this.#jobs.kick(entry);
        } else {
          this.#jobs.evaluate(entry);
        }
        return WAIT;
      }
      case 'pending':
      case 'private':
      case 'ready': {
        return PASS;
      }
    }
  }

  /**
   * In the queue: the gate's decision `answer`, waited for where it is to wait — the request's
   * waiter installed with the decision, before the queue is let go of: a view that moves once it is,
   * before the request hears it is to wait, wakes it all the same, never leaving it to the deadline.
   */
  #waiting(answer: GateAnswer | Wait, key: string, deadline: number): GateAnswer | Waiting {
    return answer.kind === 'wait'
      ? { ...answer, woken: this.#jobs.waitFor(key, deadline) }
      : answer;
  }

  #routeOf(name: string): RouteRegistration {
    const route = this.#core.routes.routes.get(name);
    if (route === undefined) {
      throw refusal(HTTP_NOT_FOUND, 'UNKNOWN_ROUTE', 'There is no such route.');
    }
    return route;
  }

  /**
   * The view of `key`, kept from now on, asked for now; none where the views kept are as many as
   * they may be and each is held (`#held`): something under way, which none is let go of in the
   * middle of, or a page following it.
   */
  #observe(key: string, route: RouteRegistration, params: RouteParams): Entry | undefined {
    const now = this.#core.clock();
    this.#sweep(now);
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      if (!this.#makeRoom()) {
        return undefined;
      }
      entry = {
        dependencies: new Dependencies(),
        digest: '',
        epoch: this.#store.nextEpoch(),
        generation: 0,
        key,
        observed: now,
        // Kept with the view, once it is evaluated (`#persist`).
        observedKept: now,
        params,
        revision: 0,
        route,
        status: 'new',
      };
      this.#entries.set(key, entry);
    }
    entry.observed = now;
    // Kept now and then — once in a sweep's span at most — for a restarted authority to let go of
    // no view still asked for, with no write for each request.
    if (now - (entry.observedKept ?? 0) >= SWEEP_MS) {
      this.#store.observe(key, now);
      entry.observedKept = now;
    }
    return entry;
  }

  /** The view of `key`, as `#observe` answers it: refused where there is no room for it. */
  #admit(key: string, route: RouteRegistration, params: RouteParams): Entry {
    const entry = this.#observe(key, route, params);
    if (entry === undefined) {
      throw refusal(
        HTTP_UNAVAILABLE,
        'TOO_MANY_VIEWS',
        'Every view the authority keeps is being made or followed: ask again shortly.',
      );
    }
    return entry;
  }

  /**
   * Whether the view of `key` is not to be let go of: something is under way for it, or a page
   * follows it — whose stream, once its view was let go of, no commit would mark nor withdrawal
   * reach, leaving the page what it shows for good.
   */
  #held(key: string): boolean {
    return this.#jobs.busy(key) || this.#jobs.followed(key);
  }

  /**
   * Room for one more view: where the views kept are as many as they may be, the one asked for
   * longest ago is let go of, of those not held (`#held`). Whether there is room.
   */
  #makeRoom(): boolean {
    if (this.#entries.size < MAX_VIEWS) {
      return true;
    }
    let oldest: Entry | undefined;
    for (const entry of this.#entries.values()) {
      if (!this.#held(entry.key) && (oldest === undefined || entry.observed < oldest.observed)) {
        oldest = entry;
      }
    }
    if (oldest === undefined) {
      return false;
    }
    this.#drop(oldest);
    return true;
  }

  /**
   * Lets go of the views nobody asked for in `RETENTION_MS`, but those held (`#held`), at most once
   * in `SWEEP_MS`.
   */
  #sweep(now: number): void {
    if (now - this.#swept < SWEEP_MS) {
      return;
    }
    this.#swept = now;
    for (const entry of this.#entries.values()) {
      if (now - entry.observed > RETENTION_MS && !this.#held(entry.key)) {
        this.#drop(entry);
      }
    }
  }

  #drop(entry: Entry): void {
    this.#entries.delete(entry.key);
    this.#store.drop(entry.key);
    this.#jobs.dropped(entry);
    this.#jobs.wake(entry.key);
  }

  /** In the queue: `entry` evaluated at the revision the queue holds, and what follows of it. */
  async #evaluate(entry: Entry): Promise<void> {
    let outcome: SharedOutcome;
    try {
      outcome = await sharedOutcome(this.#core, entry.route, entry.params);
    } catch (error) {
      // A fault of the application's code: nothing is decided, the requests the gate holds for the
      // view answer 503 at once, never evaluating it again themselves — the next request, or
      // commit, does — and what a commit may have withdrawn of it is revoked (`faulted`).
      this.#jobs.faulted(entry);
      this.#persist(entry);
      throw error;
    }
    try {
      this.#jobs.apply(entry, outcome);
      this.#persist(entry);
    } catch (error) {
      // A fault of the store's, as what was decided is kept — the view's row, or the epoch of its
      // revocation: the requests the gate holds for the view answer 503 at once (`fault`), as for a
      // fault of the application's code, and a later request, or a commit, tries again — never one
      // of them left to wait out its deadline.
      this.#jobs.fault(entry.key);
      throw error;
    }
    this.#jobs.wake(entry.key);
  }

  #persist(entry: Entry): void {
    if (this.#entries.get(entry.key) === entry) {
      this.#store.put(storedOf(this.#core.registry.buildId, entry), entry.withdrawn === true);
      entry.observedKept = entry.observed;
      entry.withdrawn = undefined;
    }
  }

  /**
   * The views a store kept, each to be evaluated again before it is answered with — as it is next
   * asked for or followed, not as the authority starts: a restart would otherwise render every view
   * kept, and ask the site for each one's page twice, at the same moment. What pages hold of one
   * is not known, and is revoked as a published view is, should it be shown no more (`exposed`).
   * Where the build's site serves its routes is as its pages said before (`SiteShapes.learn`).
   */
  load(): void {
    this.#sites.load();
    for (const view of this.#store.views(this.#core.registry.buildId)) {
      const route = this.#core.routes.routes.get(view.route);
      if (route === undefined) {
        this.#store.drop(view.key);
        continue;
      }
      this.#entries.set(view.key, {
        dependencies: Dependencies.of(view.dependencies),
        digest: view.digest,
        epoch: view.epoch,
        exposed: true,
        generation: view.generation,
        handed: view.generation,
        key: view.key,
        observed: view.observed,
        observedKept: view.observed,
        params: view.params,
        revision: view.revision,
        route,
        stale: view.status === 'dirty',
        status: view.status === 'private' ? 'private' : 'dirty',
      });
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Whether a retained view reads one of `tables`: an expired view held by no page or job no
   * longer keeps a store's log followed. The next request sweeps it in the engine's queue.
   */
  retains(tables: ReadonlySet<string>): boolean {
    return retainedView(this.#entries.values(), tables, {
      since: this.#core.clock() - RETENTION_MS,
      held: (key) => this.#held(key),
    });
  }

  get streams(): number {
    return this.#jobs.streams;
  }

  keyOf(route: string, params: RouteParams): string {
    return digest(['view', this.#core.registry.buildId, route, params]);
  }

  /**
   * In the transaction of a commit of `rows`: the views whose reads the rows change, marked dirty
   * in the transaction. `committed` takes them in once it landed. A view kept before the authority
   * started is held to what it read as it was kept until it is decided again — dirty, and no commit
   * having changed it since (`stale`) — or a fault of its evaluation would leave its pages what the
   * commit withdrew (`SharedJobs.faulted`).
   */
  dirtyBy(rows: readonly RowChange[]): readonly string[] {
    const keys = dirtyViewKeys(this.#entries.values(), rows);
    this.#store.markDirty(keys);
    return keys;
  }

  /**
   * After a commit landed: the views it made dirty, to be evaluated again behind it — what pages
   * show of each undecided until then (`stale`).
   */
  committed(keys: readonly string[]): void {
    const now = this.#core.clock();
    for (const key of keys) {
      const entry = this.#entries.get(key);
      if (entry === undefined) {
        continue;
      }
      if (now - entry.observed > RETENTION_MS && !this.#held(key)) {
        this.#drop(entry);
        continue;
      }
      Object.assign(entry, { candidate: undefined, stale: true, status: 'dirty' });
      this.#jobs.schedule(entry);
    }
  }

  /**
   * In the queue: the route's root as the page renders it — the generation the authority asked the
   * page for, where the request carries its token; otherwise the view as it stands, evaluated first
   * where it is not settled; or the session's render of the root, of the props the page gave it,
   * for a view that is the request's and for props that are no view's (`viewParamsOf`) — another
   * page's render of the root — in the same round trip. A token that is no generation of the view's
   * the authority is making is refused: only the authority's own request for an artifact carries
   * one, so whatever else claims to be one is not — one with props that are no view's among them,
   * as the authority asks for no page of such props.
   */
  async render(
    request: SharedRenderRequest,
    session: Session | undefined,
  ): Promise<SharedRenderAnswer> {
    this.#core.metrics.nextRenders += 1;
    this.#sites.learn(request.site);
    const route = this.#routeOf(request.route);
    const params = route.shared ? viewParamsOf(route, request.props) : undefined;
    if (request.generation !== undefined) {
      const answer =
        params === undefined
          ? undefined
          : this.#generationRender(this.keyOf(route.route, params), request.generation);
      if (answer === undefined) {
        throw refusal(HTTP_FORBIDDEN, 'NOT_A_GENERATION', 'The request names no generation.');
      }
      return answer;
    }
    if (params === undefined) {
      // A route the compile found the request's, or props that are no view's — another page's
      // render of the root, with props of its own: the root rendered for the session, as any root
      // is, with the props the page gave it — never one view for all.
      return {
        kind: 'session',
        result: await this.#host.renderSession(route, request.props, session, request.admission),
      };
    }
    const key = this.keyOf(route.route, params);
    const entry = this.#admit(key, route, params);
    entry.site = request.site ?? entry.site;
    if (entry.status === 'dirty' || entry.status === 'new') {
      await this.#evaluate(entry);
      this.#jobs.kick(entry);
    }
    return this.#rendered(entry, session, request.admission);
  }

  /**
   * A request for a route's page, as its gate decides it: the artifact of the view's generation (or
   * a 304), the generic 403, a 503 where the view did not settle in time, there is no room for it or
   * no site to make its artifact of; or `pass`, for a request the view is not to answer — a
   * generation's own, a prefetch, a view that is the request's.
   */
  async gate(request: GateRequest): Promise<GateAnswer> {
    this.#core.metrics.gateLookups += 1;
    await this.#sites.heed(request, async (body) => this.#host.run(body));
    const said = this.#sites.said(request);
    const site = this.#sites.orBuild(said);
    const route = this.#core.routes.routes.get(request.route);
    const params = route === undefined ? undefined : this.#paramsOf(route, request.url, site);
    if (route === undefined || params === undefined || !route.shared) {
      return PASS;
    }
    // Artifacts answer the spelling the site rendered (`usePathname()`), while the view's
    // authorization decides every spelling of its route and params before another passes.
    const spelled = new URL(sitePathOf(site, pagePathOf(route.route, params)), GATE_ORIGIN);
    const artifactPath = new URL(request.url, GATE_ORIGIN).pathname === spelled.pathname;
    const key = this.keyOf(route.route, params);
    const generation = request.headers[GENERATION_HEADER];
    if (generation !== undefined && this.#jobs.asks.passes(generation, key, this.#core.clock())) {
      return GENERATION_PASS;
    }
    const profile = profileOf(representationOf(request));
    const deadline = this.#core.clock() + (this.#host.gateWaitMs ?? GATE_WAIT_MS);
    const decide = (): GateAnswer | Waiting => {
      const entry = this.#observe(key, route, params);
      if (entry === undefined) {
        // No room for the view: undecided, and answered as a view that does not settle in time is.
        return unavailableAnswer(request);
      }
      // Its artifacts asked for where the site of the request's deployment serves its page, where
      // something said where that is: the build's site stands in for it otherwise, as the job starts.
      entry.site = said ?? entry.site;
      return this.#waiting(
        profile === undefined || !artifactPath
          ? this.#decidePrefetch(entry, request, artifactPath)
          : this.#decide(entry, profile, request),
        key,
        deadline,
      );
    };
    for (;;) {
      const answer = await this.#host.run(decide);
      if (answer.kind !== 'wait') {
        return answer;
      }
      this.#core.metrics.gateWaits += 1;
      if (!(await answer.woken)) {
        return answer.failed ?? unavailableAnswer(request);
      }
    }
  }

  /**
   * Where the site serves its routes, as the host that told the authority its site says (`site`) —
   * from the build it serves, which the edge's question says nothing of: held from now on, in
   * place of what was learned before, and learned again of whatever says otherwise after it.
   */
  told(site: SiteShape): void {
    this.#sites.told(site);
  }

  /** Stops keeping views current, as the authority closes: resolves once nothing is under way. */
  async stop(): Promise<void> {
    await this.#jobs.stop();
  }

  /** A stream token's signature, build and registered route, without touching its view. */
  check(token: unknown): void {
    const claims = verifyView(this.#host.secret, token, this.#core.registry.buildId);
    this.#routeOf(claims.route);
  }

  /**
   * In the queue: a shared view's event stream's start — the events the page that holds `token` has
   * missed — and its following from then on, which holds each event of the view's from the moment
   * the missed ones are reckoned, in the queue, until it is listened to: none falls between the two.
   * Whoever follows a view listens or stops (`SharedFollowing`). The view is moved on as a request
   * of it is (`SharedJobs.kick`): evaluated where it is not settled, and its pending generation made
   * — one given up while no page followed it, which no backoff tries again (`SharedJobs.#backoff`),
   * and which nothing else would make, nor tell the page of, before a request asked for the view.
   */
  follow(token: unknown): SharedFollowing {
    const claims = verifyView(this.#host.secret, token, this.#core.registry.buildId);
    const route = this.#routeOf(claims.route);
    assertFollowerRoom(this.#jobs.streams, MAX_VIEWS);
    const entry = this.#admit(this.keyOf(route.route, claims.params), route, claims.params);
    const following = sharedFollowing(this.#jobs, entry.key, claims, missedOf(entry, claims));
    this.#jobs.kick(entry);
    return following;
  }
}

export { type Entry } from './shared-entry.ts';
export type { SharedFollowing } from './shared-following.ts';
