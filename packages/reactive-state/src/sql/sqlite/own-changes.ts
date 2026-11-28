import { TRACKED } from './tracked.ts';
import {
  bareOf,
  BYTE_ORDER_MARK,
  folded,
  leadingWord,
  readsAlone,
  soleStatement,
  writtenTable,
} from './where.ts';

/**
 * A D1 binding whose answers count each statement's own changes, not the rows the change log's
 * triggers wrote beside them. Of a database whose tables log their changes (`captureSql()`), D1
 * counts what a trigger writes in `meta.changes` — a row inserted answers two — and code that asks
 * a write for an exact count, as a claim or a compare-and-set does (`meta.changes === 1`), reads
 * its own write as another's.
 *
 * A statement that may write a row of a table — `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, a `WITH`
 * before one, or a text of a statement this reads not — runs through `run()` or `all()` as one
 * batch of three, a read of the log's head (`sqlite_sequence`) and of SQLite's `changes()` either
 * side of it: one transaction, and one query of D1's. Its answer is D1's, its count less the rows
 * the log gained, where D1 counted more than the statement's direct changes; where it counted those
 * alone, as `changes()` does, which holds no trigger's rows, D1's count is answered as it is, as it
 * is where the log gained none. A batch's statements are read so too, the heads between them, its
 * answers in its order, of none of a statement D1 answers none of (a blank one). `raw()` and
 * `first()` answer no count and run as they are, as does a statement of any other word, a text of
 * no statement, a statement that writes the log itself (`_rs_changes`, which the application writes
 * not), and a statement this binding did not make. `rows_written`, `changed_db` and the rest stay
 * D1's.
 *
 * A database of no `sqlite_sequence` holds no log: a statement there runs as it is, the batch D1
 * refused of the head undone, and the next is read so again, as a log may be made at any time. A
 * session the binding opens (`withSession`) is counted the same way. The follow's client
 * (`trackedD1`), and a session of it, is wrapped not: the binding it is given is.
 */

/** A statement of D1's, as much of it as runs: bound, and answered by each of its methods. */
interface Statement {
  bind(...values: unknown[]): Statement;
  run(): Promise<unknown>;
  all(): Promise<unknown>;
  first(...args: unknown[]): Promise<unknown>;
  raw(...args: unknown[]): Promise<unknown>;
}

/** A binding of D1's, or a session of one, as much of it as its statements are made and batched by. */
export interface CountedBinding {
  prepare(sql: string): unknown;
  batch(statements: unknown[]): Promise<readonly unknown[]>;
}

/** What a binding's wrapper keeps of its database. */
interface Kept {
  /** What was told of answers this reads not, each once. */
  readonly told: Set<string>;
}

/** A binding of D1's, or a session of one, and what its wrapper keeps of the database. */
interface Counted {
  readonly binding: CountedBinding;
  readonly kept: Kept;
}

/** What a statement a wrapper made is: its text, D1's own statement, and what made it. */
interface Own {
  readonly sql: string;
  readonly statement: Statement;
  readonly by: Counted;
}

/** What each statement of a batch, as it is sent, is: a read of the head, one counted, another. */
type Sent = 'counted' | 'head' | 'other';

/** The names the read of the head answers its two values by, which tell its answers apart. */
const HEAD = { head: '_rs_head', own: '_rs_own' } as const;
/** The log's head, and the direct changes of the statement before it, as SQLite counts them. */
const HEAD_SQL = `SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = '_rs_changes'), 0) AS "${HEAD.head}", changes() AS "${HEAD.own}"`;
/** The log, which a statement of the application's writes not. */
const LOG = '_rs_changes';
/** The words a statement of rows written begins with, whose triggers may write the log. */
const COUNTED: ReadonlySet<string> = new Set(['delete', 'insert', 'replace', 'update']);
/** D1's refusal of a read of `sqlite_sequence`, of a database that has none. */
const NO_SEQUENCE = /no such table: (?:main\.)?sqlite_sequence\b/iu;
/**
 * A character a word of SQLite's may begin with: a keyword's, a name's — none of white space as
 * JavaScript reads it (`\s`), of which, and of comments, D1 reads a text as blank (`trim()`).
 */
