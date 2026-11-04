import type { RenderResult } from '../program.ts';
import type {
  GateAnswer,
  ResponseDescriptor,
  RouteParams,
  RouteRegistration,
  SharedEvent,
  SharedView,
  SiteShape,
} from '../routing.ts';
import type { Dependencies, RowChange } from './dependencies.ts';
import type { Core } from './model.ts';
import { rootPropsOf } from './route-registry.ts';
import { sharedFrame } from './shared-render.ts';
import type { StoredView, ViewStatus } from './shared-store.ts';
import { signView, type ViewClaims } from './view-tokens.ts';
import { type Root, statusView } from './views.ts';

/** A shared view as the authority holds it, between a request and the next commit. */

/**
 * What a gate is answered while the view it asks of settles: to wait for it — and what it answers
 * where what it waits for faults, or its deadline passes (`failed`): the 503 unless said.
 */
export interface Wait {
  readonly kind: 'wait';
  readonly failed?: GateAnswer;
}
export const WAIT: Wait = Object.freeze({ kind: 'wait' });

/**
 * A gate's decision to wait, with the request's waiter, installed as it was decided: `true` once
 * the view moves, `false` at the request's deadline, or once what it waited for faulted.
 */
export interface Waiting extends Wait {
  readonly woken: Promise<boolean>;
}

/** Where a view stands, as it is held: a kept status, or never evaluated, or a generation pending. */
type EntryStatus = ViewStatus | 'new' | 'pending';

/** A generation's render: what the page renders it with. */
export interface Rendering {
  readonly generation: number;
  readonly root: Root;
  readonly result: RenderResult;
}

/** A generation evaluated, whose artifacts are being made, with what it read. */
export interface Candidate extends Rendering {
  readonly digest: string;
  readonly dependencies: Dependencies;
  readonly revision: number;
}

export interface Entry {
  readonly key: string;
  readonly route: RouteRegistration;
  readonly params: RouteParams;
  status: EntryStatus;
  /** The generation published; 0 before the first. */
  generation: number;
  /** The access epoch: a new one each time a view a page may show is revoked. */
  epoch: number;
  /** What the published generation showed; what a denied view's next generation never matches. */
  digest: string;
  dependencies: Dependencies;
  revision: number;
  /** When a request last asked for it, by the authority's clock. */
  observed: number;
  /** When the store last kept `observed`: kept now and then, not for each request. */
  observedKept?: number | undefined;
  candidate?: Candidate | undefined;
  published?: Rendering | undefined;
  /**
   * Whether a page may show the view in its epoch besides as it was published: a candidate a page's
   * own render was handed before it was published, or anything of a view kept before the authority
   * started, which it cannot tell. Revoked as a published view is, which ends it.
   */
  exposed?: boolean | undefined;
  /**
   * The newest generation a page's own render was handed: the one published, or a candidate before
   * it was. Whatever the view publishes next is numbered past it, for every page that holds an older
   * one to take it for newer (`SharedRoot`), and so are the generations of a view's whole life.
   */
  handed?: number | undefined;
  /**
   * Whether a commit changed what the view read since it was last decided — as the store keeps a
   * view dirty — which an evaluation that faults leaves undecided: what pages show of it may show
   * what the commit withdrew, and is revoked (`SharedJobs.faulted`).
   */
  stale?: boolean | undefined;
  /**
   * How many of its evaluations, or of the jobs making its pending generation's artifacts, faulted in
   * a row: how long a followed view waits to be tried again.
   */
  faults?: number | undefined;
  /**
   * Where the site serves the view's page, as the latest gate's question of it read it — its own
   * deployment's site — or a page's render of it said: where its artifacts are asked for, by the job
   * that starts next. None before either did, which the build's shape stands in for.
   */
  site?: SiteShape | undefined;
  /**
   * Whether what the view published was withdrawn since the store last kept it — refused, answered
   * by a guard in its place, made the request's, or revoked after a fault — its artifacts, whichever
   * the store holds, let go of as the view is kept next, in the same transaction (`SharedStore.put`).
   */
  withdrawn?: boolean | undefined;
  response?: ResponseDescriptor | undefined;
  /**
   * The middleware whose guard decided the view's answer — refused it (`denied`), or answered
   * `response` in its place (`responded`) — by id; none where its root refused it. Not kept by the
   * store: a view kept is evaluated again before it is answered with, which decides it anew.
   */
  by?: string | undefined;
}

