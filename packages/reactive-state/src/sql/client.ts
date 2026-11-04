import { type TableRead, tableReads } from '../server/context.ts';
import { type Relation, relationKey } from './capture.ts';
import { type Catalog, catalogOf, catalogSql, NO_CONDITIONS } from './catalog.ts';
import type { Followed } from './keys.ts';
import { explainSql, type PlanReads, planReads, type Scan } from './plans.ts';
import { readsOf, type TableScan } from './reads.ts';
import { renamesColumns } from './renames.ts';
import { type Bound, boundOf, NOTHING_BOUND } from './serialized.ts';

/**
 * A PGlite connection, as the application's Drizzle queries through it, whose queries in a render
 * note what they read: before a render's statement runs, its plan names the tables it reads, and
 * the render depends on each — any change the log tells of one renders it again. Outside a render —
 * a server operation, the host's migrations — a query runs as it would have. In a render, a
 * statement that is no query, a plan that writes, and a table nothing follows are faults: what the
 * render would read could change without the log telling of it. So is any method of the
 * connection but `query` and `transaction`, which Drizzle runs a render's SQL through: `exec`,
 * `sql`, the raw protocol, `listen`, `describeQuery`, a `clone` — each runs SQL no plan is asked of,
 * or off the connection's turn.
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
interface Planner {
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
const REFUSED = new Set(['0A000', '42601']);

/**
 * What a transaction runs of its own, which reads nothing and no plan says, in the whole forms
 * Drizzle writes them: its options (`set transaction read only`), which it sets as it opens one,
 * and its savepoints, by which it nests one. Nothing else — a setting of the session's
 * (`set transaction.name = …`), a text of more statements — runs unplanned.
 */
const OWN: readonly RegExp[] = [
  /^\s*set\s+transaction(?:\s+[a-z]+)+\s*$/iu,
  /^\s*savepoint\s+\w+\s*$/iu,
  /^\s*release\s+savepoint\s+\w+\s*$/iu,
  /^\s*rollback\s+to\s+savepoint\s+\w+\s*$/iu,
];

/**
 * How many statements' tables a connection keeps — a statement's text, made by code, repeats — and
 * how much of a refused statement a fault shows.
 */
const LIMITS = { keptPlans: 1024, shownText: 80 } as const;

/** The scans of a statement's plan, and whether the schema was the same as it was asked. */
interface Planned {
  readonly scans: readonly TableScan[];
  readonly current: boolean;
}

/** A PGlite, or one of its transactions: what runs statements, by its methods. */
export interface Connection {
  readonly query: unknown;
  readonly exec: unknown;
}

/**
 * The scans each statement's text reads, as one connection asked PostgreSQL once, and what the
 * catalog says of the followed tables, asked with the first plan — each kept while the schema
 * stays as it was when it was asked (`Followed.schema`).
 */
class Plans {
  readonly #followed: Followed;
  readonly #bound: Bound;
  readonly #kept = new Map<string, readonly TableScan[]>();
  #catalog: Catalog | undefined;
  /** Whether a plan carries the catalog's statement now: the plans asked beside it carry none. */
  #asking = false;
  #generation = 0;

  constructor(followed: Followed, bound: Bound) {
    this.#followed = followed;
    this.#bound = bound;
  }

  /** The followed table `relation` is; a fault for one nothing follows. */
  #tableOf(relation: Relation): string {
    const table = this.#followed.byRelation.get(relationKey(relation));
    if (table === undefined) {
      throw new Error(
        `A render read ${relationKey(relation)}, which reactive-state does not follow: give its table in the schema \`followDrizzle\` is given, or read it outside the render.`,
      );
    }
    return table;
  }

  /**
   * The scans of `plan`, the plan of `sql`, by the tables they read; a fault for a plan that writes
   * or locks rows, or reads a table nothing follows.
   */
  #scansOfPlan(sql: string, plan: PlanReads): readonly TableScan[] {
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
   * The scans `sql` reads, by its plan, which `planner` answers once a text — the catalog with the
   * first; the texts asked least lately are the first a full connection forgets.
   */
  async #scansOf(sql: string, values: unknown, planner: Planner): Promise<Planned> {
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
    // One plan carries the catalog's statement: a plan asked beside it, before its answer, reads its
    // tables by no condition (`NO_CONDITIONS`) where the catalog is not yet known.
    const asked =
      this.#catalog === undefined && !this.#asking ? catalogSql(this.#followed) : undefined;
    if (asked !== undefined) this.#asking = true;
    let answered: Awaited<ReturnType<Planner['plan']>>;
    try {
      answered = await planner.plan(explain, asked);
    } finally {
      if (asked !== undefined) this.#asking = false;
    }
    // A plan asked as the schema changed may say what it is no more: read whole, and kept not.
    const current = this.#followed.schema.generation === generation;
    if (asked !== undefined && current) {
      this.#catalog ??= catalogOf(answered.catalog, this.#followed);
    }
    const scans = this.#scansOfPlan(sql, planReads(answered.plan, this.#followed.namespace));
    if (!current) {
      return { current, scans };
    }
    if (this.#kept.size >= LIMITS.keptPlans) {
      const [oldest] = this.#kept.keys();
      if (oldest !== undefined) this.#kept.delete(oldest);
    }
    this.#kept.set(sql, scans);
    return { current, scans };
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
      { table: this.#followed.schemaTable, where: {} },
    ];
  }
}

