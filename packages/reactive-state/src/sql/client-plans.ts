import { type TableRead } from '../server/context.ts';
import { type Relation, relationKey } from './capture.ts';
import { type Catalog, catalogOf, catalogSql, NO_CONDITIONS } from './catalog.ts';
import {
  changesContext,
  changesSession,
  leavesSession,
  leavesTransactionOpen,
  namesTemporaryRowType,
  scopedAfter,
  type Scoped,
} from './guards.ts';
import type { Followed } from './keys.ts';
import { explainSql, type PlanReads, planReads, type Scan } from './plans.ts';
import { readsOf, type TableScan } from './reads.ts';
import { renamesColumns } from './renames.ts';
import { type Bound, NOTHING_BOUND } from './serialized.ts';
import { namesTypeByText, unknownTypeCast } from './type-guards.ts';

/**
 * What the clients of a PGlite (`client.ts`) and of a `pg` pool (`client-pool.ts`) share: how a
 * render's statement is planned, what the plan may read, and the plans a connection keeps.
 */

/**
 * How a statement's plan is asked. `check` finds the text one statement: it plans it through
 * `query` — the extended protocol, which takes one statement alone and refuses a text of several as
 * it parses it, before anything runs, and which waits its turn on the connection as every query
 * does — with a null for each value, so that no value the statement runs with is refused there,
 * which the component's own query would refuse where its code can catch it. What else that plan is
 * refused — a function folded of a null it refuses — the statement's values may not be, and is let
 * be; in a transaction, which that refusal aborts, it is the render's, with PostgreSQL's reason.
 * `plan` answers its generic plan, of no values, through `exec`: a plan of values may fold away
 * a table a later value reads (`$1 = 'owner'` of `'viewer'`), and the plan is kept for the text.
 */
export interface Planner {
  /** The PGlite scheduler owner: a transaction can hold the main connection's mutex. */
  readonly owner: Connection;
  readonly check: (explain: string, values: unknown) => Promise<void>;
  readonly plan: (
    explain: string,
    catalog: string | undefined,
  ) => Promise<{ readonly plan: unknown; readonly catalog: unknown }>;
}

/**
 * What PostgreSQL refuses a cursor's text of as it reads it: no query (`42601`) — a write, `SELECT
 * … INTO`, a text of several statements, or of no SQL — or a data-modifying `WITH` (`0A000`).
 */
export const REFUSED = new Set(['0A000', '42601']);

/**
 * What a transaction runs of its own, which reads nothing and no plan says, in the whole forms
 * Drizzle writes them: its options (`set transaction read only`), which it sets as it opens one,
 * and its savepoints, by which it nests one. Nothing else — a setting of the session's
 * (`set transaction.name = …`), a text of more statements — runs unplanned.
 */
export const OWN: readonly RegExp[] = [
  /^\s*set\s+transaction(?:\s+[a-z]+)+\s*$/iu,
  /^\s*savepoint\s+\w+\s*$/iu,
  /^\s*release\s+savepoint\s+\w+\s*$/iu,
  /^\s*rollback\s+to\s+savepoint\s+\w+\s*$/iu,
];

/**
 * How many statements' tables a connection keeps — a statement's text, made by code, repeats — how
 * many times a statement is planned while the query context changes under it — a host's change
 * moves it before and after it runs — and how much of a refused statement a fault shows.
 */
const LIMITS = { keptPlans: 1024, plans: 3, shownText: 80 } as const;

/** The scans of a statement's plan, and whether the schema was the same as it was asked. */
interface Planned {
  readonly scans: readonly TableScan[];
  readonly current: boolean;
}

/** A PGlite or one of its transactions, or a `pg` pool: what runs statements, by its methods. */
export interface Connection {
  readonly query: unknown;
  readonly exec?: unknown;
}