/**
 * A view, as the store keeps it: a generation still pending is one to evaluate again; and a view a
 * page's own render was handed a later generation of than it published is kept as of that one, its
 * digest unknown — started again, the authority numbers what it publishes next past it, and takes
 * nothing it evaluates for what it published.
 */
export function storedOf(build: string, entry: Entry): StoredView {
  const status = entry.status === 'pending' || entry.status === 'new' ? 'dirty' : entry.status;
  const handed = entry.handed ?? 0;
  return {
    build,
    dependencies: entry.dependencies.toJSON(),
    digest: handed > entry.generation ? '' : entry.digest,
    epoch: entry.epoch,
    generation: Math.max(entry.generation, handed),
    key: entry.key,
    observed: entry.observed,
    params: entry.params,
    revision: entry.revision,
    route: entry.route.route,
    status,
  };
}

/** What a page that shows `shown` of the view is told of it, its event stream's token among it. */
export function viewInfo(
  secret: string,
  build: string,
  entry: Entry,
  shown?: Pick<Rendering, 'generation'>,
): SharedView {
  const generation = shown?.generation ?? entry.generation;
  return {
    epoch: entry.epoch,
    generation,
    token: signView(secret, {
      build,
      epoch: entry.epoch,
      generation,
      params: entry.params,
      route: entry.route.route,
    }),
  };
}

/** A view refused: the root's status alone, as a page renders a refused root. */
export function forbiddenResult(core: Core, entry: Entry): RenderResult {
  const root: Root = { component: entry.route.root, props: rootPropsOf(entry.route, entry.params) };
  const view = statusView(core, 'forbidden');
  return { frame: sharedFrame(core, root, view), status: 'forbidden', tree: null };
}

/** The views no page shows: refused, or answered by a guard's own response in their place. */
const REFUSED: ReadonlySet<Entry['status']> = new Set(['denied', 'responded']);

/** The accepted stream's current published state, and any denial its token missed. */
export function missedOf(entry: Entry, claims: ViewClaims): SharedEvent[] {
  const missed: SharedEvent[] = [];
  if (entry.epoch > claims.epoch || REFUSED.has(entry.status)) {
    missed.push({ epoch: entry.epoch, kind: 'denied' });
  }
  if (entry.status === 'ready') {
    missed.push({ epoch: entry.epoch, generation: entry.generation, kind: 'ready' });
  }
  return missed;
}

/** The views a commit's rows are held to: those that show, or refuse, what they read. */
const READS: ReadonlySet<Entry['status']> = new Set(['denied', 'ready', 'responded']);

/** The retained views whose dependencies a commit changes, including unpublished candidates. */
export function dirtyViewKeys(
  entries: Iterable<Entry>,
  rows: readonly RowChange[],
): readonly string[] {
  const keys: string[] = [];
  for (const entry of entries) {
    const reads = READS.has(entry.status) || (entry.status === 'dirty' && entry.stale !== true);
    const changed = (reads || entry.status === 'pending') && entry.dependencies.changedBy(rows);
    if (changed || entry.candidate?.dependencies.changedBy(rows) === true) {
      keys.push(entry.key);
    }
  }
  return keys;
}

/** Whether a retained view or its pending generation reads an external table. */
export function retainedView(
  entries: Iterable<Entry>,
  tables: ReadonlySet<string>,
  { since, held }: { readonly since: number; readonly held: (key: string) => boolean },
): boolean {
  for (const entry of entries) {
    const reads =
      entry.dependencies.reads(tables) || entry.candidate?.dependencies.reads(tables) === true;
    if (reads && (entry.observed >= since || held(entry.key))) return true;
  }
  return false;
}
