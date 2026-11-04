import type {
  Frame,
  Json,
  RenderStatus,
  Result,
  SiteInputs,
  View,
  ViewRequest,
} from '../program.ts';
import { BUILD_MISMATCH, REVOKING_STATUSES } from '../status.ts';
import { canonicalJson } from './json.ts';
import { type Keeping, SetStates } from './set-states.ts';
import {
  carries,
  type Held,
  heldAfter,
  heldWithout,
  namedParts,
  NOTHING_HELD,
  sendsOf,
  sentInputs,
} from './view-sends.ts';

/**
 * What a root shows of its dynamic sites, and when it is rendered again: a controller for each
 * root a page renders, in the browser. A dynamic site is a reactive component a client part's JSX
 * renders with values of the part's local states — the site's inputs — which the authority renders,
 * with the rest of the root, for the inputs the page shows: the root's view. The root is rendered
 * again, whole and at one revision, through the compile's `view` Server Function, once the frame it
 * shows was not rendered for a site the page shows; once a revision newer than the frame's is
 * announced — by the root's event stream, or by the answer to one of the page's writes; and once
 * something the page did leaves it unsure of what the root shows (`force`).
 *
 * What the page shows is what its parts committed — each part, the sites its last committed render
 * named (`commit`) — and, over it, what a render not committed yet waits for (`ensure`): a
 * transition's, which React holds back until it has what it waits for. A frame rendered for more
 * than that shows it all the same, and the root is rendered again without the sites the page no
 * longer shows: a site closed — a detail, say — is neither rendered nor followed for the page any
 * more, and one opened again is rendered anew, for the session as it is then. A site waits
 * (`waitFor`) for the next frame the root commits: the waits are let go of once that frame's tree
 * has committed, so a render that waited renders again with the part that tree brought, never with
 * the part before and a new wait.
 *
 * One request at a time: a Server Function cannot be aborted, and Next.js sends them one after
 * another with the router's own work. A view that changes while one is on its way is asked for
 * once that one is answered, the views in between never; an answer for a view the page has moved
 * past is let go of, as is one older than the frame shown, and the root is asked for again if it
 * still shows less than the page wants. A view is asked for once: a frame that answers it, whatever
 * it shows, is not asked for again until the view changes. A request that fails, or brings no
 * answer in time, is sent again after a wait that doubles each time. A request names the parts the
 * page shows otherwise than the frame shown, and that frame's subscription the rest: a page of many
 * parts sends what it changed. Of a site's inputs it sends the states the page has set (`keep`),
 * and leaves out those it follows, for the authority to render of its own values.
 */

/**
 * The root rendered again for a view, as the compile's `view` Server Function answers it: whether
 * the session may see it, the frame it was rendered at, and its tree as the host renders it (`T`).
 */
export interface ViewAnswer<T> {
  readonly status: RenderStatus;
  readonly frame: Frame;
  readonly children: T;
}

/** What the controller asks of the root it controls. */
export interface ViewHost<T> {
  /** Renders the root again for a view: the compile's `view` Server Function. */
  readonly request: (request: ViewRequest) => Promise<Result<ViewAnswer<T>>>;
  /**
   * Shows an answer, in a transition: React keeps what the page shows until the answer's tree has
   * rendered, and commits it then.
   */
  readonly adopt: (answer: ViewAnswer<T>) => void;
  /** Renders the route again (`router.refresh`): the session the root was rendered for changed. */
  readonly refresh: () => void;
  /** The authority refused the page's build: the page is asked to reload. */
  readonly revoked: (message: string, code: string) => void;
}

interface ViewOptions {
  /** How long a request may take before it is taken for lost and sent again. */
  readonly timeout?: number;
  /** The first wait before a lost or failed request is sent again. */
  readonly retryDelay?: number;
}

/** A site's inputs a render waits for that no committed render of its part named yet. */
interface Wish {
  readonly inputs: SiteInputs;
  /** The frames committed before it was made: one committed since, its render has gone on. */
  readonly epoch: number;
}