const WORD_START = /(?!\s)[A-Z_\u{80}-\u{10FFFF}]/iu;
/** What is told of a count D1 answered that fits neither way a D1 counts. */
const UNREAD_COUNT =
  "reactive-state: D1 counted fewer changes of a statement than the rows its change log gained beside its own, so its count is answered as D1 gave it: a count of the statement's own may be more.";
/** What is told of a batch whose answers are not one of each of its statements. */
const UNREAD_ANSWERS =
  "reactive-state: D1 answered a batch otherwise than of one answer each of its statements, so its counts are answered as D1 gave them: a count of a statement's own may be more.";

/** The statements each wrapper made, by themselves: what a batch of them runs. */
const OWN = new WeakMap<WeakKey, Own>();
/** The wrappers this module made: a binding of one is counted already. */
const WRAPPERS = new WeakSet();
/** The wrapper of each binding, made once: what it keeps is of the binding's database. */
const MADE = new WeakMap<WeakKey, CountedBinding>();

/** Whether `sql` writes the log, as the package's own writer does: of rows of its own. */
function writesLog(sql: string): boolean {
  const table = writtenTable(sql);
  return table !== undefined && folded(table) === LOG;
}

/** Whether `sql` holds a word outside its strings, quoted names and comments: a statement's. */
function holdsWord(sql: string): boolean {
  return WORD_START.test(bareOf(sql));
}

/**
 * Whether `sql` may write a row of a table, which a trigger of the log may log: a statement that
 * begins with `INSERT`, `UPDATE`, `DELETE` or `REPLACE`, a `WITH` of more than reads before one,
 * or a text of a statement this reads not — of several statements, of an empty one before a word,
 * of a byte order mark. A text of no word is of no statement, and a statement that writes the log
 * is the package's own writer's.
 */
export function counts(sql: string): boolean {
  if (writesLog(sql)) return false;
  const word = leadingWord(sql);
  if (word === undefined) return holdsWord(sql);
  if (sql.includes(BYTE_ORDER_MARK) || !soleStatement(sql)) return true;
  if (word === 'with') return !readsAlone(sql);
  return COUNTED.has(word);
}

/**
 * What a statement changed of its own, of D1's count `changes`, the rows the log gained beside it
 * (`logged`) and its direct changes (`own`, SQLite's `changes()`): D1's count less the log's rows,
 * where D1 counted more than the direct changes, as SQLite's whole count does; D1's count as it is
 * where it counted those alone, or the log gained none. None where D1 counted fewer than the log's
 * rows past the direct changes, which no count of SQLite's is.
 */
export function ownCount(changes: number, logged: number, own: number): number | undefined {
  if (changes === own || logged <= 0) return changes;
  const fixed = changes - logged;
  return fixed < own ? undefined : fixed;
}

/** `value` as a record, or none of what is not an object. */
function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** The log's head and the direct changes of an answer of `HEAD_SQL`; none of another answer. */
function headOf(answer: unknown): { readonly head: number; readonly own: number } | undefined {
  const results = recordOf(answer)?.['results'];
  const row = Array.isArray(results) && results.length === 1 ? recordOf(results[0]) : undefined;
  if (row === undefined || Object.keys(row).length !== Object.keys(HEAD).length) return undefined;
  const head = row[HEAD.head];
  const own = row[HEAD.own];
  return Number.isSafeInteger(head) && Number.isSafeInteger(own)
    ? { head: head as number, own: own as number }
    : undefined;
}

/** Tells `message`, once of a database. */
function tell(kept: Kept, message: string): void {
  if (kept.told.has(message)) return;
  kept.told.add(message);
  // eslint-disable-next-line no-console
  console.warn(message);
}

/**
 * `answer`, D1's of a statement counted, of its own changes in its `meta`: of the reads of the
 * log's head `before` and `after` it. As it is where its count is none.
 */
function counted(answer: unknown, before: unknown, after: unknown, kept: Kept): unknown {
  const record = recordOf(answer);
  const meta = recordOf(record?.['meta']);
  const changes = meta?.['changes'];
  const was = headOf(before);
  const now = headOf(after);
  if (typeof changes !== 'number' || was === undefined || now === undefined) return answer;
  const own = ownCount(changes, now.head - was.head, now.own);
  if (own === undefined) {
    tell(kept, UNREAD_COUNT);
    return answer;
  }
  return own === changes ? answer : { ...record, meta: { ...meta, changes: own } };
}

