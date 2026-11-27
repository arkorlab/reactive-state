import { sentAsWrite } from '../../server/context.ts';
import { rejection } from '../client-objects.ts';
import { provenCounts, provenEmpty } from './unwritten.ts';
import {
  countsRows,
  leadingWord,
  mayDropRow,
  namesPragmaFunction,
  plainReturning,
  readsAlone,
  soleStatement,
  writtenTable,
} from './where.ts';

/**
 * What a server operation's statements to D1 tell the authority, which runs an operation at most
 * once (`sentAsWrite`): before it goes, each that may write a table, and how it ended. A text reads
 * alone of one statement that names no `pragma_` function and begins with `SELECT`, or with
 * `VALUES` or `WITH` and holds no word of a write; any other may write, and so may a statement
 * whose text the binding did not see.
 *
 * D1 answers no SQLSTATE. An error that names a code of SQLite's of a statement refused whole — its
 * text, a constraint, a value it holds not — says the statement wrote nothing, and of a batch,
 * which D1 runs as one transaction, that none of it did; any other — a connection lost, D1's own
 * (`internal error; reference = …`) — that it may have. So may an `exec` of several lines, which
 * D1 sends one by one, or of several statements, whatever it answers, and a statement of `OR FAIL`,
 * which keeps the rows it wrote before the one that failed: one that holds the word `FAIL`
 * anywhere, a comment between `OR` and it too.
 *
 * An answer that shows a statement wrote no row ends it `none`, not `landed`, on clear evidence
 * alone, and only of statements of `INSERT`, `UPDATE`, `DELETE` or `REPLACE`, or of a `WITH …`
 * clause before one, that name no `pragma_` function (a batch's every one).
 * - The `meta` of a `run` or `all` (a batch's every result) says `changes` and `rows_written` both
 *   0 and `changed_db` false, and the schemas of `main` and `temp` show no trigger or view that
 *   names a `pragma_` function, which writes uncounted.
 * - A `raw`, or a `first()` of no column, answers no row, or `null`, of a statement with a
 *   `RETURNING` clause whose list is plain (`*`, names, `AS` aliases: a function may
 *   `RAISE(IGNORE)` after a row is written) and no conflict clause (`OR IGNORE`, `ON CONFLICT`),
 *   and the schemas of the table it writes show no way a row could be dropped after a trigger
 *   wrote: no conflict clause of the table's own, no temporary object, no trigger that runs before
 *   the write but the log's, no trigger on the log, and no uncounted writer (`./unwritten.ts`).
 *
 * A read of the schemas that fails, or a call with no binding to read through, proves nothing. Any
 * other answer, an `exec`'s too, ends `landed`.
 */

/** A statement that begins with `SELECT`, which writes nothing in SQLite. */
export const READS_ONLY = /^\s*select\b/iu;
/** The words past `SELECT` a statement that reads alone may begin with. */
const READ_OPENINGS: ReadonlySet<string> = new Set(['values', 'with']);
/**
 * What D1 answers of a statement SQLite refused whole, by its code — its text or a name in it, a
 * constraint, a value it holds not, a value it binds not — and of a value D1 sends not.
 */
const REFUSED_WHOLE =
  /\bSQLITE_(?:AUTH|CONSTRAINT(?:_[A-Z]+)?|ERROR|MISMATCH|RANGE|TOOBIG)\b|\bD1_TYPE_ERROR\b/u;
/**
 * A conflict's resolution that keeps what the statement wrote before the row that failed, `OR FAIL`:
 * its word, wherever it stands, as SQLite takes a comment between `OR` and it for a space.
 */
const KEEPS_PART = /\bfail\b/iu;
/** What an operation's statement whose text the binding did not see is shown as. */
const UNSEEN = '(a statement the binding did not prepare)';
/** The methods of D1's that send no statement, past those that make one: what a session is. */
const QUIET: ReadonlySet<PropertyKey> = new Set(['dump', 'getBookmark', 'withSession']);