/** What a site waits on: the next frame the root commits. */
interface Waiter {
  readonly promise: Promise<undefined>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

/** A request on its way, and what it was sent for. */
interface Request {
  /** The view's generation it asks for. */
  readonly generation: number;
  /** The subscription it was sent by. */
  readonly subscription: string;
  /** Of each part it names, the states the page set whose values it sends. */
  readonly sends: Held;
  /** Whether it left parts whose set states no subscription holds for a request after its answer. */
  readonly rest: boolean;
  /** The revision asked for before it, and whether it was forced: one lost asks for them again. */
  readonly asked: number;
  readonly forced: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

type Failure = Extract<Result<never>, { readonly ok: false }>;

/** Longer than the authority takes to render a root, however slow. */
const REQUEST_TIMEOUT_MS = 20_000;
const FIRST_RETRY_MS = 1000;
const LONGEST_RETRY_MS = 30_000;
const CLIENT_ERRORS = { first: 400, last: 499 } as const;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const REFUSED = 'The page could not be shown.';

function own<T>(target: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function entry<T>(record: Readonly<Record<string, T>> | undefined, name: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, name) ? record[name] : undefined;
}

/** Whether two sites' inputs are the same JSON. */
function sameInputs(a: SiteInputs, b: SiteInputs): boolean {
  return a === b || canonicalJson(a) === canonicalJson(b);
}

/**
 * Whether a frame rendered for `rendered` shows each part `wanted` names with the sites it names
 * alone, each for its inputs: a site more is one the page no longer shows, whose rendering the
 * root's stream would keep following.
 */
function showsExactly(rendered: View, wanted: View): boolean {
  for (const [instance, sites] of Object.entries(wanted)) {
    const shown = entry(rendered, instance) ?? {};
    if (Object.keys(shown).length !== Object.keys(sites).length) {
      return false;
    }
  }
  return covers(rendered, wanted);
}

/** Whether a frame rendered for `rendered` shows every site `wanted` names, each for its inputs. */
function covers(rendered: View, wanted: View): boolean {
  for (const [instance, sites] of Object.entries(wanted)) {
    const shown = entry(rendered, instance);
    for (const [site, inputs] of Object.entries(sites)) {
      const at = entry(shown, site);
      if (at === undefined || !sameInputs(at, inputs)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * The parts `wanted` shows otherwise than a frame rendered for `rendered` does, each with every site
 * it shows: what a request names, over the view the frame's subscription names.
 */
function partsChanged(rendered: View, wanted: View): View {
  const changed: Record<string, Readonly<Record<string, SiteInputs>>> = {};
  for (const [instance, sites] of Object.entries(wanted)) {
    if (canonicalJson(entry(rendered, instance) ?? {}) !== canonicalJson(sites)) {
      own(changed, instance, sites);
    }
  }
  return changed;
}

/** Whether a refusal is one a resend would only repeat: a 4xx, but a timeout's or a throttle's. */
function isDefinitive(status: number): boolean {
  return (
    status >= CLIENT_ERRORS.first &&
    status <= CLIENT_ERRORS.last &&
    status !== HTTP_REQUEST_TIMEOUT &&
    status !== HTTP_TOO_MANY_REQUESTS
  );
}

/** Whether a Server Function's answer is a `Result` of an answer, as a newer build's may not be. */
function isResult<T>(value: unknown): value is Result<ViewAnswer<T>> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { ok } = value as { readonly ok?: unknown };
  if (ok === false) {
    return true;
  }
  const frame = (value as { readonly value?: { readonly frame?: Partial<Frame> } }).value?.frame;
  return (
    ok === true &&
    typeof frame === 'object' &&
    typeof frame.rootKey === 'string' &&
    typeof frame.revision === 'number' &&
    typeof frame.subscription === 'string' &&
    typeof frame.view === 'object'
  );
}

export class ViewController<T> {
  readonly #rootKey: string;
  readonly #host: ViewHost<T>;
  readonly #timeout: number;
  readonly #firstDelay: number;
  #delay: number;
  /** The frame the root shows, or will once the answer handed to it last has committed. */
  #shown: Frame | undefined;
  /** The frame the root committed last. */
  #committed: Frame | undefined;
  /** What each part shows, by its instance: the sites its last committed render named. */
  readonly #parts = new Map<string, Readonly<Record<string, SiteInputs>>>();
  /** What renders not committed yet wait for, by instance and site. */
  readonly #wishes = new Map<string, Map<string, Wish>>();
  /**
   * The states the page has set, by the part's instance (`keep`): a request sends their values. It
   * leaves out the rest, which follow what the authority renders of them, for the authority to
   * render each site of its own values — those the page takes with the frame that brings them.
   */
  readonly #set = new SetStates();
  /**
   * Of each part, the states the page set whose values the subscription `#heldBy` holds: those a
   * request answered by its frame sent, over what the one it was sent by held. A frame the route
   * rendered holds none, and a part whose set state its subscription does not hold is named in
   * every request until one holds it — the authority would else render that state's site of its
   * own value, which the page no longer takes.
   */
  #held: Held = NOTHING_HELD;
  #heldBy: string | undefined;
  /**
   * The parts no longer rendered, which the page shows as showing no site while a frame it shows
   * renders them: the root is rendered again without their sites, which its stream follows no more.
   */
  readonly #released = new Set<string>();
  /** The view the page shows, as one text, and its generation: one more each time it changes. */
  #key: string | undefined;
  #view: View = {};
  #generation = 0;
  /** The newest generation whose answer was shown. */
  #answered = 0;
  /** The frames committed so far, which the waits of each are kept apart by. */
  #epoch = 0;
  #waiters = new Map<string, Waiter>();
  #inFlight: Request | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  /** The newest revision announced, and the newest a request was sent for. */
  #wanted = -Infinity;
  #asked = -Infinity;
  /** Whether a request is wanted whatever the view and the revisions say. */
  #forced = false;
  /**
   * Whether the route renders again, asked to after the authority refused the session: nothing is
   * asked for until it has, and the root takes what it renders, its view whatever it is.
   */
  #refreshing = false;
  /** Whether the route rendered again since: the session refused again, it is not asked again. */
  #refreshed = false;
  /** Whether the page's build was refused: nothing more is asked for, and the page reloads. */
  #halted = false;
  #scheduled = false;
  #started = false;

  constructor(rootKey: string, host: ViewHost<T>, options: ViewOptions = {}) {
    this.#rootKey = rootKey;
    this.#host = host;
    this.#timeout = options.timeout ?? REQUEST_TIMEOUT_MS;
    this.#firstDelay = options.retryDelay ?? FIRST_RETRY_MS;
    this.#delay = this.#firstDelay;
  }

  /** Lets every site that waits render again: a frame committed, or the root is gone. */
  #release(): void {
    const waiting = [...this.#waiters.values()];
    this.#waiters = new Map();
    this.#epoch += 1;
    for (const waiter of waiting) {
      waiter.resolve();
    }
  }

  /** What the page shows: each part's committed sites, and what renders not committed wait for. */
  #requested(): View {
    const view: Record<string, Record<string, SiteInputs>> = {};
    for (const [instance, sites] of this.#parts) {
      own(view, instance, { ...sites });
    }
    for (const [instance, wishes] of this.#wishes) {
      let sites = entry(view, instance);
      if (sites === undefined) {
        sites = {};
        own(view, instance, sites);
      }
      for (const [site, { inputs }] of wishes) {
        own(sites, site, inputs);
      }
    }
    return view;
  }

  /**
   * Looks at what is wanted once whatever the commit under way brings has been told: each part
   * commits its sites in an effect of the same commit, and the first must not send a view the
   * others' change again.
   */
  #schedule(): void {
    if (this.#scheduled) {
      return;
    }
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#flush();
    });
  }

