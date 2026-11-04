import type { RenderResult } from '../program.ts';
import type { SharedEvent } from '../routing.ts';
import { ArtifactAsks } from './artifact-asks.ts';
import { digest } from './canonical.ts';
import { Dependencies } from './dependencies.ts';
import { describeThrown } from './errors.ts';
import { etagOf } from './gate-answers.ts';
import type { Core } from './model.ts';
import type { Candidate, Entry, Rendering } from './shared-entry.ts';
import {
  fetchArtifact,
  type GeneratedArtifact,
  type SiteFetch,
  UnsharedPageError,
} from './shared-generate.ts';
import type { SharedOutcome } from './shared-render.ts';
import type { SharedStore } from './shared-store.ts';
import { ViewFollowers } from './view-followers.ts';
import { ViewRetries } from './view-retries.ts';
import {
  type GenerationClaims,
  type Profile,
  signGeneration,
  type ViewClaims,
} from './view-tokens.ts';

/**
 * What happens to shared views behind the requests that ask for them: a view a commit made dirty
 * evaluated again — once for however many commits land within `SETTLE_MS`, and once more for those
 * that land while it is evaluated or its artifacts made — the artifacts of a generation made one at a
 * time for each view, by asking the site for the page; the requests the gate holds woken as a view
 * moves; and each event stream of a view told of what it moved to. Nothing here holds the engine's
 * queue but what reads or changes a view, which `run` puts in it.
 */

export interface SharedJobsHost {
  readonly core: Core;
  readonly store: SharedStore;
  readonly secret: string;
  /** Runs `body` in the engine's queue. */
  readonly run: <T>(body: () => Promise<T> | T) => Promise<T>;
  /** How the authority asks its site for a page; none while it knows no site. */
  readonly site: () => SiteFetch | undefined;
}

interface Callbacks {
  /**
   * Whether `entry` is the view its key holds now: one let go of (`SharedViews.#drop`) is not, and
   * neither is it once another is taken in under its key — nothing of it is evaluated, made, or told
   * of after then, which would be told the other's pages and kept under the other's key.
   */
  readonly current: (entry: Entry) => boolean;
  /** In the queue: `entry` evaluated, and what follows of it applied. */
  readonly evaluate: (entry: Entry) => Promise<void>;
  /** In the queue: `entry` made the request's, for `reason`, as an evaluation that finds it so does. */
  readonly privatize: (entry: Entry, reason: string) => void;
  /** In the queue: `candidate`'s artifacts published, where it is still the view's candidate. */
  readonly publish: (
    entry: Entry,
    candidate: Candidate,
    artifacts: readonly GeneratedArtifact[],
  ) => void;
  /**
   * The path the site serves the page of `entry` at — under its base path, in its own form — as the
   * view was last asked for (`Entry.site`).
   */
  readonly sitePath: (entry: Entry) => string;
}

/** One profile of a generation's artifact, as the site is asked for it. */
interface ArtifactAsked {
  readonly entry: Entry;
  readonly generation: number;
  readonly profile: Profile;
  readonly path: string;
}

/** How long a view waits for more commits before it is evaluated again. */
const SETTLE_MS = 10;
/** How long a generation's token lets its request through. */
const TOKEN_TTL_MS = 60_000;
/**
 * How often an artifact is asked for before the generation is given up, and the first wait between
 * two attempts; none after the last.
 */
const ATTEMPTS = 3;
const RETRY_MS = 200;
/**
 * How long a followed view whose evaluation faulted — or the making of its pending generation's
 * artifacts — waits before it is tried again, the first time, twice as long each time after, and
 * the longest: a fault that passes republishes it on its own.
 */
const FAULT_RETRY_MS = 1000;
const MAX_FAULT_RETRY_MS = 60_000;
/** The artifacts of a generation, in the order they are made. */
const PROFILES: readonly Profile[] = ['document', 'rsc'];

/** Waits `milliseconds`, or until `signal` aborts, as the authority closes: no timer left behind. */
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

