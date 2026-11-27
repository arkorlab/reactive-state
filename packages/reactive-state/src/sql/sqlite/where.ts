/**
 * The conditions of a statement of SQLite that a render's reads are followed by: of a statement
 * Drizzle's builder writes of one table — `select … from "t" where "t"."c" = ? and "t"."d" in (?,
 * ?)` — each term of the top level's `AND` that names a column equal to a parameter, or in a list of
 * them. A statement of more — a join, a subquery — is `scopes.ts`'s to read; a set operation, a
 * `WITH`, or what this reads not plainly — a comment, a numbered or a named parameter, a name quoted
 * otherwise than `"` — has none; a condition of a `CASE`, whose `AND` is its own, has none; and a
 * term of more — an `OR`, a `COLLATE`, a function — is left out: the read is then of more rows,
 * never of fewer.
 */

/** A term of a statement's condition: a column, equal to one of the parameters at `params`. */
export interface Term {
  readonly column: string;
  /** The positions of the statement's parameters the column is equal to one of. */
  readonly params: readonly number[];
}

/** The table a statement reads alone, as its text names it, and the terms of its condition. */
export interface Conditions {
  readonly table: string;
  readonly terms: readonly Term[];
}

/** A token of the text: a quoted name, a string, a word, a parameter, or another character. */
export type Token =
  | { readonly kind: 'name'; readonly text: string }
  | { readonly kind: 'word'; readonly text: string }
  | { readonly kind: 'param' }
  | { readonly kind: 'other'; readonly text: string };

/**
 * The words of a clause that ends a `WHERE` clause or comes after the table: those SQLite reserves
 * alone, which no column is named unquoted — not `offset` nor `window`, which may name one, and come
 * after one of these (`limit … offset`) or not of Drizzle at all.
 */
const CLAUSES = new Set(['group', 'having', 'limit', 'order']);
/** The words a statement of one table and its condition holds none of. */
const REFUSED = new Set([
  'except',
  'exists',
  'from',
  'intersect',
  'join',
  'natural',
  'returning',
  'select',
  'union',
  'values',
  'with',
]);
/**
 * The characters that begin what this reads not plainly: a name quoted otherwise than `"`, and a
 * named parameter (`:x`, `@x`, `$x`, `#x`), which SQLite numbers among the `?`s.
 */
const UNREAD = new Set(['#', '$', ':', '@', '[', '`']);
/**
 * The words of a statement that writes, or does more than read: none of them is in a read's text,
 * as a name or as SQLite's own `replace()`, which a read whose plan is not asked forgoes.
 */
const WRITING = new Set([
  'alter',
  'analyze',
  'attach',
  'begin',
  'commit',
  'create',
  'delete',
  'detach',
  'drop',
  'insert',
  'pragma',
  'reindex',
  'release',
  'replace',
  'rollback',
  'savepoint',
  'update',
  'vacuum',
]);
/**
 * A name of one of SQLite's `pragma_` functions, quoted or not: a table of the connection's own,
 * of which `pragma_optimize` runs `PRAGMA optimize` as it is read, which writes tables of
 * statistics that its statement's `EXPLAIN` says nothing of.
 */
const PRAGMA_FUNCTION = /(?:^|[^\w$])["[`]?pragma_/iu;
/** How many tokens a column of its table is: `"t"`, `.`, `"c"`. */
export const QUALIFIED = { tokens: 3 } as const;
/**
 * A word as SQLite's tokenizer reads one: a letter, `_` or any character past ASCII, then those, the
 * digits and `$` — `élimit` is one name, not `é` and `limit` — and its spaces, of ASCII alone: a
 * space past it is a character of a name to SQLite.
 */
const WORD = /[A-Z_\u{80}-\u{10FFFF}][\w$\u{80}-\u{10FFFF}]*/iuy;
const NUMBER = /\d[\w.]*/uy;
const SPACE = /[\t\n\f\r ]+/uy;
/** U+FEFF, which SQLite reads as a space where a token begins: a text of one is read not. */
export const BYTE_ORDER_MARK = '\u{FEFF}';
/** An ASCII capital: SQLite's keywords are of ASCII alone, compared in any case of it. */
const CAPITAL = /[A-Z]/gu;

/** `name` as SQLite compares keywords and names: of ASCII's case alone. */
export function folded(name: string): string {
  return name.replaceAll(CAPITAL, (capital) => capital.toLowerCase());
}

/** The end of a quoted run from `at`, its quote doubled within it; `undefined` where it never ends. */
function quotedEnd(sql: string, at: number): number | undefined {
  const quote = sql[at];
  let index = at + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] !== quote) return index + 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  return undefined;
}