  /** Forgets each part no longer rendered that no frame shown renders either: nothing to let go of. */
  #prune(): void {
    for (const instance of this.#released) {
      if (entry(this.#shown?.view, instance) === undefined) {
        this.#released.delete(instance);
        this.#parts.delete(instance);
      }
    }
  }

  #flush(): void {
    if (!this.#started) {
      return;
    }
    this.#prune();
    const view = this.#requested();
    const key = canonicalJson(view);
    if (key !== this.#key) {
      this.#key = key;
      this.#view = view;
      this.#generation += 1;
    }
    this.#pump();
  }

  #pump(): void {
    if (
      !this.#started ||
      this.#halted ||
      this.#refreshing ||
      this.#inFlight !== undefined ||
      this.#retry !== undefined ||
      this.#shown === undefined
    ) {
      return;
    }
    const { revision, subscription, view } = this.#shown;
    const unshown = this.#answered < this.#generation && !showsExactly(view, this.#view);
    const behind = this.#wanted > revision && this.#wanted > this.#asked;
    if (subscription !== '' && (unshown || behind || this.#forced)) {
      this.#send(subscription, view);
    }
  }

  /**
   * Asks for the view the page shows, by the subscription of the frame shown, which was rendered for
   * `rendered`: naming the parts the page shows otherwise.
   */
  #send(subscription: string, rendered: View): void {
    const changed = partsChanged(rendered, this.#view);
    const kept = this.#set.kept;
    const valuesOf = (instance: string) => this.#valuesOf(instance);
    const held = this.#heldIn(subscription);
    const { named, rest } = namedParts(this.#view, changed, { held, kept, valuesOf });
    const withValues = sentInputs(named, kept, valuesOf);
    // Past what a request carries with them, it goes without, and each part it names shows the sites
    // it names alone: one a followed state opens there is asked for once the page shows it.
    const view = carries(withValues) ? withValues : sentInputs(named, kept);
    const request: Request = {
      asked: this.#asked,
      forced: this.#forced,
      generation: this.#generation,
      rest,
      sends: sendsOf(view, valuesOf),
      subscription,
      timer: setTimeout(() => {
        this.#lost(request);
      }, this.#timeout),
    };
    this.#inFlight = request;
    this.#asked = Math.max(this.#asked, this.#wanted);
    this.#forced = false;
    void this.#ask(request, { subscription, view }).catch(() => {
      // Nothing is left to tell: every failure of a request is answered where it is heard.
    });
  }