/** Calls `connection`'s method `name`, as the connection holds it now. */
function called(connection: Connection, name: PropertyKey, args: readonly unknown[]): unknown {
  const found: unknown = Reflect.get(connection, name);
  if (typeof found !== 'function') {
    throw new TypeError(`A PGlite connection has a \`${String(name)}\` method.`);
  }
  const answered: unknown = Reflect.apply(found, connection, args);
  return answered;
}

/** Why a render may not call `name`: a statement whose reads no plan says. */
function refusedCall(name: PropertyKey): Promise<never> {
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

/**
 * Whether a query's options bind its values otherwise than PostgreSQL types them in the plan of no
 * values: of types of their own (`paramTypes`), or by text of their own (`serializers`), as PGlite
 * takes them. No condition of such a query's values is followed.
 */
function rebinds(options: unknown): boolean {
  return (
    typeof options === 'object' &&
    options !== null &&
    (Reflect.get(options, 'paramTypes') !== undefined ||
      Reflect.get(options, 'serializers') !== undefined)
  );
}

/** The SQLSTATE a PostgreSQL error carries, where it carries one. */
function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
}

/** The rows of one of `exec`'s results. */
function rowsOf(result: unknown): unknown {
  return typeof result === 'object' && result !== null ? Reflect.get(result, 'rows') : undefined;
}

/**
 * What `exec` answered of a plan asked with the catalog before it, where it was: the catalog's rows
 * first, the plan's last.
 */
function answerOf(
  results: unknown,
  catalog: string | undefined,
): { readonly plan: unknown; readonly catalog: unknown } {
  const all = Array.isArray(results) ? (results as unknown[]) : [];
  return {
    catalog: catalog === undefined ? undefined : rowsOf(all[0]),
    plan: rowsOf(all.at(-1)),
  };
}

/** `connection`, a PGlite or one of its transactions, its queries in a render noted by `plans`. */
function tracked<C extends Connection>(connection: C, plans: Plans, transaction = false): C {
  const planner: Planner = {
    check: async (explain, values) => {
      const nulls = Array.isArray(values) ? values.map(() => null) : [];
      try {
        await called(connection, 'query', [explain, nulls]);
      } catch (error) {
        if (transaction || REFUSED.has(String(codeOf(error)))) {
          throw error;
        }
      }
    },
    // The catalog's statement goes first: the plan's text ends with the application's, whose
    // comment would else take in what came after it.
    plan: async (explain, catalog) => {
      const text = catalog === undefined ? explain : `${catalog}; ${explain}`;
      return answerOf(await called(connection, 'exec', [text]), catalog);
    },
  };
  /** A method a render may not call: a fault of the render's, whatever its code does with it. */
  const refusedInRender = (name: PropertyKey) => {
    return (...args: unknown[]): unknown => {
      const noted = tableReads();
      return noted === undefined ? called(connection, name, args) : noted(() => refusedCall(name));
    };
  };
  const wrapped: Readonly<Record<string, unknown>> = {
    query: async (sql: unknown, ...rest: unknown[]) => {
      const noted = tableReads();
      if (
        noted !== undefined &&
        !(transaction && typeof sql === 'string' && OWN.some((form) => form.test(sql)))
      ) {
        await noted(() => {
          if (typeof sql !== 'string') {
            return Promise.reject(new TypeError('A render queries by the text of its statement.'));
          }
          return plans.readsOf(sql, rest[0], planner, rebinds(rest[1]));
        });
      }
      return called(connection, 'query', [sql, ...rest]);
    },
    transaction: (body: unknown, ...rest: unknown[]) => {
      const run =
        typeof body === 'function'
          ? (opened: Connection): unknown => {
              const answered: unknown = Reflect.apply(body, undefined, [
                tracked(opened, plans, true),
              ]);
              return answered;
            }
          : body;
      return called(connection, 'transaction', [run, ...rest]);
    },
  };
  return new Proxy(connection, {
    // Read from the connection itself: its getters may read private fields, which a proxy has none of.
    get: (target, key) => {
      if (typeof key === 'string' && Object.hasOwn(wrapped, key)) {
        return wrapped[key];
      }
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') {
        return value;
      }
      // Any other method, by a name or a symbol: the connection's own outside a render, a fault in
      // one.
      return refusedInRender(key);
    },
  });
}

/**
 * `connection`, a PGlite the application's Drizzle is given, whose renders note what they read of
 * `followed`'s tables: the same connection, by its own type, for `drizzle({ client })`.
 */
export function trackedClient<C extends Connection>(connection: C, followed: Followed): C {
  return tracked(connection, new Plans(followed, boundOf(connection)));
}
