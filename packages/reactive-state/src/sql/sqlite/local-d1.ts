import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

import { parametersOf } from './where.ts';

/**
 * A D1 database of a file, for a process that has no D1 of Cloudflare's: the authority of
 * `reactive dev`, whose tables a SQLite file keeps between runs. A binding of D1's shape over
 * `node:sqlite`, which the application's Drizzle (`drizzle-orm/d1`) and the change log's store read
 * and write as they do a binding of Cloudflare's. It runs a call as D1 runs one: each statement of
 * its text, in a transaction of the call's own, so a statement of a transaction is refused, as a
 * batch is one in its place. It binds a value and answers one as D1 does, and words a failure as
 * D1 does. What D1's own rules refuse beside, it does not.
 */

/** What D1 answers of a statement it ran. */
interface LocalResult {
  readonly results: readonly unknown[];
  readonly success: true;
  readonly meta: { readonly changes: number; readonly last_row_id: number };
}

/** A statement of D1's, bound to its values. */
interface LocalStatement {
  /** Its text, which a batch leaves out where D1 finds it blank. */
  readonly sql: string;
  readonly bind: (...values: readonly unknown[]) => LocalStatement;
  readonly all: () => Promise<LocalResult>;
  readonly run: () => Promise<LocalResult>;
  readonly first: (column?: string) => Promise<unknown>;
  readonly raw: (options?: { readonly columnNames?: boolean }) => Promise<unknown[][]>;
  /** Runs the statement now, in the transaction of the batch it is one of. */
  readonly ran: () => LocalResult;
}

/** A binding of D1's shape over a file. */
export interface LocalD1 {
  readonly prepare: (sql: string) => LocalStatement;
  /** Runs `statements`, each of this binding's own, in one transaction, as D1 runs a batch. */
  readonly batch: (statements: unknown[]) => Promise<LocalResult[]>;
  /** Closes the file, once however often it is asked. */
  readonly close: () => void;
}

/**
 * What a connection has changed of rows, a trigger's writes too, and the row it last inserted, as
 * SQLite reads them: an integer of any size, which a key past 2^53 is, and is kept of the connection
 * after the write that made it.
 */
interface Counts {
  readonly total: bigint;
  readonly id: bigint;
}

/** What a text's last statement answered, as D1 answers it, and what the text changed. */
interface Answered {
  readonly columns: string[];
  readonly rows: unknown[][];
  readonly meta: LocalResult['meta'];
}

/** How much of a statement a refusal of it quotes. */
const SHOWN = { characters: 40 } as const;
/**
 * What a statement's text begins with before its words: white space, the end of an empty
 * statement, and comments of SQL's, each to its first end, as nothing after them is asked of the
 * match.
 */
const LEADING = /^(?:\s|;|--[^\n]*|\/\*[\s\S]*?\*\/)*/u;
/** The words of a statement of a transaction, which D1 runs none of. */
const TRANSACTION = /^(?:begin|commit|end|rollback|savepoint|release)\b/iu;
/** SQLite's code of a lock another connection holds. */
const BUSY = 5;
/** How long a start waits to ask again of a lock another process holds. */
const LOCK_RETRY_MS = 50;
/** The bytes D1 binds an array of numbers as, as a blob: those below this. */
const BYTES = 256;
/** What may follow a text's last statement, as D1 reads it: white space of ASCII's alone. */
const ENDED = /^[\t\n\v\f\r ]*$/u;
/** White space, as D1 reads it of a text it asks is blank. */
const WHITE = /\s/u;
/** The most bytes of a text D1 runs, as UTF-8, of the whole text where SQLite asks a statement's. */
const MAX_TEXT_BYTES = 100_000;
/** SQLite's code of a text past what it runs. */
const TOOBIG = 18;
/** D1's limits of SQLite's, which a statement past fails in SQLite's words, as on D1. */
const LIMITS = {
  column: 100,
  compoundSelect: 5,
  functionArg: 127,
  likePatternLength: 50,
  triggerDepth: 10,
  variableNumber: 100,
} as const;