  /**
   * Of the part `instance`, the values of the states the page set that its sites read, `{}` of none;
   * nothing of a part let go of, which no render waits in — its view names no site, and opens none —
   * nor of one that holds a value JSON carries not, whose view shows the sites it names alone.
   */
  #valuesOf(instance: string): Readonly<Record<string, Json>> | undefined {
    if (this.#released.has(instance) && !this.#wishes.has(instance)) {
      return undefined;
    }
    return this.#set.valuesOf(instance);
  }

  /** Of each part, what `subscription` holds of the page's set states (`#held`). */
  #heldIn(subscription: string): Held {
    return this.#heldBy === subscription ? this.#held : NOTHING_HELD;
  }

  async #ask(request: Request, sent: ViewRequest): Promise<void> {
    let answer: unknown;
    try {
      answer = await this.#host.request(sent);
    } catch {
      answer = undefined;
    }
    if (this.#inFlight !== request) {
      // Taken for lost, or the root was stopped: a request sent since asks in its place.
      return;
    }
    clearTimeout(request.timer);
    this.#inFlight = undefined;
    if (!isResult<T>(answer)) {
      this.#again(request);
    } else if (answer.ok) {
      this.#answer(request, answer.value);
    } else {
      this.#refused(request, answer);
    }
  }

  #answer(request: Request, answer: ViewAnswer<T>): void {
    const { frame } = answer;
    if (frame.rootKey !== this.#rootKey) {
      // Rendered for another session than the root's: the route renders it for the session now —
      // once; a root the route renders as it was is left as it shows.
      if (this.#refreshed) {
        this.#answered = request.generation;
      } else {
        this.#refreshSession(request);
      }
      return;
    }
    if (
      request.generation !== this.#generation ||
      (this.#shown !== undefined && frame.revision < this.#shown.revision)
    ) {
      this.#restore(request);
      this.#pump();
      return;
    }
    this.#delay = this.#firstDelay;
    this.#refreshed = false;
    this.#answered = request.generation;
    this.#held = heldAfter(this.#heldIn(request.subscription), request.sends, frame.view);
    this.#heldBy = frame.subscription;
    // The parts a request could not carry are asked for now, with no revision more to tell.
    this.#forced ||= request.rest;
    this.#shown = frame;
    this.#host.adopt(answer);
    this.#pump();
  }

  #refused(request: Request, failure: Failure): void {
    if (failure.code === BUILD_MISMATCH) {
      this.#halted = true;
      this.#host.revoked(failure.message, failure.code);
      return;
    }
    if (REVOKING_STATUSES.has(failure.status) && !this.#refreshed) {
      this.#refreshSession(request);
      return;
    }
    if (!isDefinitive(failure.status)) {
      this.#again(request);
      return;
    }
    if (request.generation !== this.#generation) {
      // A view the page has moved past: the one it shows now is asked for instead.
      this.#restore(request);
      this.#pump();
      return;
    }
    // Refused for good: it is not asked for again, and the sites that wait for it fail — on each
    // render, as React renders a site again once what it waits on settles, until a frame commits.
    this.#answered = request.generation;
    const error = new Error(failure.message === '' ? REFUSED : failure.message, {
      cause: failure,
    });
    for (const waiter of this.#waiters.values()) {
      waiter.reject(error);
    }
  }

  /**
   * The session changed: the route renders again, and nothing is asked for until it has — or, as
   * the router says nothing of a refresh that failed, until a request would be taken for lost.
   */
  #refreshSession(request: Request): void {
    this.#restore(request);
    this.#refreshing = true;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      this.#refreshing = false;
      this.#pump();
    }, this.#timeout);
    this.#host.refresh();
  }

  /** Leaves what a request was sent for to be asked for again. */
  #restore(request: Request): void {
    this.#asked = request.asked;
    this.#forced ||= request.forced;
  }

  /** A request that failed or brought nothing in time: sent again after the current wait. */
  #again(request: Request): void {
    this.#restore(request);
    const delay = this.#delay;
    this.#delay = Math.min(delay * 2, LONGEST_RETRY_MS);
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      this.#pump();
    }, delay);
  }

  #lost(request: Request): void {
    if (this.#inFlight === request) {
      this.#inFlight = undefined;
      this.#again(request);
    }
  }

  /** Whether the root takes the next frame the route renders, whatever view it was rendered for. */
  get refreshing(): boolean {
    return this.#refreshing;
  }

  /** The root is shown: what its parts commit from now on is asked for. */
  start(): void {
    this.#started = true;
    this.#schedule();
  }

  /**
   * The root is no longer shown, or is shown anew: every wait is let go of, every answer on its way
   * dropped, and what its parts showed forgotten — a part shown again commits it again.
   */
  stop(): void {
    this.#started = false;
    clearTimeout(this.#inFlight?.timer);
    clearTimeout(this.#retry);
    this.#inFlight = undefined;
    this.#retry = undefined;
    this.#parts.clear();
    this.#released.clear();
    this.#wishes.clear();
    this.#committed = undefined;
    this.#key = undefined;
    this.#release();
  }

  /**
   * The root committed `frame`: its first, one the route rendered, or an answer. The sites that
   * waited render again, with what the frame's tree brought them.
   */
  show(frame: Frame): void {
    if (frame === this.#committed || frame.rootKey !== this.#rootKey) {
      return;
    }
    this.#committed = frame;
    if (this.#shown === undefined || frame.revision >= this.#shown.revision) {
      this.#shown = frame;
    }
    if (this.#refreshing) {
      clearTimeout(this.#retry);
      this.#retry = undefined;
      this.#refreshing = false;
      this.#refreshed = true;
    }
    this.#release();
    this.#schedule();
  }

  /** Whether a frame rendered for `view` shows every site the page shows, for its inputs. */
  covers(view: View): boolean {
    return covers(view, this.#requested());
  }

  /** A revision newer than the frame's may show something else. */
  want(revision: number): void {
    this.#wanted = Math.max(this.#wanted, revision);
    this.#schedule();
  }

  /** Renders the root again, whatever it shows. */
  force(): void {
    this.#forced = true;
    this.#schedule();
  }

  /** A render of the part `instance` committed, naming `sites`: the page shows them now. */
  commit(instance: string, sites: Readonly<Record<string, SiteInputs>>): void {
    this.#released.delete(instance);
    this.#parts.set(instance, sites);
    this.#set.committed(instance);
    const wishes = this.#wishes.get(instance);
    if (wishes !== undefined) {
      // A wish is kept until a commit of its part shows it, or until its part commits after a
      // frame committed since it was made: the render that made it rendered again, or was let go.
      for (const [site, wish] of wishes) {
        const committed = entry(sites, site);
        if (
          wish.epoch < this.#epoch ||
          (committed !== undefined && sameInputs(committed, wish.inputs))
        ) {
          wishes.delete(site);
        }
      }
      if (wishes.size === 0) {
        this.#wishes.delete(instance);
      }
    }
    this.#schedule();
  }

  /**
   * The part `instance` is no longer rendered — a component of the browser's stopped rendering it —
   * and shows no site: while a frame the page shows renders it, the view names it with none, as a
   * view that does not name a part shows the sites its states' first values show.
   */
  release(instance: string): void {
    this.#parts.set(instance, {});
    this.#released.add(instance);
    this.#wishes.delete(instance);
    // A part rendered again starts its states anew, following the authority until set, and no
    // subscription holds a value of them.
    this.#set.released(instance);
    this.#held = heldWithout(this.#held, instance);
    this.#schedule();
  }

  /**
   * The page set the state `key` of the part `instance`, which follows the authority no more: a
   * request sends its value from now on, while the part is rendered.
   */
  keep(instance: string, key: string, keeping: Keeping = {}): void {
    this.#set.keep(instance, key, keeping);
  }

  /** A render of the part `instance` waits for `site` with `inputs`, which it has not committed. */
  ensure(instance: string, site: string, inputs: SiteInputs): void {
    const committed = entry(this.#parts.get(instance), site);
    if (committed !== undefined && sameInputs(committed, inputs)) {
      // The part shows these already, and waits with them: a render that waits for them again —
      // React warming the tree a fallback stands in for — wishes for nothing the page does not show,
      // which would outlive the part's next commit of other inputs.
      return;
    }
    let wishes = this.#wishes.get(instance);
    if (wishes === undefined) {
      wishes = new Map();
      this.#wishes.set(instance, wishes);
    }
    wishes.set(site, { epoch: this.#epoch, inputs });
    this.#schedule();
  }

  /**
   * What a site waits on until the root commits another frame: the same promise for the same site
   * and inputs until then, as React asks of what a render suspends on.
   */
  waitFor(instance: string, site: string, inputs: SiteInputs): Promise<undefined> {
    const key = canonicalJson([instance, site, inputs]);
    let waiter = this.#waiters.get(key);
    if (waiter === undefined) {
      const { promise, reject, resolve } = Promise.withResolvers<undefined>();
      void promise.catch(() => {
        // Thrown where it is heard: in the render that waits, by React.
      });
      waiter = {
        promise,
        reject,
        resolve: () => {
          resolve(undefined);
        },
      };
      this.#waiters.set(key, waiter);
    }
    return waiter.promise;
  }
}