/** The token of `sql` at `at`, and where it ends; `undefined` where the text is not read plainly. */
function tokenAt(
  sql: string,
  at: number,
): { readonly token: Token; readonly end: number } | undefined {
  const char = sql[at] ?? '';
  if (char === '"' || char === "'") {
    const end = quotedEnd(sql, at);
    if (end === undefined) return undefined;
    const text = sql
      .slice(at + 1, end - 1)
      .split(`${char}${char}`)
      .join(char);
    return { end, token: char === '"' ? { kind: 'name', text } : { kind: 'other', text: "'" } };
  }
  if (char === '?') {
    // A numbered parameter (`?2`) is not read: its position is not its place in the text.
    return /\d/u.test(sql[at + 1] ?? '') ? undefined : { end: at + 1, token: { kind: 'param' } };
  }
  if (UNREAD.has(char) || sql.startsWith('--', at) || sql.startsWith('/*', at)) return undefined;
  for (const pattern of [WORD, NUMBER]) {
    pattern.lastIndex = at;
    const [found] = pattern.exec(sql) ?? [];
    if (found !== undefined) {
      const kind = pattern === WORD ? 'word' : 'other';
      return { end: at + found.length, token: { kind, text: folded(found) } };
    }
  }
  return { end: at + 1, token: { kind: 'other', text: char } };
}

/** Each parameter of `tokens`, by its place among the statement's. */
export function placesOf(tokens: readonly Token[]): ReadonlyMap<Token, number> {
  const places = new Map<Token, number>();
  for (const token of tokens) {
    if (token.kind === 'param') places.set(token, places.size);
  }
  return places;
}

/** The tokens of `sql`; `undefined` where it is not read plainly. */
function tokensOf(sql: string): readonly Token[] | undefined {
  // A byte order mark is a space to SQLite where a token begins, a name's character within one.
  if (sql.includes(BYTE_ORDER_MARK)) return undefined;
  const tokens: Token[] = [];
  let at = 0;
  while (at < sql.length) {
    SPACE.lastIndex = at;
    const space = SPACE.exec(sql);
    if (space !== null) {
      at += space[0].length;
      continue;
    }
    const next = tokenAt(sql, at);
    if (next === undefined) return undefined;
    tokens.push(next.token);
    at = next.end;
  }
  return tokens;
}

/**
 * The tokens of `sql` where they are what SQLite reads: it stops at a NUL, and two lone surrogates
 * reach it as one U+FFFD. What restricts a read must be read as SQLite does; what writes need not.
 */
export function plainTokensOf(sql: string): readonly Token[] | undefined {
  return sql.includes('\0') || !sql.isWellFormed() ? undefined : tokensOf(sql);
}

/** Whether `token` is the word `word`. */
export function isWord(token: Token | undefined, word: string): boolean {
  return token?.kind === 'word' && token.text === word;
}

/** Whether `token` is the character `text`. */
export function isChar(token: Token | undefined, text: string): boolean {
  return token?.kind === 'other' && token.text === text;
}

/** The parts of `tokens` at the top level split at each token `parts` says is a separator. */
function splitAt(
  tokens: readonly Token[],
  parts: (token: Token) => boolean,
): readonly (readonly Token[])[] {
  const split: Token[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (isChar(token, '(')) depth += 1;
    if (isChar(token, ')')) depth -= 1;
    if (depth === 0 && parts(token)) {
      split.push([]);
    } else {
      split.at(-1)?.push(token);
    }
  }
  return split;
}