/** SQLite's result codes, by their numbers: what D1 names in each error it answers. */
const PRIMARY_CODES: Readonly<Record<number, string>> = {
  1: 'SQLITE_ERROR',
  5: 'SQLITE_BUSY',
  13: 'SQLITE_FULL',
  18: 'SQLITE_TOOBIG',
  19: 'SQLITE_CONSTRAINT',
  20: 'SQLITE_MISMATCH',
  25: 'SQLITE_RANGE',
};
/** The extended codes of a constraint's failure, which D1 names after the primary one. */
const EXTENDED_CODES: Readonly<Record<number, string>> = {
  275: 'SQLITE_CONSTRAINT_CHECK',
  787: 'SQLITE_CONSTRAINT_FOREIGNKEY',
  1043: 'SQLITE_CONSTRAINT_FUNCTION',
  1299: 'SQLITE_CONSTRAINT_NOTNULL',
  1555: 'SQLITE_CONSTRAINT_PRIMARYKEY',
  1811: 'SQLITE_CONSTRAINT_TRIGGER',
  2067: 'SQLITE_CONSTRAINT_UNIQUE',
  2579: 'SQLITE_CONSTRAINT_ROWID',
  3091: 'SQLITE_CONSTRAINT_DATATYPE',
};
/** How many primary codes an extended code's number counts past (`(extended - primary) / 256`). */
const EXTENDED_STEP = 256;

/**
 * A failure of `node:sqlite` of `message` and `code`, in the words D1 answers it in — `D1_ERROR:
 * UNIQUE constraint failed: t.c: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)` — which what
 * reads a write's refusal tells it by, D1 answering no code of its own (`rows.ts`).
 */
function inD1Words(message: string, code: number): string {
  const primary = PRIMARY_CODES[code % EXTENDED_STEP] ?? 'SQLITE_ERROR';
  const extended = EXTENDED_CODES[code];
  const named = extended === undefined ? primary : `${primary} (extended: ${extended})`;
  return `D1_ERROR: ${message}: ${named}`;
}

/** Runs `body`, a failure of SQLite's in D1's words. */
function asD1<T>(body: () => T): T {
  try {
    return body();
  } catch (error) {
    const code: unknown = error instanceof Error ? Reflect.get(error, 'errcode') : undefined;
    if (typeof code !== 'number' || !(error instanceof Error)) throw error;
    throw new Error(inD1Words(error.message, code), { cause: error });
  }
}

/** A turn of the event loop, as each call of D1's answers no sooner. */
async function later(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Whether `value` is a byte, of an array D1 binds as a blob. */
function isByte(value: unknown): boolean {
  return typeof value === 'number' && value >= 0 && value < BYTES;
}

/** A number as JSON carries it, as D1's request and its answer do: of no infinity, nor a `-0`. */
function carried(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return value === 0 ? 0 : value;
}

/**
 * `value` as D1 binds it, or refused as D1 refuses it, at `bind`: a number or a text as it is, a
 * number as JSON carries it; a boolean as its number; an array of bytes, an `ArrayBuffer` or the
 * elements of a view of one, each a byte (`Array.from`), as a blob; and `null`. `node:sqlite` would
 * read an object as the names of parameters instead, and binds a boolean of its own from Node 24.21
 * alone.
 */
// eslint-disable-next-line sonarjs/function-return-type -- one of SQLite's types, of each value its own.
function boundOf(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number') return carried(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Array.isArray(value) && value.every((byte) => isByte(byte))) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    // Of a `DataView`, none: it has no elements to list.
    return Uint8Array.from(value as unknown as ArrayLike<number>);
  }
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- D1's words: `[object Object]` too.
  const shown = String(value);
  throw new Error(`D1_TYPE_ERROR: Type '${typeof value}' not supported for value '${shown}'`);
}

/**
 * A value SQLite answers, as D1 answers it: a blob as its bytes' numbers, an integer a number, and a
 * number as JSON carries it.
 */
function answeredOf(value: SQLOutputValue): unknown {
  if (value instanceof Uint8Array) return [...value];
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' ? carried(value) : value;
}

/**
 * Where the run at a line's start, `at` of `sql`, ends of what D1 takes out of a text it asks is
 * blank: white space, and a comment after it to its line's end; `at` of none.
 */
function takenOut(sql: string, at: number): number {
  let end = at;
  while (end < sql.length && WHITE.test(sql[end] ?? '')) end += 1;
  if (end === at || !sql.startsWith('--', end)) return end;
  const line = sql.indexOf('\n', end);
  // Its line's end is the text's again, which begins no line of its own.
  return line === -1 ? sql.length : line;
}

