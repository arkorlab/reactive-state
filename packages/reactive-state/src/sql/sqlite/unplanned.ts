import { JSON_TABLES, type StatementRead, statementRead } from './scopes.ts';
import { tablesNamed } from './sources.ts';
import { type Conditions, conditionsOf, folded, namedAt, runEnd } from './where.ts';

/**
 * What a statement's text says of the tables it reads (`client.ts`): what its plan is asked and
 * read by, and, of a statement no plan says the tables of, whether a render every visitor shares
 * may take it for a read of the followed tables alone. Such a statement reads every followed table
 * whole, and may read besides a table nothing follows, whose change no log tells: the render is
 * every visitor's only where the statement's words say it reads none — a text read plainly, each
 * table it names followed. Of any other the render is the request's, rendered again for each
 * request once the memo lets it go, as a read of the clock makes it. And how many of JSON's table
 * functions its words call: what a plan's virtual tables are counted against.
 */

/** How much of a statement a note of it shows. */
const SHOWN = { characters: 80 } as const;
/** A run of a name's characters, as SQLite reads a word of them. */
const NAME_RUN = /[\w$\u{80}-\u{10FFFF}]+/uy;

/** What a statement's text says, which its plan is asked and read by. */
export interface StatementText {
  readonly conditions: Conditions | undefined;
  /** The tables it names, each of whose columns the plan asks. */
  readonly named: readonly string[];
  readonly scoped: StatementRead | undefined;
}

/** What `sql` says: a statement of one table, or one read scope by scope. */
export function textOf(sql: string): StatementText {
  const conditions = conditionsOf(sql);
  if (conditions !== undefined) return { conditions, named: [conditions.table], scoped: undefined };
  const scoped = statementRead(sql);
  return { conditions, named: tablesNamed(scoped), scoped };
}

/**
 * The tokens of `sql` a call is read of — each word folded, each other character but a space, and
 * `''` of a quoted name or a string — past its comments; none of a text of a named parameter, which
 * SQLite reads to its own end (`namedAt`).
 */
function callTokens(sql: string): readonly string[] {
  const tokens: string[] = [];
  let at = 0;
  while (at < sql.length) {
    if (namedAt(sql, at)) return [];
    const end = runEnd(sql, at);
    if (end > at) {
      if (!sql.startsWith('--', at) && !sql.startsWith('/*', at)) tokens.push('');
      at = end;
      continue;
    }
    NAME_RUN.lastIndex = at;
    const [word] = NAME_RUN.exec(sql) ?? [];
    const char = sql[at] ?? '';
    if (word !== undefined) tokens.push(folded(word));
    else if (!/\s/u.test(char)) tokens.push(char);
    at += word?.length ?? 1;
  }
  return tokens;
}

/**
 * How many of SQLite's table functions of JSON (`JSON_TABLES`) the words of `sql` call, as a
 * text read plainly or not: each such word, unquoted, before a `(`, outside a string, a quoted name
 * and a comment. A call quoted, or of a text of a named parameter, is not counted, so the count is
 * of no more than the text calls — but where a table or a `WITH` takes the function's name.
 */
export function jsonTablesIn(sql: string): number {
  const tokens = callTokens(sql);
  return tokens.filter((token, at) => JSON_TABLES.has(token) && tokens[at + 1] === '(').length;
}

/**
 * What a render every visitor shares reads of the request by `sql`, of `text`, where no plan says
 * which tables it reads: nothing where its words say it reads none but the tables `followed`
 * names, as SQLite compares names; else the statement, of what may be no followed table's.
 */
export function unplannedRead(
  sql: string,
  text: StatementText,
  followed: Iterable<string>,
): string | undefined {
  const plain = text.conditions !== undefined || text.scoped !== undefined;
  const names = new Set<string>();
  for (const name of followed) names.add(folded(name));
  if (plain && text.named.every((name) => names.has(folded(name)))) return undefined;
  const shown = sql.slice(0, SHOWN.characters);
  return `a statement of no plan whose words do not say it reads followed tables alone (\`${shown}\`)`;
}