/** D1's answers of a batch counted as they are, but those of the reads of the head, told once. */
function unaligned(answers: readonly unknown[], kept: Kept): readonly unknown[] {
  tell(kept, UNREAD_ANSWERS);
  return answers.filter((answer) => headOf(answer) === undefined);
}

/** Where a walk of a batch's answers is: the next one, the last head read, a count it waits on. */
interface Walk {
  at: number;
  before: unknown;
  /** Where the answer of the statement counted last is among those answered, waiting on a head. */
  waiting: number | undefined;
}

/**
 * The answer, at `walk`, of a statement of the kind `kind`, put in `out`; whether the answers are
 * still one of each statement. A read of the head and a counted statement are always answered; an
 * other statement is not, where D1 answers it not (a blank one), whose answers come in its order.
 */
function took(kind: Sent, walk: Walk, answers: readonly unknown[], out: unknown[]): boolean {
  const answer = answers[walk.at];
  const head = headOf(answer) !== undefined;
  if (kind === 'other') {
    if (answer !== undefined && !head) {
      out.push(answer);
      walk.at += 1;
    }
    return true;
  }
  if (answer === undefined || head !== (kind === 'head')) return false;
  walk.at += 1;
  if (kind === 'counted') {
    walk.waiting = out.length;
    out.push(answer);
  }
  return true;
}

/**
 * D1's answers of a batch sent as `kinds` says, each counted statement's of its own changes and
 * those of the reads of the head left out, in the order D1 gave them; as D1 gave them where they are
 * not one of each statement it answers.
 */
function aligned(
  kinds: readonly Sent[],
  answers: readonly unknown[],
  kept: Kept,
): readonly unknown[] {
  const out: unknown[] = [];
  const walk: Walk = { at: 0, before: undefined, waiting: undefined };
  for (const kind of kinds) {
    const answer = answers[walk.at];
    if (!took(kind, walk, answers, out)) return unaligned(answers, kept);
    if (kind !== 'head') continue;
    if (walk.waiting !== undefined) {
      out[walk.waiting] = counted(out[walk.waiting], walk.before, answer, kept);
      walk.waiting = undefined;
    }
    walk.before = answer;
  }
  return walk.at === answers.length ? out : unaligned(answers, kept);
}

/** Whether `error`, D1's of a batch, refused the read of a `sqlite_sequence` the database has not. */
function sequenceAbsent(error: unknown): boolean {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  return NO_SEQUENCE.test(`${String(error)} ${String(cause)}`);
}

/**
 * D1's answers of the batch `sent`, or what `plain` answers where D1 refused its read of the head
 * of a database of no `sqlite_sequence`: a batch D1 refused ran none of its statements, and is sent
 * as it was. Nothing is kept of the refusal: the next statement may find a log made since.
 */
async function headed<T>(
  by: Counted,
  sent: unknown[],
  plain: () => Promise<T>,
): Promise<{ readonly answers: readonly unknown[] } | { readonly plain: T }> {
  try {
    return { answers: await by.binding.batch(sent) };
  } catch (error) {
    if (!sequenceAbsent(error)) throw error;
    return { plain: await plain() };
  }
}

/**
 * Whether D1 answered a statement sent between two reads of the head of the reads alone: of none
 * of the statement, as of a text it reads as blank, which it ran none of. Each read is answered.
 */
function headsAlone(answers: readonly unknown[]): boolean {
  return answers.length === 2 && answers.every((answer) => headOf(answer) !== undefined);
}

/**
 * `statement`'s answer of `method`, counted where its text says it may write a row; as D1 answers it
 * sent alone where D1 answered none of it of the three, as it ran none of it.
 */
async function single(own: Own, method: 'all' | 'run'): Promise<unknown> {
  const { by, sql, statement } = own;
  const run = async (): Promise<unknown> => statement[method]();
  if (!counts(sql)) return run();
  const head = (): unknown => by.binding.prepare(HEAD_SQL);
  const sent = await headed(by, [head(), statement, head()], run);
  if ('plain' in sent) return sent.plain;
  if (headsAlone(sent.answers)) return run();
  const [answer] = aligned(['head', 'counted', 'head'], sent.answers, by.kept);
  return answer;
}

