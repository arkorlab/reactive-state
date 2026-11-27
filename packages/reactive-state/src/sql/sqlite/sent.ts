import { sentAsWrite } from '../../server/context.ts';
import { rejection } from '../client-objects.ts';
import { leadingWord, namesPragmaFunction, readsAlone, soleStatement } from './where.ts';

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

/** The texts of the statements D1's Sessions API made, by D1's own objects. */
const TEXTS = new WeakMap<WeakKey, string>();

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
 * left all of them unwritten.
 */
export function sentToD1<T>(
  texts: readonly (string | undefined)[],
  send: () => T,
  whole = true,
): T {
  if (texts.every((text) => text !== undefined && readsOnly(text))) return send();
  const refusable = whole && texts.every((text) => text !== undefined && !KEEPS_PART.test(text));
  const shown = texts.map((text) => text ?? UNSEEN).join('; ');
  // Every method of D1's is async: a refusal rejects.
  return sentAsWrite(
    shown,
    send,
    (error) => refusable && refusedByD1(error),
    (error) => rejection(error) as T,
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
    return sentToD1(
      statements.map((each) => sessionText(each)),
      call,
    );
  }
  return sentToD1([sessionText(target)], call);
}
