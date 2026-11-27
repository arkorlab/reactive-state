import { beganWrite, type ExternalWriteEnd, sentAsWrite } from '../server/context.ts';
import { callbackOf, rejection } from './client-objects.ts';
import { codeOf, OWN } from './client-plans.ts';
import { sqlTokens } from './lex.ts';

/**
 * What a server operation's statements to PostgreSQL tell the authority, which runs an operation at
 * most once (`sentAsWrite`): before it goes, each that may write a table, and how it ended. A text
 * reads alone where each of its statements begins with `SELECT`, `VALUES`, `TABLE`, `SHOW` or
 * `WITH` and holds no word of a write — `INSERT`, `UPDATE`, `DELETE`, `MERGE`, nor `INTO` of a
 * table made or `FOR` of rows locked — read alike whether or not the session's strings take `\` as
 * an escape; any other may write, and so may what runs no text of its own: the raw protocol, a
 * template. A function of the database's that writes, called in a read, is not seen.
 *
 * An error of an SQLSTATE of a statement refused — its text, a value, a constraint, a transaction
 * that could not go on, a function's `RAISE` — says it wrote nothing, a text of one statement's;
 * any other — a connection lost, the server shutting down, an error of its own — that it may have.
 * In a transaction, what a statement writes lands as the transaction commits: it ends as the
 * transaction does — landed as its `COMMIT` answers, nothing where it rolls back — and the
 * `COMMIT` of one that wrote is a write of its own, which an operation that sends no more refuses.
 */

/** The words a statement that reads alone begins with. */
const READ_OPENINGS: ReadonlySet<string> = new Set(['select', 'show', 'table', 'values', 'with']);
/** The words of a write and of a table a read makes: none is in a read's text. */
const WRITING: ReadonlySet<string> = new Set(['delete', 'insert', 'into', 'merge', 'update']);
/**
 * The classes of SQLSTATE of a statement refused, which wrote nothing: of a feature, a row too many,
 * a value, a constraint, a transaction's state, its rollback, the text, and PL/pgSQL's `RAISE`.
 */
const REFUSED_CLASSES = ['0A', '21', '22', '23', '25', '40', '42', 'P0'] as const;
/** The words past `FOR` of a locking clause, which a read of `substring(x from 1 for 3)` has not. */
const LOCKING: ReadonlySet<string> = new Set(['key', 'no', 'share', 'update']);
/**
 * The words of a statement that runs code of its own — a procedure, a `DO` block — which may commit
 * before it raises: none of its errors says it wrote nothing.
 */
const RUNS_CODE: ReadonlySet<string> = new Set(['call', 'do']);
/** An SQLSTATE: five digits or capitals. */
const SQLSTATE = /^[\dA-Z]{5}$/u;
/** A statement that undoes a transaction, which writes nothing, and is never refused. */
const UNDOES = /^\s*(?:abort|rollback)\b/iu;
/** The methods of a connection's that run a statement: a text, a template, the raw protocol. */
const SENDS: readonly RegExp[] = [/^(?:exec|query|sql)$/u, /^execProtocol/u];

/** The text `first` holds, as a string or an object's: what a `query` runs. */
export function textOf(first: unknown): unknown {
  return typeof first === 'object' && first !== null ? Reflect.get(first, 'text') : first;
}

/** The statements of `tokens`, a text's, past their `;`s: those of no token left out. */
function statementsOf(tokens: readonly string[]): readonly (readonly string[])[] {
  const statements: string[][] = [[]];
  for (const part of tokens) {
    if (part === ';') statements.push([]);
    else statements.at(-1)?.push(part);
  }
  return statements.filter((each) => each.length > 0);
}

/** The statements of `sql`, read with strings that take `\` as an escape or not; none unread. */
function readOf(sql: string, conforming: boolean): readonly (readonly string[])[] | undefined {
  const tokens = sqlTokens(sql, conforming);
  return tokens === undefined ? undefined : statementsOf(tokens);
}

/** Whether `tokens`, a statement's, read alone: it opens as a read, and holds no word of a write. */
function readsAlone(tokens: readonly string[]): boolean {
  // A set operation is written `(select …) union (select …)`: its parentheses open the read.
  const opening = tokens.find((word) => word !== '(');
  const locks = tokens.some((word, at) => word === 'for' && LOCKING.has(tokens[at + 1] ?? ''));
  return READ_OPENINGS.has(opening ?? '') && !locks && tokens.every((word) => !WRITING.has(word));
}

/** Whether `sql`, a text of PostgreSQL's, writes nothing, however the session reads its strings. */
export function readsOnly(sql: string): boolean {
  return [true, false].every(
    (conforming) => readOf(sql, conforming)?.every((tokens) => readsAlone(tokens)) === true,
  );
}