export class SharedJobs {
  readonly #host: SharedJobsHost;
  readonly #callbacks: Callbacks;
  /** Whether a scheduled evaluation also makes the artifacts of its pending generation. */
  readonly #scheduled = new Map<string, boolean>();
  /** The evaluations scheduled, each until it runs or the authority closes. */
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  /**
   * The followed views to be tried again behind a fault's backoff (`faulted`): apart from what is
   * scheduled, which a request's own evaluation is never held behind, and let go of with their views
   * (`dropped`).
   */
  readonly #retries = new ViewRetries();
  /** Whether the authority closed: nothing more is evaluated or made, and no failure said of it. */
  #stopped = false;
  /** Aborted as the authority closes: each request of the site under way, and each wait between. */
  readonly #closing = new AbortController();
  readonly #making = new Map<string, Promise<void>>();
  /** The requests the gate holds for each view, each let go of with whether the view moved. */
  readonly #waiters = new Map<string, Set<(moved: boolean) => void>>();
  /** The pages that follow each view, and the newest generation each knows of. */
  readonly #followers = new ViewFollowers();
  /**
   * The generation token of each request for an artifact under way, and whether a page rendered with
   * it: a page that renders once its request was given up — past its deadline — notes nothing.
   */
  readonly asks: ArtifactAsks;

  constructor(host: SharedJobsHost, callbacks: Callbacks) {
    this.#host = host;
    this.#callbacks = callbacks;
    this.asks = new ArtifactAsks(host.secret);
  }

