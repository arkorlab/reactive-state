import type { PublicView } from '../client/contract.ts';
import type { ChangeEvent, ComponentProgram, OperationModule } from '../program.ts';
import type { AnyDatabase, DatabaseDefinition } from '../server/schema.ts';
import type { Database } from './database.ts';
import type { RowChange } from './dependencies.ts';
import type { ExternalStores } from './external.ts';
import type { Memo } from './memo.ts';
import type { Registry } from './programs.ts';
import type { RouteOptions, RouteRegistry } from './route-registry.ts';
import type { SessionMode } from './sessions.ts';
import type { SqlDriver } from './sql.ts';
import type { Tables } from './tables.ts';

/** The authority's own types: what it is opened with, what it announces, and what it answers. */

/** What a compile writes for the authority (`<out>/authority.mts`), as it is handed over. */
export interface Application extends RouteOptions {
  /** Every component's program (`<id>.authority.mts`). */
  readonly programs: readonly ComponentProgram[];
  /** Every `'use server'` module a component imports, by its id: `{ "actions/todos": … }`. */
  readonly operations?: Readonly<Record<string, OperationModule>> | undefined;
  /** The application's database, as `database()` of `@arkorlab/reactive-state/server` declared it. */
  readonly database: AnyDatabase;
  /** The compile's build; the programs' own where it is not given. */
  readonly buildId?: string | undefined;
  /**
   * Whose sessions the authority admits: the demo's (`demo`, unless given), which it opens itself,
   * or those the application's server asserts of its own sign-in (`asserted`), which the compile
   * writes where the application names how its sessions are read (`--session`).
   */
  readonly sessions?: SessionMode | undefined;
}

/**
 * The stores the external tables are read through, and how often their logs are read while
 * anything follows: the host's to give, which knows the application's own databases.
 */
export interface ExternalOptions {
  /** By the names the tables declare (`table(fields, { external })`). */
  readonly stores?: ExternalStores | undefined;
  /** How often each store's change log is read while anything follows: a second unless given. */
  readonly externalPollMs?: number | undefined;
}

/**
 * The host's turns of following external stores: its one alarm (`schedule`), shared with delivery —
 * absent on Node, where a timer schedules each — and what keeps a read running past an answer
 * (`keep`, the object's `waitUntil`).
 */
export interface ExternalHost {
  readonly schedule?: ((at: number) => Promise<void>) | undefined;
  readonly keep?: ((work: Promise<unknown>) => void) | undefined;
}

/** What the authority's engine is opened with, wherever its SQLite is. */
export interface AuthorityEngineOptions extends Application, ExternalOptions {
  /** The host's turns of following external stores (`ExternalHost`): the Durable Object's. */
  readonly externalHost?: ExternalHost | undefined;
  readonly sql: SqlDriver;
  readonly clock?: () => number;
  /**
   * How long a call that runs the application's code — a render, a write's replay, a server
   * operation — may run before it is a fault: it holds the authority's one queue, which every
   * request of the application waits in. Five seconds unless given.
   */
  readonly timeoutMs?: number;
  /** The longest a route's gate holds a request for a view that is settling: 10 s unless given. */
  readonly gateWaitMs?: number;
}

/** What the authority is opened with on a developer's machine (`Engine`). */
export interface EngineOptions extends Application, ExternalOptions {
  /** The database file; in memory when not given. */
  readonly filename?: string;
  readonly clock?: () => number;
  readonly timeoutMs?: number;
  readonly gateWaitMs?: number;
}

/**
 * A commit, as the engine announces it to whatever follows it (an event stream): the revision, the
 * resources it changed — each record, and a session that ended — and each record as it was before
 * the commit and after it, which a render's queries are held to.
 */
export interface CommitEvent {
  readonly revision: number;
  readonly changed: readonly string[];
  readonly kind: ChangeEvent['kind'];
  readonly rows: readonly RowChange[];
}

export interface Session {
  readonly id: string;
  readonly userId: string;
  /** When it expires, by the authority's clock: it ends then whether or not anything commits. */
  readonly expires: number;
  /** The key the application's server asserted the session under, for an asserted session alone. */
  readonly key?: string;
}

/**
 * A render of a page's root that a session's event stream follows: the revision it was rendered
 * at, a digest of what it shows, the digest the page showed when its subscription was issued, and
 * whether a commit changes anything the render read — a record, a query's answer, or the session.
 */
export interface Watched {
  readonly revision: number;
  readonly digest: string;
  readonly issued: string;
  readonly dependsOn: (event: CommitEvent) => boolean;
}