/** A statement of `sql`, D1's `statement`, made by `by`: its writes counted of their own. */
function statementOf(sql: string, statement: Statement, by: Counted): Statement {
  const own: Own = { by, sql, statement };
  const made: Statement = {
    all: async () => single(own, 'all'),
    bind: (...values) => statementOf(sql, statement.bind(...values), by),
    first: async (...args) => statement.first(...args),
    raw: async (...args) => statement.raw(...args),
    run: async () => single(own, 'run'),
  };
  OWN.set(made, own);
  return made;
}

/**
 * The statements of a batch as they are sent, each counted one between two reads of the log's head
 * — of one read between two counted in a row — and what each one sent is.
 */
function interleaved(
  plain: readonly unknown[],
  counting: readonly boolean[],
  head: () => unknown,
): { readonly sent: unknown[]; readonly kinds: readonly Sent[] } {
  const sent: unknown[] = [];
  const kinds: Sent[] = [];
  for (const [index, statement] of plain.entries()) {
    if (counting[index] !== true) {
      sent.push(statement);
      kinds.push('other');
      continue;
    }
    if (kinds.at(-1) !== 'head') {
      sent.push(head());
      kinds.push('head');
    }
    sent.push(statement, head());
    kinds.push('counted', 'head');
  }
  return { kinds, sent };
}

/** A batch of `statements` through `by`, each one counted of its own where it may write a row. */
async function batched(by: Counted, statements: unknown[]): Promise<readonly unknown[]> {
  const owned = statements.map((each) =>
    typeof each === 'object' && each !== null ? OWN.get(each) : undefined,
  );
  const plain = statements.map((each, at) => owned[at]?.statement ?? each);
  const counting = owned.map((each) => each !== undefined && counts(each.sql));
  const send = async (): Promise<readonly unknown[]> => by.binding.batch(plain);
  if (!counting.includes(true)) return send();
  const { kinds, sent } = interleaved(plain, counting, () => by.binding.prepare(HEAD_SQL));
  const result = await headed(by, sent, send);
  return 'plain' in result ? result.plain : aligned(kinds, result.answers, by.kept);
}

/** The wrapper of `binding`, or of a session of its database, of what it keeps of the database. */
function wrapped(binding: CountedBinding, kept: Kept): CountedBinding {
  const by: Counted = { binding, kept };
  const wrapper = new Proxy(binding, {
    get: (target, key) => {
      if (key === 'prepare') {
        return (sql: string) => statementOf(sql, target.prepare(sql) as Statement, by);
      }
      if (key === 'batch') return async (statements: unknown[]) => batched(by, statements);
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      // A session is of the same database: its statements are counted as the binding's are.
      if (key === 'withSession') {
        return (...args: unknown[]) =>
          wrapped(Reflect.apply(value, target, args) as CountedBinding, kept);
      }
      // D1's own methods, as D1's binding calls them: of itself, not of the wrapper.
      return (...args: unknown[]): unknown => Reflect.apply(value, target, args);
    },
  });
  WRAPPERS.add(wrapper);
  return wrapper;
}

/**
 * `binding`, a D1 binding, whose `run()` and `all()` answer each statement's own changes in
 * `meta.changes`, not the rows the change log's triggers wrote beside them, by its type: the same
 * wrapper of the same binding, and a wrapper as it is. The follow's client, and a session of it, is
 * refused: around it, a server operation's statements would hold the reads of the head, and tell
 * less of what they wrote; the binding the follow is given is wrapped,
 * `follow.client(ownChanges(binding))`.
 */
export function ownChanges<B extends CountedBinding>(binding: B): B {
  if (TRACKED.has(binding)) {
    throw new TypeError(
      "ownChanges() wraps the D1 binding the follow is given, not the follow's client or a session of it: write `follow.client(ownChanges(binding))`.",
    );
  }
  if (WRAPPERS.has(binding)) return binding;
  const made = MADE.get(binding) ?? wrapped(binding, { told: new Set() });
  MADE.set(binding, made);
  return made as B;
}
