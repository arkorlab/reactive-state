import { type TableRead, tableReads } from '../../server/context.ts';
import { bytecodeReads, type Instruction, type SchemaEntry } from './bytecode.ts';
import type { SqliteKeyColumn, SqliteKeyKind } from './keys.ts';
import { type StatementRead, statementRead } from './scopes.ts';
import {
  COLLATED,
  type ColumnTypes,
  type PlanAnswers,
  readsApart,
  sourcesOf,
  tablesNamed,
  wheresTogether,
} from './sources.ts';
import { holdsKind, sqliteKeyText } from './values.ts';
import {
  BYTE_ORDER_MARK,
  type Conditions,
  conditionsOf,
  leadingWord,
  namesPragmaFunction,
  readsAlone,
  soleStatement,
  type Term,
} from './where.ts';

/**
 * A D1 binding whose statements a render runs note what they read of the followed tables: each
 * statement's tables, as its bytecode says (`bytecode.ts`), and the rows its conditions name by the
 * tables' keys: of a statement of one table (`where.ts`), and of a join or a subquery scope by scope
 * (`scopes.ts`, `closure.ts`, `sources.ts`). The plan of a text is asked once, in one batch beside
 * nothing else, and kept while the schema stays as it was; a statement that begins with `SELECT`,
 * which writes nothing, runs as its plan is asked, so that a render waits for no more than the slower
 * of the two. A statement that writes is refused before it runs, and so is a text of several
 * statements, which D1 runs each of. The plans are of one database: every binding a follow is given
 * is of the database its store reads. Outside a render, the binding is as it is.
 */

/** A followed table of SQLite, as a render's reads name it. */
export interface FollowedSqlite {
  /** The table each followed table of the database is declared as, by its name in the database. */
  readonly byName: ReadonlyMap<string, string>;
  readonly keysByTable: ReadonlyMap<string, readonly SqliteKeyColumn[]>;
  /** The table every statement reads beside what its plan names, of a change of the schema. */
  readonly schemaTable: string;
  readonly schema: { generation: number };
}

/** A statement of D1's, as much of it as is run: bound, and answered by each of its methods. */
interface D1Statement {
  readonly bind: (...values: unknown[]) => D1Statement;
}

/**
 * A D1 binding, as much of it as a render's statements run through: of methods, which a binding of
 * its own statements' types (`D1Database`) is one of.
 */
export interface D1Binding {
  prepare(sql: string): unknown;
  batch(statements: unknown[]): Promise<readonly unknown[]>;
}

/** A term of a plan: a key's field, how its value is written, and the parameters it is equal to. */
interface KeyTerm {
  readonly field: string;
  readonly kind: SqliteKeyKind;
  readonly params: readonly number[];
}

/** A statement of D1's, as `all` runs it alone. */
interface D1Run {
  readonly all: () => Promise<unknown>;
}

/**
 * The tables a statement reads, as its plan says, and of a table it reads by its keys, the terms of
 * each time it reads it: a read of none is of the table whole.
 */
interface Plan {
  readonly tables: readonly string[];
  readonly keyed?: ReadonlyMap<string, readonly (readonly KeyTerm[])[]> | undefined;
  /** When the plan is asked again, where it is kept for a while alone: of a batch that failed. */
  readonly until?: number | undefined;
}

/**
 * How many plans a binding keeps, how many of a read's records its conditions name at most, and for
 * how long a D1 that answered no `EXPLAIN` is asked none.
 */
const LIMITS = { keptPlans: 1024, shownText: 80, unexplainedMs: 60_000, wheres: 32 } as const;
/** The schema's tables and indexes, by their root pages, and each table's own statement. */
const SCHEMA_SQL =
  "SELECT type, name, tbl_name, rootpage, sql FROM sqlite_schema WHERE type IN ('table', 'index')";
/**
 * The words a render's statement begins with: a query's, and a write's, which its plan refuses. A
 * text of another, of which `EXPLAIN` makes a statement of another kind, is refused by its words.
 */