/**
 * The terms of `condition` at the top level's `AND`: not at a `BETWEEN`'s own `AND`, which ends
 * its range (`"t"."a" between ? and ?`); none of a `BETWEEN` within another's range, whose `AND`s
 * are read not plainly.
 */
function conjunctsOf(condition: readonly Token[]): readonly (readonly Token[])[] | undefined {
  const range = { nested: false, open: false };
  const parts = splitAt(condition, (token) => {
    if (isWord(token, 'between')) {
      range.nested ||= range.open;
      range.open = true;
    }
    if (!isWord(token, 'and')) return false;
    if (!range.open) return true;
    range.open = false;
    return false;
  });
  return range.nested ? undefined : parts;
}

/** Whether the parenthesis `tokens` open with closes at their last token: one pair holds them. */
function enclosed(tokens: readonly Token[]): boolean {
  if (!isChar(tokens[0], '(') || !isChar(tokens.at(-1), ')')) return false;
  let depth = 0;
  for (const [at, token] of tokens.entries()) {
    if (isChar(token, '(')) depth += 1;
    if (isChar(token, ')')) depth -= 1;
    if (depth === 0 && at < tokens.length - 1) return false;
  }
  return true;
}

/** `tokens` of the parentheses around them all taken off, where one pair holds them all. */
export function unwrapped(tokens: readonly Token[]): readonly Token[] {
  let inner = tokens;
  while (enclosed(inner)) inner = inner.slice(1, -1);
  return inner;
}

/** The column `tokens` name of the table `table`: `"t"."c"` or `"c"`. */
function columnOf(tokens: readonly Token[], table: string): string | undefined {
  const [first, dot, second] = tokens;
  if (tokens.length === 1 && first?.kind === 'name') return first.text;
  if (
    tokens.length === QUALIFIED.tokens &&
    first?.kind === 'name' &&
    first.text === table &&
    isChar(dot, '.') &&
    second?.kind === 'name'
  ) {
    return second.text;
  }
  return undefined;
}

/** The position among the statement's parameters of the parameter `tokens` are alone; or none. */
type Placed = (tokens: readonly Token[]) => number | undefined;

/** The term of a column equal to a parameter, either side of the `=` at `equals`; or none. */
function equalTerm(
  tokens: readonly Token[],
  equals: number,
  table: string,
  place: Placed,
): Term | undefined {
  const left = tokens.slice(0, equals);
  const right = tokens.slice(equals + 1);
  const leftColumn = columnOf(left, table);
  const column = leftColumn ?? columnOf(right, table);
  const value = place(leftColumn === undefined ? left : right);
  return column === undefined || value === undefined ? undefined : { column, params: [value] };
}

/** The term `tokens` are, of the parameters at `places` (by each token's position); or none. */
function termOf(
  tokens: readonly Token[],
  table: string,
  places: ReadonlyMap<Token, number>,
): Term | undefined {
  const place: Placed = (alone) => {
    const [token] = alone;
    return token !== undefined && alone.length === 1 ? places.get(token) : undefined;
  };
  const equals = tokens.findIndex((token) => isChar(token, '='));
  if (equals !== -1) return equalTerm(tokens, equals, table, place);
  const listed = tokens.findIndex((token) => isWord(token, 'in'));
  if (listed === -1 || !isChar(tokens[listed + 1], '(') || !isChar(tokens.at(-1), ')')) {
    return undefined;
  }
  const column = columnOf(tokens.slice(0, listed), table);
  const items = splitAt(tokens.slice(listed + 2, -1), (token) => isChar(token, ','));
  const params = items.map((item) => place(item));
  if (column === undefined || params.length === 0 || params.includes(undefined)) return undefined;
  return { column, params: params.filter((each) => each !== undefined) };
}