/**
 * The scans each statement's text reads, as one connection asked PostgreSQL once, and what the
 * catalog says of the followed tables, asked with the first plan — each kept while the schema
 * stays as it was when it was asked (`Followed.schema`).
 */
export class Plans {
  readonly #followed: Followed;
  readonly #bound: Bound;
  readonly #kept = new Map<string, readonly TableScan[]>();
  #catalog: Catalog | undefined;
  /** A catalog asked by each scheduler owner; a transaction never awaits the mutex it holds. */
  readonly #asking = new WeakMap<Connection, Promise<void>>();
  #generation = 0;

  constructor(followed: Followed, bound: Bound) {
    this.#followed = followed;
    this.#bound = bound;
  }

  /** Moves the context counter, which every plan and page reads. */
  #contextChanged(): void {
    this.#followed.schema.generation += 1;
    this.#followed.schema.context = (this.#followed.schema.context ?? 0) + 1;
  }

  /** The followed table `relation` is; a fault for one nothing follows. */
  #tableOf(relation: Relation): string {
    const table = this.#followed.byRelation.get(relationKey(relation));
    if (table === undefined) {
      throw new Error(
        `A render read ${relationKey(relation)}, which reactive-state does not follow: give its table in the schema \`followDrizzle\` is given, or read it outside the render.`,
      );
    }
    if (this.#catalog?.unsupported?.has(table) === true) {
      throw new Error(
        `A render reads no table of an inheritance or partition hierarchy: ${relationKey(relation)}. Its statement triggers cannot capture every write a scan observes.`,
      );
    }
    return table;
  }

  /**
   * The scans of `plan`, the plan of `sql`, by the tables they read; a fault for a plan that writes
   * or locks rows, or reads a table nothing follows.
   */
  #scansOfPlan(sql: string, plan: PlanReads): readonly TableScan[] {
    const catalog = this.#catalog;
    if (catalog === undefined) {
      throw new Error(
        'The query catalog changed while a render was being planned: read the render again.',
      );
    }
    if (changesContext(sql, catalog.conforming === true)) {
      throw new Error(
        'A render changes no query context: SET, RESET, DISCARD and set_config belong outside a render. Unicode-escaped identifiers and ambiguous string syntax are not admitted.',
      );
    }
    if (
      catalog.temporaryBody === true ||
      namesTemporaryRowType(sql, catalog.temporaryTypes ?? [], catalog.conforming === true) ||
      unknownTypeCast(
        sql,
        catalog.castTypes ?? [],
        catalog.conforming === true,
        catalog.typeKeywords,
      )
    ) {
      throw new Error(
        'A render reads no temporary table row type, unknown cast type or unproven typed table clause, directly or through a known string-body SQL function: staging-table DDL does not follow that type.',
      );
    }
    if (namesTypeByText(sql, catalog.conforming === true, catalog.typeKeywords)) {
      throw new Error(
        'A render names no type or relation by text, by `to_regtype`, `pg_input_is_valid` or a cast to `regtype`, `regclass`, `regprocedure` or `regoperator`: a temporary one changes with nothing to count.',
      );
    }
    if (plan.writes) {
      throw new Error(
        `A component writes nothing as it renders: ${sql.slice(0, LIMITS.shownText)}`,
      );
    }
    if (plan.locks) {
      throw new Error(
        `A component locks no rows as it renders, which a server operation does: ${sql.slice(0, LIMITS.shownText)}`,
      );
    }
    for (const relation of plan.relations) {
      this.#tableOf(relation);
    }
    // A statement that names a table's columns otherwise: its plan's names may be other columns'.
    const renamed = renamesColumns(sql, this.#catalog?.conforming === true);
    return Array.from(plan.scans, (scan) => this.#tableScanOf(scan, renamed));
  }

  /** One scan of a plan, by the table it reads: of no condition, where its columns are `renamed`. */
  #tableScanOf(scan: Scan, renamed: boolean): TableScan {
    return { conditions: renamed ? [] : scan.conditions, table: this.#tableOf(scan.relation) };
  }

  /**
   * The scans `sql` reads, by its plan, asked again while the query context changed as it was
   * asked: admission metadata of another context proves no read, and a fresh plan reads its own.
   */
  async #scansOf(sql: string, values: unknown, planner: Planner): Promise<Planned> {
    for (let attempt = 1; attempt <= LIMITS.plans; attempt += 1) {
      const planned = await this.#plannedOnce(sql, values, planner);
      if (planned !== undefined) return planned;
    }
    throw new Error(
      'The query context changed each time a render was being planned: read the render again.',
    );
  }

  /**
   * The scans `sql` reads, by its plan, which `planner` answers once a text — the catalog with the
   * first; the texts asked least lately are the first a full connection forgets. Nothing where the
   * query context changed as it was asked.
   */
  async #plannedOnce(sql: string, values: unknown, planner: Planner): Promise<Planned | undefined> {
    const { generation } = this.#followed.schema;
    if (generation !== this.#generation) {
      this.#kept.clear();
      this.#catalog = undefined;
      this.#generation = generation;
    }
    const kept = this.#kept.get(sql);
    if (kept !== undefined) {
      this.#kept.delete(sql);
      this.#kept.set(sql, kept);
      return { current: true, scans: kept };
    }
    const explain = explainSql(sql);
    try {
      await planner.check(explain, values);
    } catch (error) {
      throw REFUSED.has(String(codeOf(error))) ? refusedText(sql, error) : error;
    }
    // Statements of the same scheduler owner share admission metadata. A transaction must never
    // wait for a main-connection plan that may itself be waiting for that transaction's mutex.
    const pending = this.#asking.get(planner.owner);
    if (pending !== undefined) await pending;
    const asked = this.#catalog === undefined ? catalogSql(this.#followed) : undefined;
    let answered: Awaited<ReturnType<Planner['plan']>>;
    let ready: ((value: undefined) => void) | undefined;
    if (asked !== undefined) {
      const { promise, resolve } = Promise.withResolvers<undefined>();
      ready = resolve;
      this.#asking.set(planner.owner, promise);
    }
    try {
      answered = await planner.plan(explain, asked);
      if (asked !== undefined && this.#followed.schema.generation === generation) {
        this.#catalog = catalogOf(answered.catalog, this.#followed);
      }
    } finally {
      if (asked !== undefined) {
        this.#asking.delete(planner.owner);
        ready?.(undefined);
      }
    }
    // Admission metadata asked across a context change cannot establish a safe read.
    const current = this.#followed.schema.generation === generation;
    if (!current) return undefined;
    const scans = this.#scansOfPlan(sql, planReads(answered.plan));
    if (this.#kept.size >= LIMITS.keptPlans) {
      const [oldest] = this.#kept.keys();
      if (oldest !== undefined) this.#kept.delete(oldest);
    }
    this.#kept.set(sql, scans);
    return { current, scans };
  }

  /**
   * An observed context mutation outside renders invalidates plans on either side of its SQL,
   * though it fails or a transaction later rolls it back. The follower reads the context counter
   * on every page, so a change and change back within a digest interval still invalidates views.
   */
  async outsideContext(run: () => unknown): Promise<unknown> {
    this.#contextChanged();
    try {
      return await run();
    } finally {
      this.#contextChanged();
    }
  }

  /** As `outsideContext`, of a call that answers at once and is to go on doing so. */
  outsideContextNow(run: () => unknown): unknown {
    this.#contextChanged();
    try {
      return run();
    } finally {
      this.#contextChanged();
    }
  }

  /** Transaction completion restores LOCAL settings after their observed mutation. */
  async outsideTransaction(run: () => unknown): Promise<unknown> {
    const context = this.#followed.schema.context;
    try {
      return await run();
    } finally {
      if (this.#followed.schema.context !== context) this.#contextChanged();
    }
  }

  /** Whether a host's SQL may change the context, whose string settings may not be known yet. */
  observesContext(sql: string): boolean {
    return changesContext(sql, this.#catalog?.conforming === true);
  }

  /** Whether a text run on one connection of many changes its session (`changesSession`). */
  changesOneSession(sql: string): boolean {
    return changesSession(sql, this.#catalog?.conforming === true);
  }

  /** Whether a text run on a checked-out connection changes its settings beyond a transaction. */
  leavesSession(sql: string): boolean {
    return leavesSession(sql, this.#catalog?.conforming === true);
  }

  /** What `sql`, a text of a checked-out connection's, does of the settings its transaction holds. */
  scopedAfter(sql: string, before: boolean): Scoped {
    return scopedAfter(sql, this.#catalog?.conforming === true, before);
  }

  /** Whether a text run on one connection of many leaves a transaction open on it. */
  leavesTransactionOpen(sql: string): boolean {
    return leavesTransactionOpen(sql, this.#catalog?.conforming === true);
  }

  /**
   * What `sql`, run with `values`, reads of the followed tables: the records its scans name — of no
   * condition on its values where its options bind them otherwise than the plan types them
   * (`rebound`), nor on one the connection sends as other text (`boundOf`).
   */
  async readsOf(
    sql: string,
    values: unknown,
    planner: Planner,
    rebound: boolean,
  ): Promise<readonly TableRead[]> {
    const { current, scans } = await this.#scansOf(sql, values, planner);
    const catalog = current ? (this.#catalog ?? NO_CONDITIONS) : NO_CONDITIONS;
    // The schema's table too: a change of the schema renders the statement again, though its plan
    // folded every table away (`WHERE f()` of a function that answered `false`).
    return [
      ...readsOf(
        scans,
        { bound: rebound ? NOTHING_BOUND : this.#bound, values },
        this.#followed,
        catalog,
      ),
      { schema: true, table: this.#followed.schemaTable, where: {} },
    ];
  }
}

/** Calls `connection`'s method `name`, as the connection holds it now. */
export function called(
  connection: Connection,
  name: PropertyKey,
  args: readonly unknown[],
): unknown {
  const found: unknown = Reflect.get(connection, name);
  if (typeof found !== 'function') {
    throw new TypeError(`A connection has a \`${String(name)}\` method.`);
  }
  const answered: unknown = Reflect.apply(found, connection, args);
  return answered;
}

/** Why a render may not call `name`: a statement whose reads no plan says. */
export function refusedCall(name: PropertyKey): Promise<never> {
  return Promise.reject(
    new Error(
      `A render runs its SQL through \`query\`, whose plan says what it read, never \`${String(name)}\`.`,
    ),
  );
}

/** Why a render may not run `sql`, as PostgreSQL refused it as a cursor's (`error`). */
function refusedText(sql: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `A component runs a query alone as it renders, which writes nothing — a write, SELECT … INTO and a text of several statements are a server operation's: ${reason}: ${sql.slice(0, LIMITS.shownText)}`,
    { cause: error },
  );
}

/** The SQLSTATE a PostgreSQL error carries, where it carries one. */
export function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
}

/** The rows of one result of a text of statements. */
function rowsOf(result: unknown): unknown {
  return typeof result === 'object' && result !== null ? Reflect.get(result, 'rows') : undefined;
}

/**
 * What a text of statements answered of a plan asked with the catalog before it, where it was: the
 * catalog's rows first, the plan's last.
 */
export function answerOf(
  results: unknown,
  catalog: string | undefined,
): { readonly plan: unknown; readonly catalog: unknown } {
  const all = Array.isArray(results) ? (results as unknown[]) : [];
  return {
    catalog: catalog === undefined ? undefined : rowsOf(all[0]),
    plan: rowsOf(all.at(-1)),
  };
}