const STATEMENTS = new Set(['delete', 'insert', 'replace', 'select', 'update', 'values', 'with']);

/** A statement that begins with `SELECT`, which writes nothing in SQLite. */
const READS_ONLY = /^\s*select\b/iu;
/** How many answers of a plan's batch come before its tables' columns: `EXPLAIN`, the schema. */
const PLAN_ANSWERS = 2;

/** What a statement's text says, which its plan is asked and read by. */
interface StatementText {
  readonly conditions: Conditions | undefined;
  /** The tables it names, each of whose columns the plan asks. */
  readonly named: readonly string[];
  readonly scoped: StatementRead | undefined;
}

/** What `sql` says: a statement of one table, or one read scope by scope. */
function textOf(sql: string): StatementText {
  const conditions = conditionsOf(sql);
  if (conditions !== undefined) return { conditions, named: [conditions.table], scoped: undefined };
  const scoped = statementRead(sql);
  return { conditions, named: tablesNamed(scoped), scoped };
}

/** An SQL identifier, quoted. */
function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The rows of a batch's result, as D1 answers them. */
function rowsOf(result: unknown): readonly Readonly<Record<string, unknown>>[] {
  const rows: unknown =
    typeof result === 'object' && result !== null ? Reflect.get(result, 'results') : undefined;
  return Array.isArray(rows) ? (rows as Readonly<Record<string, unknown>>[]) : [];
}

/** The schema's entries of a batch's result. */
function schemaOf(result: unknown): readonly SchemaEntry[] {
  return rowsOf(result).map((row) => {
    return {
      name: String(row['name']),
      rootpage: Number(row['rootpage']),
      sql: typeof row['sql'] === 'string' ? row['sql'] : null,
      tableName: String(row['tbl_name']),
      type: String(row['type']),
    };
  });
}

/** Each column's declared type of a batch's result of `PRAGMA table_info`, by the column's name. */
function columnTypesOf(result: unknown): ColumnTypes {
  const types = new Map<string, string>();
  for (const row of rowsOf(result)) {
    types.set(String(row['name']), typeof row['type'] === 'string' ? row['type'] : '');
  }
  return types;
}

/** The instructions of a batch's result of `EXPLAIN`. */
function instructionsOf(result: unknown): readonly Instruction[] {
  return rowsOf(result).map((row) => {
    return {
      opcode: String(row['opcode']),
      p1: row['p1'],
      p2: row['p2'],
      p3: row['p3'],
    };
  });
}

/** Each value's text of a term of `kind`, or nothing where one is no key's text. */
function textsOf(term: KeyTerm, values: readonly unknown[]): readonly string[] | undefined {
  const texts = term.params.map((at) => sqliteKeyText(term.kind, values[at]));
  return texts.includes(undefined) ? undefined : (texts as readonly string[]);
}

/**
 * The records `terms` name of `values`: each of their combinations, as many as `LIMITS.wheres` at
 * most — of a term of more values left out, which reads more, never fewer — or every record.
 */
function wheresOf(
  terms: readonly KeyTerm[],
  values: readonly unknown[],
): readonly Readonly<Record<string, string>>[] {
  const named = new Map<string, readonly string[]>();
  for (const term of terms) {
    const texts = textsOf(term, values);
    // A second term of one key holds of fewer rows than the first: the first names them all.
    if (texts !== undefined && !named.has(term.field)) named.set(term.field, texts);
  }
  const sorted = [...named].toSorted(([, a], [, b]) => a.length - b.length);
  let wheres: Record<string, string>[] = [{}];
  for (const [field, texts] of sorted) {
    if (wheres.length * texts.length > LIMITS.wheres) break;
    wheres = wheres.flatMap((where) => texts.map((text) => ({ ...where, [field]: text })));
  }
  return wheres;
}