/**
 * Whether `answered` is a D1Result whose `meta` says the statement changed nothing: `changes` and
 * `rows_written` both 0, and `changed_db` false.
 */
function wroteNoRow(answered: unknown): boolean {
  if (typeof answered !== 'object' || answered === null) return false;
  const meta: unknown = Reflect.get(answered, 'meta');
  if (typeof meta !== 'object' || meta === null) return false;
  return (
    Reflect.get(meta, 'changes') === 0 &&
    Reflect.get(meta, 'rows_written') === 0 &&
    Reflect.get(meta, 'changed_db') === false
  );
}

/** Whether the schema of a table proves that an empty `RETURNING` of a write of it wrote nothing. */
type Prover = (table: string) => Promise<boolean>;

/** An answer that proves nothing. */
const NOT = Promise.resolve(false);

/** The call whose answer is read: its method, its arguments, and what proves an empty answer. */
interface Asked {
  readonly name: PropertyKey;
  readonly args: readonly unknown[];
  readonly prove?: Prover | undefined;
  /** What proves that zero counts mean no row written, by the schemas. */
  readonly counts?: (() => Promise<boolean>) | undefined;
}

/**
 * Whether `answered`, what `asked` answered of the statement `text`, is empty of rows where it has
 * a `RETURNING` clause and no conflict clause, which the schema of the table it writes proves
 * wrote nothing.
 */
function emptyReturning(asked: Asked, text: string, answered: unknown): Promise<boolean> {
  if (!plainReturning(text) || mayDropRow(text)) return NOT;
  const { args, name, prove } = asked;
  // `first` of a column answers `null` of a row whose value is null too; `raw` of its column
  // names answers them as a row.
  const empty =
    name === 'first'
      ? args.length === 0 && answered === null
      : name === 'raw' && Array.isArray(answered) && answered.length === 0;
  const table = empty ? writtenTable(text) : undefined;
  return table === undefined || prove === undefined ? NOT : prove(table);
}

/**
 * Whether what `asked` answered of the statements of `texts` shows that none of them wrote a row:
 * at once by the counts, or by the schema where an empty `RETURNING` is to prove it.
 */
function answeredUnwritten(
  asked: Asked,
  texts: readonly (string | undefined)[],
  answered: unknown,
): Promise<boolean> {
  const { name } = asked;
  const [text] = texts;
  // Only the counts of a statement of rows mean anything, of every statement of a batch.
  const counted = texts.length > 0 && texts.every((each) => each !== undefined && countsRows(each));
  if (!counted) return NOT;
  const { counts } = asked;
  if (name === 'batch') {
    const none =
      Array.isArray(answered) &&
      answered.length === texts.length &&
      answered.every((each) => wroteNoRow(each));
    return counts !== undefined && none ? counts() : NOT;
  }
  if (name === 'run' || name === 'all') {
    return counts !== undefined && wroteNoRow(answered) ? counts() : NOT;
  }
  if (text === undefined || texts.length !== 1) return NOT;
  return emptyReturning(asked, text, answered);
}

/** The texts of the statements D1's Sessions API made, by D1's own objects. */
const TEXTS = new WeakMap<WeakKey, string>();
/** What made each of those statements, the binding or session whose schema a proof reads. */
const OWNERS = new WeakMap<WeakKey, unknown>();

/** Whether `sql`, a text of SQLite's, writes nothing. */
export function readsOnly(sql: string): boolean {
  if (!soleStatement(sql) || namesPragmaFunction(sql)) return false;
  return READS_ONLY.test(sql) || (READ_OPENINGS.has(leadingWord(sql) ?? '') && readsAlone(sql));
}

/** The text of `error`, and of what caused it, where D1 keeps the database's own. */
export function saidBy(error: unknown): string {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  return `${String(error)} ${String(cause)}`;
}