/** Whether `sql` is one statement, however the session reads its strings. */
function soleStatement(sql: string): boolean {
  return [true, false].every((conforming) => readOf(sql, conforming)?.length === 1);
}

/** Whether `sql` is one statement that rolls a transaction back, however its strings are read. */
function undoes(sql: string): boolean {
  return UNDOES.test(sql) && soleStatement(sql);
}

/** Whether `sql` runs code of its own, a procedure's or a block's, which may commit before it fails. */
function runsCode(sql: string): boolean {
  return [true, false].some((conforming) => RUNS_CODE.has(readOf(sql, conforming)?.[0]?.[0] ?? ''));
}

/** Whether `error` is PostgreSQL's refusal of a statement, which wrote nothing. */
export function refusedByPostgres(error: unknown): boolean {
  const code = codeOf(error);
  return (
    typeof code === 'string' &&
    SQLSTATE.test(code) &&
    // Whether the statement completed is unknown.
    code !== '40003' &&
    REFUSED_CLASSES.some((kind) => code.startsWith(kind))
  );
}

/**
 * The writes of one transaction of a server operation's: each begun as its statement goes, all
 * ended as the transaction ends.
 */
export class TransactionWrites {
  readonly #ends: ((ended: ExternalWriteEnd) => void)[] = [];

  /** What `settled` settles to, as it ends the transaction's writes (`through`). */
  async #awaited(
    settled: Promise<unknown>,
    rolledBack: (error: unknown) => boolean,
  ): Promise<unknown> {
    try {
      const value: unknown = await settled;
      this.ended('landed');
      return value;
    } catch (error) {
      this.ended(rolledBack(error) || refusedByPostgres(error) ? 'none' : 'unknown');
      throw error;
    }
  }

  /** Notes `sql`, a statement of the transaction's, before it goes: of one that may write. */
  sent(sql: string): void {
    if (readsOnly(sql)) return;
    const ended = beganWrite(sql);
    if (ended !== undefined) this.#ends.push(ended);
  }

  /** Notes, before the transaction commits, that it does: a write of its own, of one that wrote. */
  committing(): void {
    if (this.#ends.length > 0) this.sent('COMMIT');
  }

  /** Ends each write of the transaction, as it ended. */
  ended(how: ExternalWriteEnd): void {
    for (const end of this.#ends.splice(0)) end(how);
  }

  /**
   * `settled`, which ends the transaction — its `COMMIT`, or a call that runs it whole — as it
   * ends its writes: landed as it answers, none where `rolledBack` says its error rolled it back or
   * PostgreSQL refused it, of an outcome unknown otherwise.
   */
  through(settled: unknown, rolledBack: (error: unknown) => boolean): unknown {
    if (!(settled instanceof Promise)) {
      this.ended('unknown');
      return settled;
    }
    return this.#awaited(settled, rolledBack);
  }
}

/**
 * What a call of `name` with `args` answers of the refusal of its statement, as it would fail: the
 * protocol's call that answers at once throws, a `pg` query calls the callback it was given, any
 * other rejects.
 */
function refusalAs(name: string, args: readonly unknown[]): (error: unknown) => unknown {
  return (error: unknown): unknown => {
    if (name === 'execProtocolRawSync') throw error;
    const callback = name === 'query' ? callbackOf(args[0], args.slice(1)) : undefined;
    if (typeof callback !== 'function') return rejection(error);
    queueMicrotask(() => {
      Reflect.apply(callback, undefined, [error]);
    });
    return undefined;
  };
}

/**
 * `run`, a call of `name` with `args` of a connection's, as the server operation under way sends
 * it: what it runs that may write told to it first — of a transaction under way, to `writes`, which
 * ends it as the transaction ends. A method that runs no statement runs as it is.
 */
export function sentToPostgres(
  name: PropertyKey,
  args: readonly unknown[],
  run: () => unknown,
  writes?: TransactionWrites,
): unknown {
  if (typeof name !== 'string' || SENDS.every((form) => !form.test(name))) return run();
  const text = name === 'sql' ? undefined : textOf(args[0]);
  const sql = typeof text === 'string' ? text : undefined;
  // A transaction's own statement — its options, a savepoint, its rollback — writes nothing.
  const own = sql !== undefined && (OWN.some((form) => form.test(sql)) || undoes(sql));
  if (own || (sql !== undefined && readsOnly(sql))) return run();
  const shown = sql ?? `(${name})`;
  const answer = refusalAs(name, args);
  if (writes !== undefined) {
    try {
      writes.sent(shown);
    } catch (error) {
      return answer(error);
    }
    return run();
  }
  // A procedure or a `DO` block can `COMMIT` before it raises.
  const whole = sql !== undefined && soleStatement(sql) && !runsCode(sql);
  return sentAsWrite(shown, run, (error) => whole && refusedByPostgres(error), answer);
}