/**
 * Whether `tokens` are a `SELECT` of no `IN` of a table: `x in "t"` is `x in (select * from "t")`,
 * of other rows of the table, which no condition of the statement holds of.
 */
function selectsAlone(tokens: readonly Token[]): boolean {
  return (
    isWord(tokens[0], 'select') &&
    tokens.every((token, at) => !isWord(token, 'in') || isChar(tokens[at + 1], '('))
  );
}

/**
 * The conditions of `sql`, a statement of one table, its terms of the parameters by their places
 * among the statement's; `undefined` where it is no such statement, or is not read plainly.
 */
export function conditionsOf(sql: string): Conditions | undefined {
  const tokens = plainTokensOf(sql);
  if (tokens === undefined || !selectsAlone(tokens)) return undefined;
  const places = placesOf(tokens);
  const after = tokens.slice(1);
  const fromAt = after.findIndex((token) => isWord(token, 'from'));
  if (
    after.some(
      (token) => token.kind === 'word' && REFUSED.has(token.text) && token !== after[fromAt],
    )
  ) {
    return undefined;
  }
  const table = after[fromAt + 1];
  if (fromAt === -1 || table?.kind !== 'name') return undefined;
  // An alias of the table, as Drizzle's relational queries write one (`from "t" "a"`), which the
  // condition's columns are of in its place.
  const aliased = after.slice(fromAt + 2);
  const named = isWord(aliased[0], 'as') ? aliased.slice(1) : aliased;
  const [alias] = named;
  const rest = alias?.kind === 'name' ? named.slice(1) : aliased;
  const of = alias?.kind === 'name' ? alias.text : table.text;
  const ending = rest.findIndex((token) => token.kind === 'word' && CLAUSES.has(token.text));
  const clauses = ending === -1 ? rest : rest.slice(0, ending);
  if (clauses.length === 0) return { table: table.text, terms: [] };
  if (!isWord(clauses[0], 'where')) return undefined;
  const condition = unwrapped(clauses.slice(1));
  // An `OR` of the top level: no term holds of every row read. A `CASE`'s `AND` is no term's.
  if (
    condition.some((token) => isWord(token, 'case')) ||
    splitAt(condition, (token) => isWord(token, 'or')).length > 1
  ) {
    return { table: table.text, terms: [] };
  }
  const terms = (conjunctsOf(condition) ?? []).flatMap((part) => {
    const term = termOf(unwrapped(part), of, places);
    return term === undefined ? [] : [term];
  });
  return { table: table.text, terms };
}

/** Where a run of `sql` ends of the text `closing` it was found at, as `indexOf` found it, or its end. */
function closedAt(sql: string, found: number, closing: string): number {
  return found === -1 ? sql.length : found + closing.length;
}

/** Where the run of text at `at` ends — a quoted name or string, a comment — or `at`, of none. */
function runEnd(sql: string, at: number): number {
  const char = sql[at];
  if (char === "'" || char === '"' || char === '`') return quotedEnd(sql, at) ?? sql.length;
  if (char === '[') return closedAt(sql, sql.indexOf(']', at), ']');
  if (sql.startsWith('--', at)) return closedAt(sql, sql.indexOf('\n', at), '\n');
  if (sql.startsWith('/*', at)) return closedAt(sql, sql.indexOf('*/', at + 2), '*/');
  return at;
}

/** The characters a named parameter begins with (`$a`, `@a`, `:a`, `#a`). */
const NAMED = new Set(['#', '$', ':', '@']);
/** A character of a name, which a named parameter's character within one is not the start of. */
const NAME_CHARACTER = /[\w$\u{80}-\u{10FFFF}]/u;

/**
 * Whether a named parameter begins at `at` of `sql`: SQLite reads one to its own end, past a quote
 * within it (`$a(')`), which this reads not.
 */
function namedAt(sql: string, at: number): boolean {
  const char = sql[at] ?? '';
  // `$` is a character of a name too; `:`, `@` and `#` begin a parameter after a name as well.
  return NAMED.has(char) && (char !== '$' || !NAME_CHARACTER.test(sql[at - 1] ?? ''));
}