export interface Stats {
  readonly revision: number;
  readonly buildId: string;
  /** Pages' roots rendered: for a page, and for an event stream. */
  readonly renders: number;
  /** Components evaluated: rendered, or replayed for a write; one the memo held is not. */
  readonly evaluations: number;
  /** Of `evaluations`, by component id. */
  readonly evaluationsByComponent: Readonly<Record<string, number>>;
  /** Dynamic sites rendered: for a page's view, for a page's render, and for an event stream. */
  readonly siteRenders: number;
  /**
   * Queries the components evaluated ran (`findMany`, `count`): as they rendered, or as a write
   * replayed them. A component the memo held runs none.
   */
  readonly renderQueries: number;
  readonly memoHits: number;
  readonly memoEvictions: number;
  readonly memoEntries: number;
  readonly commits: number;
  readonly deduplicated: number;
  readonly updaterRuns: number;
  readonly operationRuns: number;
  readonly queryEvaluations: number;
  readonly artifactRenders: number;
  readonly cacheHits: number;
  readonly invalidations: number;
  readonly cacheEntries: number;
  readonly operations: number;
  /** Shared views evaluated: a route's root and guards, for every visitor at once. */
  readonly sharedEvaluations: number;
  /** Route middleware guards evaluated, wherever: a shared view, a session's render, a replay. */
  readonly guardEvaluations: number;
  /** Renders of a route's page Next.js asked for (`renderShared`), each one of its own. */
  readonly nextRenders: number;
  /** Requests a route's gate was asked of, and those it held until the view settled. */
  readonly gateLookups: number;
  readonly gateWaits: number;
  /** Artifacts a gate answered with, and their bytes. */
  readonly artifactReads: number;
  readonly artifactBytes: number;
  /** Artifacts made of a generation, by asking for the page; and those that failed. */
  readonly generations: number;
  readonly generationFailures: number;
  /** What the application's code read of the database, as components rendered or replayed. */
  readonly appReads: number;
  /** What route middleware guards read of the database. */
  readonly middlewareReads: number;
  /** Shared views kept, and event streams following one now. */
  readonly sharedViews: number;
  readonly sharedStreams: number;
}

export interface PublicSnapshot extends PublicView {
  readonly html: string;
  readonly cache: 'HIT' | 'MISS';
  readonly dependencies: Readonly<Record<string, number>>;
}

export type Metrics = Record<
  Exclude<
    keyof Stats,
    | 'buildId'
    | 'cacheEntries'
    | 'evaluationsByComponent'
    | 'memoEntries'
    | 'operations'
    | 'revision'
    | 'sharedStreams'
    | 'sharedViews'
  >,
  number
>;

export type CommitListener = (event: CommitEvent) => void;

/** What a commit writes: records, with what lands in its transaction beside them. */
export interface Commit {
  readonly rows: readonly RowChange[];
  /** Whether the rows are an external table's, as its store's log tells of them: none is written. */
  readonly external?: boolean;
  readonly kind: ChangeEvent['kind'];
  /** What the commit changes besides its records: a session that ended. */
  readonly resources?: readonly string[];
  /** What lands in the commit's transaction with its records, numbered at its revision. */
  readonly with?: (revision: number) => void;
}

/** What the engine's calls share: its database, its registry, and how it commits. */
export interface Core {
  readonly db: Database;
  readonly tables: Tables;
  readonly definition: DatabaseDefinition;
  readonly registry: Registry;
  /** The routes the compile registered, and the guards of the middleware around them. */
  readonly routes: RouteRegistry;
  readonly memo: Memo;
  readonly secret: string;
  /** Separates initial guard decisions issued by different engine lifetimes. */
  readonly boot: string;
  readonly clock: () => number;
  readonly timeoutMs: number;
  readonly metrics: Metrics;
  /** The components evaluated, by id. */
  readonly evaluatedBy: Map<string, number>;
  /** The session `id` names, while it lasts: the authority's refusal (401) otherwise. */
  readonly session: (id: unknown) => Session;
  /** `session`, resolved earlier in the call, while it still lasts: the refusal (401) otherwise. */
  readonly current: (session: Session) => Session;
  /**
   * Lets go of what no asserted session needs any more, at most once an hour (`Sessions.sweep`):
   * run beside each write of a receipt, a commit's or an operation's that committed nothing.
   */
  readonly sweep: () => void;
  /** Commits, and announces what it committed, before anything else reads. */
  readonly commit: (commit: Commit) => CommitEvent;
}