  /**
   * Evaluates `entry` in the queue where it is still the view its key holds and is not settled, and
   * makes its candidate's artifacts after: a view let go of while its evaluation waited in the queue
   * — nothing held it then — is evaluated no more.
   */
  async #settle(entry: Entry, generate: boolean): Promise<void> {
    try {
      await this.#host.run(async () => {
        const unsettled = entry.status === 'dirty' || entry.status === 'new';
        if (unsettled && this.#callbacks.current(entry)) {
          await this.#callbacks.evaluate(entry);
        }
      });
    } catch (error) {
      if (!this.#stopped) {
        // eslint-disable-next-line no-console
        console.error(
          `A shared view of ${entry.route.route} failed to render: ${describeThrown(error)}`,
        );
      }
      return;
    }
    if (generate && entry.status === 'pending' && entry.candidate !== undefined) {
      this.#make(entry, entry.candidate);
    }
  }

  /**
   * A view pages may show — its generation published, or shown before it was (`exposed`) — which is
   * shown no more — refused, answered by a guard's response in its place, or found to be the
   * request's — ends what its pages held: a new epoch of the database's (`nextEpoch`), which no
   * artifact or token of the earlier one is of, and its streams told it is denied, for its pages to
   * hide it and ask for the route again. Once: a view already shown no more is evaluated again with
   * nothing told. Whatever artifacts the store holds of it, of this authority's or kept before it
   * started, are let go of as it is kept next (`Entry.withdrawn`): each time, which costs nothing.
   */
  #revoke(entry: Entry): void {
    entry.withdrawn = true;
    if (entry.published !== undefined || entry.exposed === true) {
      entry.epoch = this.#host.store.nextEpoch();
      entry.exposed = false;
      this.notify(entry.key, { epoch: entry.epoch, kind: 'denied' });
    }
  }

  #deny(entry: Entry, outcome: Extract<SharedOutcome, { kind: 'denied' }>): void {
    this.#revoke(entry);
    Object.assign(entry, {
      by: outcome.by,
      candidate: undefined,
      dependencies: outcome.dependencies,
      digest: 'denied',
      published: undefined,
      revision: outcome.revision,
      status: 'denied',
    });
  }

  #evaluated(entry: Entry, outcome: Extract<SharedOutcome, { kind: 'rendered' }>): void {
    const { dependencies, frame, root, view } = outcome;
    const result: RenderResult = { frame, status: 'rendered', tree: view.assembly.tree };
    const handed = entry.handed ?? 0;
    if (entry.generation > 0 && view.digest === entry.digest && handed <= entry.generation) {
      // What it showed, read anew, where no page holds a later generation it would keep over this
      // one: the same generation, now held to what it read this time — told each page that follows
      // it and knows of an older one alone, as one that followed it while it was dirty may.
      Object.assign(entry, {
        candidate: undefined,
        dependencies,
        published: { generation: entry.generation, result, root },
        revision: view.revision,
        status: 'ready',
      });
      this.#followers.restored(entry.key, {
        epoch: entry.epoch,
        generation: entry.generation,
        kind: 'ready',
      });
      return;
    }
    entry.candidate = {
      dependencies,
      digest: view.digest,
      // Past whatever a page holds of the view, published or not — even where it shows what was
      // published: every page takes it for newer, and no token or ETag of the view's is reused.
      generation: Math.max(entry.generation, handed) + 1,
      result,
      revision: view.revision,
      root,
    };
    entry.status = 'pending';
  }

  /**
   * Makes `candidate`'s artifacts, one view at a time, and publishes them where it still stands: of
   * the page where the site serves it as the job starts (`sitePath`), both of them.
   */
  #make(entry: Entry, candidate: Candidate): void {
    this.#start(entry, candidate, async () => {
      const path = this.#callbacks.sitePath(entry);
      const artifacts: GeneratedArtifact[] = [];
      for (const profile of PROFILES) {
        const artifact = await this.#artifact(
          { entry, generation: candidate.generation, path, profile },
          () => entry.candidate === candidate,
        );
        if (artifact === undefined) {
          return;
        }
        artifacts.push(artifact);
      }
      await this.#host.run(() => {
        this.#callbacks.publish(entry, candidate, artifacts);
      });
    });
  }

  /**
   * Runs `job` for the view of `entry`, unless one runs for it already; and once it ends, makes the
   * candidate the view holds then, where the job was not making it (`making`). A commit that
   * outran what the job was making has the view evaluated again while the job still runs, and the
   * new candidate's artifacts are not started beside it: nothing else would make them before a
   * request asked for the view, and a view nobody asks for would be left pending, its streams told
   * of nothing. Where the job faulted making the candidate the view still holds, the view is tried
   * again behind a backoff while a page follows it (`#backoff`): its pages hear of nothing else
   * until the generation is made.
   */
  #start(entry: Entry, making: Candidate | undefined, job: () => Promise<void>): void {
    const { key } = entry;
    if (this.#stopped || this.#making.has(key) || !this.#callbacks.current(entry)) {
      return;
    }
    const made = (async (): Promise<void> => {
      let moved = true;
      try {
        await job();
      } catch (error) {
        // A fault — the site's, a generation given up after its attempts (`#artifact`), or the
        // store's, as what was made is kept: the requests the gate holds for the view answer 503 at
        // once (`fault`), and a later request, or a commit, tries again — never one of them over and
        // over until its deadline.
        moved = false;
        // eslint-disable-next-line no-console
        console.error(`A shared view's artifact failed: ${describeThrown(error)}`);
      } finally {
        this.#making.delete(key);
        this.#release(key, moved);
      }
      const { candidate } = entry;
      if (candidate !== undefined && candidate !== making && entry.status === 'pending') {
        this.#make(entry, candidate);
      } else if (!moved && making !== undefined && candidate === making) {
        this.#backoff(entry);
      }
    })();
    this.#making.set(key, made);
  }

  /** Whether what a job makes is wanted no more: outrun (`current` says so), or the authority closed. */
  #unwanted(current: () => boolean): boolean {
    return this.#stopped || !current();
  }

  /**
   * Counts a fault of `entry`'s in a row (`faults`), and has the view tried again where a page
   * follows it: a second on, twice as long after each fault, a minute at most.
   */
  #backoff(entry: Entry): void {
    const faults = (entry.faults ?? 0) + 1;
    entry.faults = faults;
    if (this.followed(entry.key)) {
      this.#retry(entry, Math.min(FAULT_RETRY_MS * 2 ** (faults - 1), MAX_FAULT_RETRY_MS));
    }
  }

  /**
   * Has the view of `entry` evaluated again `delay` ms on, where it is still the view its key holds
   * and a page still follows it then.
   */
  #retry(entry: Entry, delay: number): void {
    if (this.#stopped || this.#retries.has(entry.key)) {
      return;
    }
    this.#retries.arm(entry, delay, () => {
      if (this.#callbacks.current(entry) && this.followed(entry.key)) {
        this.schedule(entry, 0);
      }
    });
  }

  /** Lets go of the requests the gate holds for the view of `key`, telling whether it moved. */
  #release(key: string, moved: boolean): void {
    const waiters = this.#waiters.get(key);
    this.#waiters.delete(key);
    if (waiters !== undefined) {
      for (const woken of waiters) {
        woken(moved);
      }
    }
  }

  /**
   * In the queue: the view of `entry` made the request's where what was being made of it is still
   * wanted (`current`), its page's answer no artifact (`reason`) — past what an artifact may be, or
   * a redirect — rendered for each request from then on, and revoked where it was published, rather
   * than left pending, every visitor answered 503, for good.
   */
  async #privatize(entry: Entry, current: () => boolean, reason: string): Promise<void> {
    await this.#host.run(() => {
      if (this.#unwanted(current)) {
        return;
      }
      // eslint-disable-next-line no-console
      console.error(
        `A shared view of ${entry.route.route} is the request's from now on: ${reason}.`,
      );
      this.#callbacks.privatize(entry, reason);
    });
  }

  /** The page's artifact of one profile of a generation, asked for once, with a token of its own. */
  async #askOnce(fetchSite: SiteFetch, asked: ArtifactAsked): Promise<GeneratedArtifact> {
    const { core, secret } = this.#host;
    const { entry, generation, path, profile } = asked;
    const token = signGeneration(secret, {
      exp: core.clock() + TOKEN_TTL_MS,
      generation,
      profile,
      view: entry.key,
    });
    this.asks.start(token);
    try {
      const artifact = await fetchArtifact(
        fetchSite,
        { path, profile, token },
        this.#closing.signal,
      );
      if (!this.asks.wasRendered(token)) {
        throw new Error(`${path} answered what no render of the generation made.`);
      }
      return artifact;
    } finally {
      this.asks.end(token);
    }
  }

  /**
   * The page's artifact of one profile of a generation, asked for again after a failure — and
   * given up after `ATTEMPTS`, which is thrown as the fault it is (`#start`): the requests the gate
   * holds for the view answer 503 at once, and a later request, or a commit, asks again. None of a
   * page whose answer is no artifact — past what an artifact may be, or a redirect — whose view is
   * the request's from then on (`#privatize`), nor of one wanted no more.
   */
  async #artifact(
    asked: ArtifactAsked,
    current: () => boolean,
  ): Promise<GeneratedArtifact | undefined> {
    const { entry } = asked;
    const fetchSite = this.#host.site();
    const { metrics } = this.#host.core;
    if (fetchSite === undefined) {
      metrics.generationFailures += 1;
      return undefined;
    }
    let attempt = 0;
    while (!this.#unwanted(current)) {
      attempt += 1;
      try {
        return await this.#askOnce(fetchSite, asked);
      } catch (error) {
        if (this.#unwanted(current)) {
          // Outrun as it was made, or the authority closed: nothing is wanted of it, and it is no
          // failure of the site's.
          return undefined;
        }
        if (error instanceof UnsharedPageError) {
          // Asked for again, the page would answer as much: no failure to retry, nor of the site's.
          await this.#privatize(entry, current, error.reason);
          return undefined;
        }
        metrics.generationFailures += 1;
        // eslint-disable-next-line no-console
        console.error(`A generation of ${asked.path} failed: ${describeThrown(error)}`);
        if (attempt === ATTEMPTS) {
          throw new Error(
            `A generation of ${asked.path} was given up after ${String(ATTEMPTS)} attempts.`,
            { cause: error },
          );
        }
        await pause(RETRY_MS * 2 ** (attempt - 1), this.#closing.signal);
      }
    }
    return undefined;
  }

  /** In the queue: keeps `artifact` as `generation`'s, letting go of earlier generations'. */
  #keep(entry: Entry, generation: number, artifact: GeneratedArtifact): void {
    const { core, store } = this.#host;
    store.putArtifact(
      {
        body: artifact.body,
        created: core.clock(),
        deployment: artifact.deployment,
        etag: etagOf(entry.key, generation, entry.epoch, artifact),
        generation,
        headers: artifact.headers,
        profile: artifact.profile,
        view: entry.key,
      },
      generation,
    );
  }

  get streams(): number {
    return this.#followers.size;
  }

  /**
   * `entry` let go of (`SharedViews.#drop`): the retry behind its fault, where one waits, let go of
   * with it. Nothing else waits for a view nothing holds (`busy`, `followed`).
   */
  dropped(entry: Entry): void {
    this.#retries.drop(entry);
  }

  /** Whether something is under way for the view of `key`, which keeps it from being let go of. */
  busy(key: string): boolean {
    return this.#scheduled.has(key) || this.#making.has(key);
  }

  /**
   * Whether a page follows the view of `key` — an event stream, from its start (`listen`) — which
   * keeps it from being let go of: a view let go of is marked by no commit, and its streams would be
   * told of nothing, a withdrawal included.
   */
  followed(key: string): boolean {
    return this.#followers.has(key);
  }

  /** Evaluates `entry` again `delay` ms on, with whatever else lands meanwhile. */
  schedule(entry: Entry, delay = SETTLE_MS, generate = true): void {
    if (this.#stopped) {
      return;
    }
    if (this.#scheduled.has(entry.key)) {
      if (generate) this.#scheduled.set(entry.key, true);
      return;
    }
    this.#scheduled.set(entry.key, generate);
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      const make = this.#scheduled.get(entry.key) === true;
      this.#scheduled.delete(entry.key);
      void this.#settle(entry, make).catch(() => {
        // `#settle` answers its own failures, and never rejects.
      });
    }, delay);
    this.#timers.add(timer);
  }

  /**
   * Stops, as the authority closes: what was scheduled is let go of, and nothing more starts. What
   * is under way is let go of too — each request of the site and its deadline, each wait before the
   * next — none left to outlive the authority, and a generation it was making published whole or not
   * at all (`#make`): the view stays as it was. The requests the gate holds answer at once, as for a
   * view that does not settle in time. Resolves once every job under way has ended.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#closing.abort(new Error('The authority closed.'));
    for (const timer of this.#timers) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    this.#scheduled.clear();
    this.#retries.clear();
    // Each let go of in turn, as the map is walked: `fault` takes out that view's alone.
    for (const key of this.#waiters.keys()) {
      this.fault(key);
    }
    await Promise.allSettled(this.#making.values());
  }

  /** Moves `entry` on now: its generation made where one is pending, its evaluation otherwise. */
  kick(entry: Entry): void {
    if (entry.status === 'pending' && entry.candidate !== undefined) {
      this.#make(entry, entry.candidate);
    } else if (entry.status === 'dirty' || entry.status === 'new') {
      this.schedule(entry, 0);
    }
  }

  /** Schedules an undecided view's evaluation without asking the site for its artifacts. */
  evaluate(entry: Entry): void {
    this.schedule(entry, 0, false);
  }

  /**
   * The state `outcome` leaves `entry` in, in the queue, and what its streams are told of it: the
   * view decided, whatever faulted of it before.
   */
  apply(entry: Entry, outcome: SharedOutcome): void {
    entry.faults = 0;
    entry.stale = false;
    switch (outcome.kind) {
      case 'private': {
        this.#revoke(entry);
        Object.assign(entry, { candidate: undefined, published: undefined, status: 'private' });
        entry.dependencies = new Dependencies();
        return;
      }
      case 'denied': {
        this.#deny(entry, outcome);
        return;
      }
      case 'responded': {
        this.#revoke(entry);
        Object.assign(entry, {
          by: outcome.by,
          candidate: undefined,
          dependencies: outcome.dependencies,
          digest: digest(['responded', outcome.response]),
          published: undefined,
          response: outcome.response,
          revision: outcome.revision,
          status: 'responded',
        });
        return;
      }
      case 'rendered': {
        this.#evaluated(entry, outcome);
      }
    }
  }

  /** The rendering a generation token is of: the candidate's, or the published generation's. */
  rendering(entry: Entry, claims: GenerationClaims): Rendering | undefined {
    if (entry.candidate?.generation === claims.generation) {
      return entry.candidate;
    }
    return entry.status === 'ready' && entry.generation === claims.generation
      ? entry.published
      : undefined;
  }

  /**
   * Makes the artifact of `profile` of the published generation, which the store lacks — or holds
   * of another deployment of the site than a gate's question named (`fitOf`): of the deployment the
   * site serves now, as it answers.
   */
  makeProfile(entry: Entry, profile: Profile): void {
    const asked = entry.generation;
    this.#start(entry, undefined, async () => {
      const artifact = await this.#artifact(
        { entry, generation: asked, path: this.#callbacks.sitePath(entry), profile },
        () => entry.status === 'ready' && entry.generation === asked,
      );
      if (artifact === undefined) {
        return;
      }
      await this.#host.run(() => {
        if (entry.status === 'ready' && entry.generation === asked) {
          this.#keep(entry, asked, artifact);
        }
      });
    });
  }

  /** In the queue: `candidate` published as `entry`'s generation, where it still is its candidate. */
  publish(entry: Entry, candidate: Candidate, artifacts: readonly GeneratedArtifact[]): void {
    // A commit that changed what the candidate read since let it go: the next evaluation publishes.
    if (entry.candidate !== candidate) {
      return;
    }
    for (const artifact of artifacts) {
      this.#keep(entry, candidate.generation, artifact);
    }
    Object.assign(entry, {
      candidate: undefined,
      dependencies: candidate.dependencies,
      digest: candidate.digest,
      generation: candidate.generation,
      published: candidate,
      revision: candidate.revision,
      status: 'ready',
    });
    this.#host.core.metrics.generations += artifacts.length;
    this.notify(entry.key, { epoch: entry.epoch, generation: entry.generation, kind: 'ready' });
  }

  /**
   * Resolves `true` once the view of `key` moves (`wake`); `false` once what it waited for faulted
   * (`fault`), or at `deadline`, by the authority's clock — at once where the authority closed,
   * which moves nothing more.
   */
  waitFor(key: string, deadline: number): Promise<boolean> {
    const remaining = deadline - this.#host.core.clock();
    if (this.#stopped || remaining <= 0) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(key) ?? new Set<(moved: boolean) => void>();
      this.#waiters.set(key, waiters);
      const timer = setTimeout(() => {
        waiters.delete(woken);
        resolve(false);
      }, remaining);
      function woken(moved: boolean): void {
        clearTimeout(timer);
        resolve(moved);
      }
      waiters.add(woken);
    });
  }

  /** Wakes the requests the gate holds for the view of `key`, to decide again. */
  wake(key: string): void {
    this.#release(key, true);
  }

  /**
   * Lets go of the requests the gate holds for the view of `key` undecided, what they waited for
   * having faulted — its evaluation, or a job making its artifacts: each answers 503 at once, and
   * trying again is left to a later request, or a commit — one request never runs a faulting view's
   * code, nor a faulting job, more than once.
   */
  fault(key: string): void {
    this.#release(key, false);
  }

  /**
   * In the queue: `entry`, whose evaluation faulted, nothing decided of it. The requests the gate
   * holds for it answer 503 at once (`fault`). Where a commit changed what it read since it was last
   * decided (`stale`), what pages show of it may show what the commit withdrew: it is revoked, as a
   * refused view is (`#revoke`), and nothing it published is answered again — what it publishes next
   * is a generation of its own. A view no commit changed since — kept before the authority started,
   * say — still shows what was decided of it, and is left so. And where a page follows the view, it
   * is tried again behind a backoff, for a fault that passes to republish it, its pages told so.
   */
  faulted(entry: Entry): void {
    this.fault(entry.key);
    if (entry.stale === true) {
      this.#revoke(entry);
      Object.assign(entry, { candidate: undefined, digest: '', published: undefined });
    }
    this.#backoff(entry);
  }

  /**
   * Tells `listener` of each event of the view of `key` — a page's that holds the generation its
   * token `claims`, told what it `missed` as its stream started (`ViewFollowers`) — until the
   * returned function is called, once or more: a stream's request and its response may each close.
   */
  listen(
    key: string,
    claims: ViewClaims,
    missed: readonly SharedEvent[],
    listener: (event: SharedEvent) => void,
  ): () => void {
    return this.#followers.listen(key, claims, missed, listener);
  }

  notify(key: string, event: SharedEvent): void {
    this.#followers.notify(key, event);
  }
}