/**
 * Whether `sql` is one statement: of no `;` but at its end, outside its strings, quoted names and
 * comments, and of no named parameter, whose own end SQLite reads otherwise. D1 runs each
 * statement of a text, and `EXPLAIN` says what the first one does alone.
 */
export function soleStatement(sql: string): boolean {
  let ended = false;
  let at = 0;
  while (at < sql.length) {
    const char = sql[at] ?? '';
    const comment = sql.startsWith('--', at) || sql.startsWith('/*', at);
    if (namedAt(sql, at)) return false;
    if (ended && !comment && char !== ';' && !/\s/u.test(char)) return false;
    if (char === ';') ended = true;
    at = Math.max(runEnd(sql, at), at + 1);
  }
  return true;
}

/**
 * Whether `sql` reads alone, by its words: one statement, read plainly, of no word of a statement
 * that writes (`INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `CREATE`, …) but in a quoted name or a
 * string — what a `WITH … SELECT` is, and a `WITH … DELETE` is not.
 */
export function readsAlone(sql: string): boolean {
  const tokens = tokensOf(sql);
  return (
    tokens !== undefined &&
    soleStatement(sql) &&
    tokens.every((token) => !(token.kind === 'word' && WRITING.has(token.text)))
  );
}

/**
 * The first word of `sql`, in lower case, past its spaces and comments; none where it begins with
 * no word. A `PRAGMA` is one a render runs not: of a flag (`case_sensitive_like`), it sets the
 * connection's as SQLite compiles it, its plan's `EXPLAIN` too.
 */
export function leadingWord(sql: string): string | undefined {
  let at = 0;
  while (at < sql.length) {
    const comment = sql.startsWith('--', at) || sql.startsWith('/*', at);
    if (!comment && !/\s/u.test(sql[at] ?? '')) break;
    at = comment ? runEnd(sql, at) : at + 1;
  }
  WORD.lastIndex = at;
  return WORD.exec(sql)?.[0].toLowerCase();
}

/** The characters a quoted name begins with: read whole, of what is within it. */
const QUOTED_NAME = new Set(['"', '[', '`']);
/** A string's text that may name one of SQLite's `pragma_` functions, where a name stands. */
const PRAGMA_STRING = /^'pragma_/iu;

/**
 * Whether `sql` names one of SQLite's `pragma_` functions, which a render reads not: outside its
 * comments, quoted or not — a name quoted is a function's as well as a column's, and a column or a
 * table of such a name is one a render's text names not — and in a string that begins with one,
 * which SQLite reads as a name where a name stands (`from 'pragma_optimize'()`).
 */
export function namesPragmaFunction(sql: string): boolean {
  let named = '';
  let at = 0;
  while (at < sql.length) {
    const end = Math.max(runEnd(sql, at), at + 1);
    const run = sql.slice(at, end);
    // A run is read whole — a quoted name's `--` or `'` begins nothing — and a comment, or a
    // string of no such name, stands as a space.
    if (run.length === 1 || QUOTED_NAME.has(sql[at] ?? '')) {
      named += run.length === 1 ? run : ` ${run}`;
    } else {
      named += sql[at] === "'" && PRAGMA_STRING.test(run) ? ` ${run.slice(1)}` : ' ';
    }
    at = end;
  }
  return PRAGMA_FUNCTION.test(named);
}

/**
 * `sql` of its strings as `''`, its quoted names as `""` and its comments as a space: its words
 * and its keywords alone, none of which a string or a name holds.
 */
export function bareOf(sql: string): string {
  let bare = '';
  let at = 0;
  while (at < sql.length) {
    const char = sql[at] ?? '';
    const end = Math.max(runEnd(sql, at), at + 1);
    if (end === at + 1) {
      bare += char;
    } else if (char === "'") {
      bare += "''";
    } else {
      bare += QUOTED_NAME.has(char) ? '""' : ' ';
    }
    at = end;
  }
  return bare;
}