/**
 * Whether D1 finds `sql` blank, as it asks of each statement of a call: of nothing but white space,
 * and the lines of a comment that white space begins at a line's start, as Miniflare's
 * `sql.replace(/^\s+--.*\/gm, '').trim()` takes them out — read once along, as that expression
 * reads a run of blank lines again at each. A batch leaves one out, and a call of none runs nothing.
 */
function blank(sql: string): boolean {
  let at = 0;
  while (at < sql.length) {
    const end = at === 0 || sql[at - 1] === '\n' ? takenOut(sql, at) : at;
    if (end === at) {
      if (!WHITE.test(sql[at] ?? '')) return false;
      at += 1;
    } else {
      at = end;
    }
  }
  return true;
}

/** A row of `columns`, as D1 answers one as an object: of a name twice, its later column. */
function objectOf(
  columns: readonly string[],
  row: readonly unknown[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(columns.map((name, at) => [name, row[at]]));
}

/** Refuses `sql` where it is a statement of a transaction, past what comes before its words. */
function refusedIfTransaction(sql: string): void {
  // D1 tells one by what it does, not by how its text begins.
  if (TRANSACTION.test(sql.replace(LEADING, ''))) {
    throw new Error(
      `D1 runs no statement of a transaction (${sql.trim().slice(0, SHOWN.characters)}): write the statements as one batch, as Drizzle's \`orm.batch([...])\` does.`,
    );
  }
}

/**
 * Runs each statement of `sql`, as D1 does, and answers the last one's columns and rows: it binds
 * `bound`, and one before it binds no value, as D1's may not. A text ends where white space of
 * ASCII's alone follows its last statement: a comment or a `;` after it is a statement of none, as D1
 * reads it, which it refuses.
 */
function textRan(
  db: DatabaseSync,
  sql: string,
  bound: readonly SQLInputValue[],
): Pick<Answered, 'columns' | 'rows'> {
  // Of the whole text, where SQLite asks it of a statement.
  if (Buffer.byteLength(sql) > MAX_TEXT_BYTES) {
    throw new Error(inD1Words('statement too long', TOOBIG));
  }
  let rest = sql;
  for (;;) {
    if (rest.replace(LEADING, '') === '') {
      throw new Error('D1_ERROR: SQL code did not contain a statement.');
    }
    refusedIfTransaction(rest);
    const prepared = db.prepare(rest);
    // Of any size, of a statement before the last too, whose rows are read and let go.
    prepared.setReadBigInts(true);
    // SQLite compiles the first statement of a text alone: what it compiled is the text's start.
    rest = rest.slice(prepared.sourceSQL.length);
    if (ENDED.test(rest)) {
      // D1 binds a statement of as many values as its parameters alone, where `node:sqlite` would
      // leave one of none `NULL`, and binds `?` and `?NNN` alone.
      const wanted = parametersOf(prepared.sourceSQL);
      if (wanted === undefined) {
        throw new Error(
          `D1 binds no named parameter (${prepared.sourceSQL.trim().slice(0, SHOWN.characters)}): write \`?\` or \`?NNN\`, as D1 binds them.`,
        );
      }
      if (wanted !== bound.length) {
        throw new Error('D1_ERROR: Wrong number of parameter bindings for SQL query.');
      }
      prepared.setReturnArrays(true);
      const rows = prepared.all(...bound) as unknown as SQLOutputValue[][];
      const columns = prepared.columns().map(({ name }) => name);
      return { columns, rows: rows.map((row) => row.map((value) => answeredOf(value))) };
    }
    // Its text with its parameters of no value is another than its text, of a parameter.
    if (prepared.expandedSQL !== prepared.sourceSQL) {
      throw new Error(
        `D1_ERROR: When executing multiple SQL statements in a single call, only the last statement can have parameters (${prepared.sourceSQL.trim().slice(0, SHOWN.characters)}).`,
      );
    }
    prepared.all();
  }
}

/**
 * Runs `body` in a transaction of its own, as D1 runs a call: whole or not at all, and of the lock
 * of writes from its start, so that one that reads before it writes waits for another process's
 * write, as a write alone does.
 */
function transacted<T>(db: DatabaseSync, body: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const answer = body();
    db.exec('COMMIT');
    return answer;
  } catch (error) {
    // SQLite ends a transaction of some of its failures itself.
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** What `first` answers of `rows`: the first one, or its `column`, of a column it holds. */
function firstOf(columns: readonly string[], rows: readonly unknown[][], column?: string): unknown {
  const [row] = rows;
  if (row === undefined) return null;
  if (column === undefined) return objectOf(columns, row);
  if (!columns.includes(column)) {
    const missing = `Column not found (${column})`;
    throw new Error(`D1_COLUMN_NOTFOUND: ${missing}`, { cause: new Error(missing) });
  }
  return objectOf(columns, row)[column] ?? null;
}

/** What D1 answers of `answered`: its rows as objects. */
function resultOf({ columns, meta, rows }: Answered): LocalResult {
  return { meta, results: rows.map((row) => objectOf(columns, row)), success: true };
}

/**
 * A statement of `sql`, bound to `bound`, each value as D1 binds it (`boundOf`). What it changed
 * counts its triggers' writes, as D1's count does: the change of the connection's whole count
 * (`counts`).
 */
function statementOf(
  db: DatabaseSync,
  counts: StatementSync,
  sql: string,
  bound: readonly SQLInputValue[],
): LocalStatement {
  const counted = (): Counts => counts.get() as unknown as Counts;
  const answered = (): Answered => {
    return asD1(() => {
      const before = counted().total;
      const { columns, rows } = textRan(db, sql, bound);
      const { id, total } = counted();
      // Numbers, as D1 answers them: a key past 2^53 rounded.
      const meta = { changes: Number(total - before), last_row_id: Number(id) };
      return { columns, meta, rows };
    });
  };
  const called = async <T>(shaped: (answer: Answered) => T): Promise<T> => {
    await later();
    if (blank(sql)) throw new Error('D1_ERROR: No SQL statements detected.');
    return shaped(asD1(() => transacted(db, answered)));
  };
  return {
    all: async () => called(resultOf),
    bind: (...values) => {
      return statementOf(
        db,
        counts,
        sql,
        values.map((value) => boundOf(value)),
      );
    },
    first: async (column) => called(({ columns, rows }) => firstOf(columns, rows, column)),
    ran: () => resultOf(answered()),
    raw: async (options) =>
      called(({ columns, rows }) => (options?.columnNames === true ? [columns, ...rows] : rows)),
    run: async () => called(resultOf),
    sql,
  };
}

/**
 * The database in `file`, made where it is not there yet, or of memory alone for `:memory:`. Its
 * foreign keys are kept, as D1 keeps them and `node:sqlite` does unless told otherwise, a text in
 * double quotes of no name is a string, as D1 reads one, it holds D1's limits (`LIMITS`), and a
 * process that writes it beside this one waits its turn rather than fails.
 */
export function localD1(file: string): LocalD1 {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { enableDoubleQuotedStringLiterals: true, limits: LIMITS });
  // The wait first: making the file WAL's takes a lock of it too.
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL');
  const counts = db.prepare('SELECT total_changes() AS total, last_insert_rowid() AS id');
  counts.setReadBigInts(true);
  let open = true;
  return {
    batch: async (statements) => {
      await later();
      const asked = (statements as LocalStatement[]).filter((statement) => !blank(statement.sql));
      if (asked.length === 0) throw new Error('D1_ERROR: No SQL statements detected.');
      return asD1(() => transacted(db, () => asked.map((statement) => statement.ran())));
    },
    close: () => {
      if (!open) return;
      open = false;
      db.close();
    },
    prepare: (sql) => statementOf(db, counts, sql, []),
  };
}

/** Takes `lock`'s file, unless another process holds it. */
function took(lock: DatabaseSync): boolean {
  try {
    lock.exec('BEGIN EXCLUSIVE');
    return true;
  } catch (error) {
    const code: unknown = error instanceof Error ? Reflect.get(error, 'errcode') : undefined;
    if (typeof code === 'number' && code % EXTENDED_STEP === BUSY) return false;
    throw error;
  }
}

/**
 * Runs `work` once no other process runs its own of `file`: of two that start on one file at once,
 * one migrates and seeds it. By a lock of SQLite's of a file beside it (`<file>.lock`), which the
 * system lets go of as the process that holds it ends, however it ends. One of memory alone is no
 * other process's.
 */
export async function aloneOf(file: string, work: () => Promise<void>): Promise<void> {
  if (file === ':memory:') {
    await work();
    return;
  }
  // Its connection's end, as the call ends, lets go of the lock.
  using lock = new DatabaseSync(`${file}.lock`);
  // Asked again a while later, rather than waited for, as a wait of SQLite's holds the process.
  while (!took(lock)) await sleep(LOCK_RETRY_MS);
  await work();
}
