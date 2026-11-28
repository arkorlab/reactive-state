import { BYTE_ORDER_MARK, leadingWord, namesPragmaFunction, soleStatement } from './where.ts';

/**
 * What a render's statements of D1 their words refuse, before a plan of them is asked, and what a
 * render's statement that writes is answered: a render reads, and only what its plan says.
 */

/** How much of a text a fault shows. */
const SHOWN_TEXT = 80;
/**
 * The words a render's statement begins with: a query's, and a write's, which its plan refuses. A
 * text of another, of which `EXPLAIN` makes a statement of another kind, is refused by its words.
 */
const STATEMENTS = new Set(['delete', 'insert', 'replace', 'select', 'update', 'values', 'with']);

/**
 * The fault of a render's statement its words refuse, before its plan is asked: a text of several
 * statements, which D1 runs each of; a `PRAGMA`, which sets the connection's flags as SQLite
 * compiles it — of its plan too; and a statement that names a `pragma_` function, of which
 * `pragma_optimize` writes as it is read, unseen by its plan.
 */
export function refusalOf(texts: readonly string[]): Error | undefined {
  for (const sql of texts) {
    const shown = sql.slice(0, SHOWN_TEXT);
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
export function writes(sql: string): Error {
  return new Error(`A component writes nothing as it renders: ${sql.slice(0, SHOWN_TEXT)}`);
}