/** Whether `error`, D1's, says SQLite refused the statement whole, which wrote nothing of it. */
export function refusedByD1(error: unknown): boolean {
  return REFUSED_WHOLE.test(saidBy(error));
}

/** The text of `statement`, one of D1's own a session made: none of one it did not. */
export function sessionText(statement: unknown): string | undefined {
  return typeof statement === 'object' && statement !== null ? TEXTS.get(statement) : undefined;
}

/**
 * `send`, which runs the statements of `texts` — one, or a batch's — as the server operation under
 * way sends them: told to it first where one may write. `whole`: whether what D1 refused of them
 * left all of them unwritten; `unwritten`: whether what it answered shows that none wrote a row.
 */
export function sentToD1<T>(
  texts: readonly (string | undefined)[],
  send: () => T,
  whole = true,
  unwritten?: (answered: unknown) => Promise<boolean>,
): T {
  if (texts.every((text) => text !== undefined && readsOnly(text))) return send();
  const refusable = whole && texts.every((text) => text !== undefined && !KEEPS_PART.test(text));
  const shown = texts.map((text) => text ?? UNSEEN).join('; ');
  // Every method of D1's is async: a refusal rejects.
  return sentAsWrite(shown, send, (error) => refusable && refusedByD1(error), {
    refusal: (error) => rejection(error) as T,
    unwritten,
  });
}

/** What made `statement`, where it is kept. */
function ownerOf(statement: unknown): unknown {
  return typeof statement === 'object' && statement !== null ? OWNERS.get(statement) : undefined;
}

/**
 * `send`, the call of `name` with `args` that runs the statements of `texts`, as `sentToD1` sends
 * it, its answer read for whether it shows that none of them wrote a row.
 */
export function sentCall<T>(
  texts: readonly (string | undefined)[],
  call: {
    readonly name: PropertyKey;
    readonly args: readonly unknown[];
    /** What reads the schema, where an empty `RETURNING` is to prove a write wrote nothing. */
    readonly binding?: unknown;
  },
  send: () => T,
): T {
  const { args, binding, name } = call;
  const prove: Prover | undefined =
    binding === undefined ? undefined : async (table) => provenEmpty(binding, table);
  const counts = binding === undefined ? undefined : async () => provenCounts(binding);
  return sentToD1(texts, send, true, (answered) =>
    answeredUnwritten({ args, counts, name, prove }, texts, answered),
  );
}

/**
 * What `name` of `target` — a method of the binding's, of a session's, or of a statement one made —
 * answers outside a render, `call` calling it with `args`: what it sends told to the server
 * operation under way, and the text of a statement it makes kept for what that one sends.
 */
export function sentBy(
  target: unknown,
  name: PropertyKey,
  args: readonly unknown[],
  call: () => unknown,
): unknown {
  if (name === 'prepare' || name === 'bind') {
    const made = call();
    const text = name === 'prepare' ? args[0] : sessionText(target);
    if (typeof made === 'object' && made !== null && typeof text === 'string') {
      TEXTS.set(made, text);
      OWNERS.set(made, name === 'prepare' ? target : ownerOf(target));
    }
    return made;
  }
  if (QUIET.has(name) || Object.hasOwn(Object.prototype, name)) return call();
  if (name === 'exec') {
    // D1's `exec` sends each line of its text as one query: a read where each reads alone, and
    // refusable only of a text of one line of one statement.
    const lines = String(args[0])
      .trim()
      .split('\n')
      .filter((line) => line.trim() !== '');
    const [only] = lines;
    return sentToD1(lines, call, lines.length === 1 && only !== undefined && soleStatement(only));
  }
  if (name === 'batch') {
    const statements: readonly unknown[] = Array.isArray(args[0]) ? args[0] : [];
    const texts = statements.map((each) => sessionText(each));
    return sentCall(texts, { args, binding: target, name }, call);
  }
  return sentCall([sessionText(target)], { args, binding: ownerOf(target), name }, call);
}