/**
 * The plans of one binding's statements, by their texts — each kept while the schema stays as it
 * was when it was asked, and asked once of the statements that run at once — and when D1 last
 * answered no `EXPLAIN` at all.
 */
class SqlitePlans {
  readonly #followed: FollowedSqlite;
  readonly #kept = new Map<string, Plan>();
  /** The plans being asked, by their texts: what a statement of a text being asked awaits. */
  readonly #asking = new Map<string, Promise<Plan | undefined>>();
  #generation = 0;
  #unexplainedAt: number | undefined;
  #warned = false;
  #planWarned = false;
  /** The probe of `EXPLAIN SELECT 1` being asked: what each batch that failed meanwhile awaits. */
  #probing: Promise<boolean> | undefined;

  constructor(followed: FollowedSqlite) {
    this.#followed = followed;
  }

  /** The followed table `name` is declared as; a fault for one nothing follows. */
  #declared(name: string): string {
    const table = this.#followed.byName.get(name);
    if (table === undefined) {
      throw new Error(
        `A render read ${name}, which reactive-state does not follow: give its table in the schema \`followDrizzle\` is given, or read it outside the render.`,
      );
    }
    return table;
  }

  /** Every followed table, read whole: what a statement reads that its plan does not say. */
  #everyTable(): Plan {
    return { tables: [...new Set(this.#followed.byName.values())] };
  }

  /** The terms of `table` that are of its keys, as its columns, `declared`, hold them. */
  #keyTerms(
    table: string,
    terms: readonly Term[],
    schema: readonly SchemaEntry[],
    declared: ColumnTypes,
  ): readonly KeyTerm[] {
    const keys = this.#followed.keysByTable.get(table) ?? [];
    const own = schema.find(
      (entry) => entry.type === 'table' && this.#followed.byName.get(entry.name) === table,
    );
    // A collation of the table's own may find two texts equal: no text key is followed of it.
    const collated = COLLATED.test(own?.sql ?? '');
    return terms.flatMap((term) => {
      const key = keys.find((each) => each.column === term.column);
      const type = declared.get(term.column);
      if (key === undefined || type === undefined || !holdsKind(key.kind, type)) return [];
      if (collated && key.kind === 'text') return [];
      return [{ field: key.field, kind: key.kind, params: term.params }];
    });
  }

  /** Whether D1 answered no `EXPLAIN` lately: within `LIMITS.unexplainedMs`, after which it is asked again. */
  #unexplained(): boolean {
    return (
      this.#unexplainedAt !== undefined && Date.now() - this.#unexplainedAt < LIMITS.unexplainedMs
    );
  }

  /**
   * Whether D1 answers `EXPLAIN` at all, as it answers that of `SELECT 1`, asked once of the
   * batches that failed at once. Where it answers not — it refuses one, or failed twice running —
   * every statement reads every followed table for a while.
   */
  async #explains(binding: D1Binding): Promise<boolean> {
    if (this.#probing !== undefined) return this.#probing;
    this.#probing = this.#probe(binding);
    try {
      return await this.#probing;
    } finally {
      this.#probing = undefined;
    }
  }

  /** Whether D1 answers `EXPLAIN SELECT 1`; of no answer, D1 answers no `EXPLAIN` lately. */
  async #probe(binding: D1Binding): Promise<boolean> {
    try {
      await (binding.prepare('EXPLAIN SELECT 1') as D1Run).all();
      return true;
    } catch (error) {
      this.#unexplainedAt = Date.now();
      if (!this.#warned) {
        this.#warned = true;
        // eslint-disable-next-line no-console
        console.warn(
          `reactive-state: D1 answered no EXPLAIN, so a render's statements read every followed table whole for a while: ${String(error)}`,
        );
      }
      return false;
    }
  }

  /**
   * Says once that plans fail while D1 answers `EXPLAIN`, where nothing else would: each render
   * stays right, reading every followed table, and what it costs shows on no page.
   */
  #warnUnplanned(sql: string, error: unknown): void {
    if (this.#planWarned) return;
    this.#planWarned = true;
    // eslint-disable-next-line no-console
    console.warn(
      `reactive-state: D1 failed the plan of \`${sql.slice(0, LIMITS.shownText)}\`, so a render's statements read every followed table whole for a while: ${String(error)}`,
    );
  }

  /**
   * The plan of `sql`, which `binding` is asked of with `values`: of a statement that reads — one
   * that begins with `SELECT`, or reads by its words — whose plan's batch failed, every followed
   * table for a while; none, of one that reads while D1 answers no `EXPLAIN`, which then reads
   * every followed table and is asked again the next time.
   */
  async #asked(
    sql: string,
    values: readonly unknown[],
    binding: D1Binding,
  ): Promise<Plan | undefined> {
    if (this.#unexplained()) {
      // Of no plan, a statement is a read by its words alone: of none a statement that writes holds.
      if (!READS_ONLY.test(sql) && !readsAlone(sql)) throw writes(sql);
      return undefined;
    }
    const text = textOf(sql);
    const statement = (asking: string): D1Statement => binding.prepare(asking) as D1Statement;
    const asked = [statement(`EXPLAIN ${sql}`).bind(...values), statement(SCHEMA_SQL)];
    for (const table of text.named) {
      asked.push(statement(`PRAGMA table_info(${quoted(table)})`));
    }
    let answers: readonly unknown[];
    try {
      answers = await binding.batch(asked);
    } catch (error) {
      if (!(await this.#explains(binding))) return this.#asked(sql, values, binding);
      // The statement's own failure, or the batch's: of one that writes nothing — a `SELECT`, or
      // a read by its words (`WITH … SELECT`) — its run tells, and it reads every table for a
      // while, so that its renders wait on no failing batch.
      if (READS_ONLY.test(sql) || readsAlone(sql)) {
        this.#warnUnplanned(sql, error);
        return { ...this.#everyTable(), until: Date.now() + LIMITS.unexplainedMs };
      }
      throw error;
    }
    return this.#planned(sql, text, answers);
  }

  /** The plan of `sql` of its batch's `answers`. */
  #planned(sql: string, text: StatementText, answers: readonly unknown[]): Plan {
    const { conditions, named, scoped } = text;
    const schema = schemaOf(answers[1]);
    const read = bytecodeReads(instructionsOf(answers[0]), schema);
    if (read.kind === 'writes') throw writes(sql);
    if (read.kind === 'unread' || read.virtuals > (scoped?.functions.length ?? 0)) {
      return this.#everyTable();
    }
    const tables = [...read.tables].map((name) => this.#declared(name));
    const columns = new Map(
      named.map((table, at) => [table, columnTypesOf(answers[at + PLAN_ANSWERS])]),
    );
    if (scoped !== undefined) {
      const { tables: opened, virtuals } = read;
      return this.#scopedPlan(scoped, { columns, opened, schema, virtuals }, tables);
    }
    if (conditions === undefined) return { tables };
    const only = this.#followed.byName.get(conditions.table);
    if (only === undefined || tables.some((table) => table !== only)) return { tables };
    const declared = columns.get(conditions.table) ?? new Map<string, string>();
    const terms = this.#keyTerms(only, conditions.terms, schema, declared);
    return { keyed: new Map([[only, [terms]]]), tables };
  }

  /**
   * The plan of a statement read scope by scope, of `tables` its bytecode opens: a source whose rows
   * no term restricts reads its table whole, beside what the table's other sources name.
   */
  #scopedPlan(read: StatementRead, answers: PlanAnswers, tables: readonly string[]): Plan {
    const reads = sourcesOf(read, answers);
    if (reads.kind === 'every') return this.#everyTable();
    if (reads.kind === 'whole') return { tables };
    const keyed = new Map<string, (readonly KeyTerm[])[]>();
    for (const { columns, table, terms } of reads.sources) {
      const declared = this.#declared(table);
      const of = keyed.get(declared) ?? [];
      keyed.set(declared, of);
      of.push(this.#keyTerms(declared, terms, answers.schema, columns));
    }
    return { keyed: new Map([...keyed].map(([table, of]) => [table, readsApart(of)])), tables };
  }

  /** The plan of `sql` as it is asked of `binding`: the ask under way of the text, or a new one. */
  async #shared(
    sql: string,
    values: readonly unknown[],
    binding: D1Binding,
  ): Promise<Plan | undefined> {
    let asking = this.#asking.get(sql);
    if (asking === undefined) {
      asking = this.#asked(sql, values, binding);
      this.#asking.set(sql, asking);
    }
    try {
      return await asking;
    } finally {
      if (this.#asking.get(sql) === asking) this.#asking.delete(sql);
    }
  }

  /** The plan of `sql`: kept, or asked of `binding`, and kept while the schema stays as it was. */
  async #planOf(sql: string, values: readonly unknown[], binding: D1Binding): Promise<Plan> {
    const { generation } = this.#followed.schema;
    if (generation !== this.#generation) {
      // An ask under way is of the schema before: a statement asks anew.
      this.#kept.clear();
      this.#asking.clear();
      this.#generation = generation;
    }
    const kept = this.#kept.get(sql);
    this.#kept.delete(sql);
    if (kept !== undefined && (kept.until === undefined || Date.now() < kept.until)) {
      this.#kept.set(sql, kept);
      return kept;
    }
    const plan = await this.#shared(sql, values, binding);
    // A plan asked as the schema changed may say what it is no more: read whole, and kept not.
    if (plan === undefined || this.#followed.schema.generation !== generation) {
      return this.#everyTable();
    }
    if (this.#kept.size >= LIMITS.keptPlans) {
      const [oldest] = this.#kept.keys();
      if (oldest !== undefined) this.#kept.delete(oldest);
    }
    this.#kept.set(sql, plan);
    return plan;
  }

  /** What `sql`, run with `values`, reads of the followed tables. */
  async readsOf(
    sql: string,
    values: readonly unknown[],
    binding: D1Binding,
  ): Promise<readonly TableRead[]> {
    const plan = await this.#planOf(sql, values, binding);
    const reads: TableRead[] = plan.tables.flatMap((table) => {
      const sources = plan.keyed?.get(table) ?? [[]];
      const wheres = sources.flatMap((terms) => wheresOf(terms, values));
      const named = sources.length > 1 ? wheresTogether(wheres, LIMITS.wheres) : wheres;
      return named.map((where) => ({ table, where }));
    });
    // The schema's table too: a change of the schema renders the statement again.
    return [...reads, { schema: true, table: this.#followed.schemaTable, where: {} }];
  }
}

/**
 * The fault of a render's statement its words refuse, before its plan is asked: a text of several
 * statements, which D1 runs each of; a `PRAGMA`, which sets the connection's flags as SQLite
 * compiles it — of its plan too; and a statement that names a `pragma_` function, of which
 * `pragma_optimize` writes as it is read, unseen by its plan.
 */
function refusalOf(prepared: readonly Prepared[]): Error | undefined {
  for (const { sql } of prepared) {
    const shown = sql.slice(0, LIMITS.shownText);
    const word = leadingWord(sql);
    if (!soleStatement(sql)) {
      return new Error(`A component runs one statement a text as it renders: ${shown}`);
    }
    // A space to SQLite where a token begins, and a name's character to this reading of it.
    if (sql.includes(BYTE_ORDER_MARK)) {
      return new Error(`A component runs no text of a byte order mark as it renders: ${shown}`);
    }
    if (word === 'pragma' || namesPragmaFunction(sql)) {
      return new Error(`A component runs no PRAGMA as it renders: ${shown}`);
    }
    // Of another word, `EXPLAIN` of the text may be a statement of its own: `QUERY PLAN PRAGMA …`.
    if (word === undefined || !STATEMENTS.has(word)) {
      return new Error(`A component runs a query alone as it renders: ${shown}`);
    }
  }
  return undefined;
}

/** The fault of a render's statement that writes. */
function writes(sql: string): Error {
  return new Error(`A component writes nothing as it renders: ${sql.slice(0, LIMITS.shownText)}`);
}

/** What a statement of the binding's is: its text, the values bound, and D1's own statement. */
interface Prepared {
  readonly sql: string;
  readonly values: readonly unknown[];
  readonly statement: D1Statement;
}

/** The statements a tracked binding made, as D1's own. */
const PREPARED = new WeakMap<WeakKey, Prepared>();
/** The plans of each follow's statements, of every binding it is given: one per render, often. */
const PLANS = new WeakMap<FollowedSqlite, SqlitePlans>();

/**
 * `run`, D1's answer of `prepared`, in a render once what it reads is noted: of a statement that
 * begins with `SELECT`, as its plan is asked; of any other, after it, which refuses one that writes.
 */
async function noted<T>(
  prepared: readonly Prepared[],
  plans: SqlitePlans,
  binding: D1Binding,
  run: () => Promise<T>,
): Promise<T> {
  const note = tableReads();
  if (note === undefined) return run();
  const refused = refusalOf(prepared);
  if (refused !== undefined) {
    await note(() => Promise.reject(refused));
    throw refused;
  }
  const reads = async (): Promise<readonly TableRead[]> => {
    const all = await Promise.all(
      prepared.map((each) => plans.readsOf(each.sql, each.values, binding)),
    );
    return all.flat();
  };
  if (prepared.every((each) => READS_ONLY.test(each.sql))) {
    // Both settled: a run that fails first answers once its reads are noted, so that a component
    // that catches the failure depends on what it read all the same.
    const [noting, answer] = await Promise.allSettled([note(reads), run()]);
    if (noting.status === 'rejected') throw noting.reason;
    if (answer.status === 'rejected') throw answer.reason;
    return answer.value;
  }
  await note(reads);
  return run();
}

/** `statement`, D1's of `sql` bound to `values`, as the tracked binding answers it. */
function tracked(prepared: Prepared, plans: SqlitePlans, binding: D1Binding): D1Statement {
  const { statement } = prepared;
  const answered = (name: string) => {
    return (...args: unknown[]): Promise<unknown> => {
      return noted([prepared], plans, binding, async () => {
        const answer: unknown = await Reflect.apply(
          Reflect.get(statement, name) as (...given: unknown[]) => unknown,
          statement,
          args,
        );
        return answer;
      });
    };
  };
  const own: D1Statement & Record<string, unknown> = {
    all: answered('all'),
    bind: (...values: unknown[]) => {
      const bound = { sql: prepared.sql, statement: statement.bind(...values), values };
      return tracked(bound, plans, binding);
    },
    first: answered('first'),
    raw: answered('raw'),
    run: answered('run'),
  };
  PREPARED.set(own, prepared);
  return own;
}

/** What notes a render's reads (`tableReads`), in a render. */
type Note = NonNullable<ReturnType<typeof tableReads>>;

/**
 * Notes `refused` as the render's fault, through `note`: what the evaluation answers of it is the
 * render's outcome, whatever its code does with the refusal it is answered.
 */
function noteFault(note: Note, refused: Error): void {
  const fault = (): Promise<never> => Promise.reject(refused);
  void note(fault).catch(() => {
    // Noted as the render's: the call's own answer is the refusal.
  });
}

/**
 * A method a render may not call: a fault of the render's, whatever its code does with it, noted
 * as such and thrown as the method is called, of a method that answers at once (`prepare`) too.
 */
function refusedInRender(
  target: unknown,
  name: PropertyKey,
  value: (...args: unknown[]) => unknown,
) {
  return (...args: unknown[]): unknown => {
    const note = tableReads();
    if (note === undefined) return Reflect.apply(value, target, args);
    const refused = new Error(
      `A render runs no D1 \`${String(name)}\`: query by statements, which are followed.`,
    );
    noteFault(note, refused);
    throw refused;
  };
}

/** What each object of a session's stands for — the session, a statement of it — D1's own. */
const SESSION_OWN = new WeakMap<WeakKey, unknown>();

/** `value` as D1's own: what an object of a session's stands for, or itself. */
function sessionOwn(value: unknown): unknown {
  return typeof value === 'object' && value !== null && SESSION_OWN.has(value)
    ? SESSION_OWN.get(value)
    : value;
}

/** `statement` as D1's own: the statement a tracked one stands for, a session's, or itself. */
function ownStatement(statement: unknown): unknown {
  const prepared =
    typeof statement === 'object' && statement !== null ? PREPARED.get(statement) : undefined;
  return prepared === undefined ? sessionOwn(statement) : prepared.statement;
}

/** `value` as D1's own, or each of a list of them, as a batch is given them. */
function ownOf(value: unknown): unknown {
  return Array.isArray(value) ? value.map((each) => ownStatement(each)) : ownStatement(value);
}

/**
 * `session`, of D1's Sessions API, whose methods a render may not call: its reads may be a
 * replica's, behind the log, and are noted not. So of what its methods answer: a statement it
 * prepared, one bound, outside a render too. Outside a render, each is D1's as it is.
 */
function refusedSession(session: unknown): unknown {
  if (typeof session !== 'object' || session === null || session instanceof Promise) {
    return session;
  }
  const held = new Proxy(session, {
    get: (target, key) => {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      const refused = refusedInRender(target, key, value as (...args: unknown[]) => unknown);
      return (...args: unknown[]): unknown =>
        refusedSession(refused(...args.map((each) => ownOf(each))));
    },
  });
  SESSION_OWN.set(held, session);
  return held;
}

/**
 * `binding`, a D1 binding the application's Drizzle is given, whose renders note what they read of
 * `followed`'s tables: the same binding, by its own type, for `drizzle(binding)`.
 */
export function trackedD1<B extends D1Binding>(binding: B, followed: FollowedSqlite): B {
  const plans = PLANS.get(followed) ?? new SqlitePlans(followed);
  PLANS.set(followed, plans);
  return new Proxy(binding, {
    get: (target, key) => {
      if (key === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql) as D1Statement;
          return tracked({ sql, statement, values: [] }, plans, target);
        };
      }
      if (key === 'batch') {
        return (statements: readonly unknown[]) => {
          const prepared = statements.map((each) =>
            typeof each === 'object' && each !== null ? PREPARED.get(each) : undefined,
          );
          const own = prepared.filter((each) => each !== undefined);
          if (own.length < statements.length) {
            const note = tableReads();
            if (note === undefined)
              return target.batch(statements.map((each) => ownStatement(each)));
            const refused = new Error(
              'A render batches the statements of its tracked D1 binding alone.',
            );
            noteFault(note, refused);
            return Promise.reject(refused);
          }
          return noted(own, plans, target, () => target.batch(own.map((each) => each.statement)));
        };
      }
      const value: unknown = Reflect.get(target, key);
      // An object's own methods (`toString`) are the binding's not, and are of no query; an object
      // the binding holds (`alwaysPrimarySession`) is held to a session's refusals.
      if (Object.hasOwn(Object.prototype, key)) return value;
      if (typeof value !== 'function') return refusedSession(value);
      const refused = refusedInRender(target, key, value as (...args: unknown[]) => unknown);
      // A session is refused in a render wherever it was opened: a module's, made outside one, too.
      if (key !== 'withSession') return refused;
      return (...args: unknown[]): unknown => {
        const opened = refused(...args);
        return tableReads() === undefined ? refusedSession(opened) : opened;
      };
    },
  });
}
