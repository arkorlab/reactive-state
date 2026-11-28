import { sqlTokens } from './lex.ts';

/**
 * Whether a statement's text gives a table's columns names of its own (`FROM users AS u(email,
 * id)`). A plan writes a column by the name the statement gave it, which may be another column's
 * name, so no condition of such a statement is followed. The text is read as PostgreSQL lexes it —
 * its comments, strings, dollar-quoted bodies and quoted names left out — and a text that cannot be
 * read so is taken for one that does. Drizzle writes no such list.
 */

/** A word's first character: a name's, as the plain text holds it. */
const WORD = /^[a-z_\P{ASCII}]/u;
/**
 * PostgreSQL's reserved words, which name no table and no alias of one unquoted: a `CASE WHEN (`
 * or an `AND (` after a comma is no table and its list.
 */
const RESERVED = new Set([
  'all',
  'analyse',
  'analyze',
  'and',
  'any',
  'array',
  'as',
  'asc',
  'asymmetric',
  'authorization',
  'binary',
  'both',
  'case',
  'cast',
  'check',
  'collate',
  'collation',
  'column',
  'concurrently',
  'constraint',
  'create',
  'cross',
  'current_catalog',
  'current_date',
  'current_role',
  'current_schema',
  'current_time',
  'current_timestamp',
  'current_user',
  'default',
  'deferrable',
  'desc',
  'distinct',
  'do',
  'else',
  'end',
  'except',
  'false',
  'fetch',
  'for',
  'foreign',
  'freeze',
  'from',
  'full',
  'grant',
  'group',
  'having',
  'ilike',
  'in',
  'initially',
  'inner',
  'intersect',
  'into',
  'is',
  'isnull',
  'join',
  'lateral',
  'leading',
  'left',
  'like',
  'limit',
  'localtime',
  'localtimestamp',
  'natural',
  'not',
  'notnull',
  'null',
  'offset',
  'on',
  'only',
  'or',
  'order',
  'outer',
  'overlaps',
  'placing',
  'primary',
  'references',
  'returning',
  'right',
  'select',
  'session_user',
  'similar',
  'some',
  'symmetric',
  'system_user',
  'table',
  'tablesample',
  'then',
  'to',
  'trailing',
  'true',
  'union',
  'unique',
  'user',
  'using',
  'variadic',
  'verbose',
  'when',
  'where',
  'window',
  'with',
]);
/** Whether `token` is a name: a word, or `"` (`` ` `` of Unicode escapes) of a quoted one. */
function isName(token: string | undefined): token is string {
  return token !== undefined && (token === '"' || token === '`' || WORD.test(token));
}

/**
 * The words of a level of the text after which a `FROM` list's tables stand: its own, a join's, and
 * `USING`'s — of a `DELETE`, a `MERGE`, or a join's columns, a list of names.
 */
const FROM_OPENERS = new Set(['from', 'join', 'using']);
/**
 * The words that end a `FROM` list of the level they stand in: reserved words all but `values`,
 * none of which names a table or an alias unquoted but after a `.` (`public.where`).
 */
const FROM_CLOSERS = new Set([
  'except',
  'fetch',
  'for',
  'group',
  'having',
  'intersect',
  'into',
  'limit',
  'offset',
  'order',
  'returning',
  'select',
  'union',
  'values',
  'where',
  'window',
]);
/**
 * The words that open a join's condition: the `FROM` list goes on after it, at a comma or a join of
 * its level.
 */
const JOIN_CONDITIONS = new Set(['on']);
/**
 * The closing words an expression holds out of parentheses, by the word before them: `WITHIN GROUP`
 * and `COLLATION FOR`.
 */
const EXPRESSION_WORDS: ReadonlyMap<string, string> = new Map([
  ['for', 'collation'],
  ['group', 'within'],
]);
/** The calls within whose parentheses `AS` names a type, not an alias: `CAST (x AS varchar (10))`. */
const TYPED = new Set(['cast', 'treat']);

/**
 * Whether the `)` at `at` closes `ONLY`'s parentheses around a table's name: `ONLY (users)`,
 * `ONLY (public.users)`.
 */
function closesOnly(tokens: readonly string[], at: number): boolean {
  let index = at - 1;
  if (!isName(tokens[index])) return false;
  while (tokens[index - 1] === '.' && isName(tokens[index - 2])) index -= 2;
  return tokens[index - 1] === '(' && tokens[index - 2] === 'only';
}

/**
 * Whether the tokens before `at`, a name that `(` follows within a `FROM` list, are a table's name
 * and an alias of it: the name — quoted, of its schema (a reserved word too, after a `.`), `ONLY`
 * or not, of its descendants (`*`) or not — after `FROM`, a join, a comma or a join's parenthesis,
 * then `AS` or not. After a call's or a subquery's `)`, the list names a call's or a subquery's
 * columns, which a plan writes of their own.
 */
function aliasedAt(tokens: readonly string[], at: number): boolean {
  let index = at - 1;
  // `AS`, not a table's name (`public.as u(a)`).
  if (tokens[index] === 'as' && tokens[index - 1] !== '.') index -= 1;
  if (tokens[index] === ')') return closesOnly(tokens, index);
  if (tokens[index] === '*') index -= 1;
  if (!isName(tokens[index])) return false;
  const qualified = tokens[index - 1] === '.';
  if (!qualified && RESERVED.has(tokens[index] ?? '')) return false;
  while (tokens[index - 1] === '.' && isName(tokens[index - 2])) index -= 2;
  if (tokens[index - 1] === 'only') index -= 1;
  const before = tokens[index - 1] ?? '';
  return FROM_OPENERS.has(before) || before === ',' || before === '(';
}

/**
 * Whether `values` between `prior` and `next`, within a `FROM` list, is a name — a table's
 * (`FROM values`, `(values AS u(a) JOIN …)`), an alias (`AS values`, `members values`,
 * `ONLY (tasks) values`, `tasks * values`), a column of a join's condition — not the list of rows
 * it opens after a `(` and before one (`FROM (VALUES (1)) AS v(a)`): a list of rows stands nowhere
 * else within one. Outside one, the word ends none.
 */
function namesValues(prior: string, next: string): boolean {
  return prior !== '(' || next !== '(';
}

/**
 * Whether `word`, between `prior` and `next`, ends a `FROM` list: a closing word, but `values` that
 * names a table or an alias, and the closing words of an expression's own that stand in a join's
 * condition or a `FROM` list's function: `group` of an aggregate's `WITHIN GROUP`, and `for` of
 * `COLLATION FOR (…)`.
 */
function closes(word: string, prior: string, next: string): boolean {
  if (!FROM_CLOSERS.has(word)) return false;
  if (word === 'values') return !namesValues(prior, next);
  return EXPRESSION_WORDS.get(word) !== prior;
}

/**
 * Of one level of the text's parentheses: whether it is in a `FROM` list, in a join's condition
 * within one, or in neither; and whether it is in a `CAST`'s.
 */
interface Level {
  from: 'condition' | 'list' | 'none';
  readonly typed: boolean;
}

/** Whether a FROM call declares record column types, which are outside the admission contract. */
export function hasTypedRecordColumns(tokens: readonly string[]): boolean {
  const levels: Level[] = [{ from: 'none', typed: false }];
  const names = tokens.map((token) => (token.startsWith('"') ? '"' : token));
  for (const at of names.keys()) {
    if (names[at] === '(' && levels.at(-1)?.from === 'list' && recordColumnsAt(names, at))
      return true;
    moved(levels, names, at);
  }
  return false;
}

/** Whether a call's closing parenthesis, optional AS and alias precede typed column definitions. */
function recordColumnsAt(tokens: readonly string[], at: number): boolean {
  let prior = at - 1;
  if (tokens[prior] !== 'as') {
    if (!isName(tokens[prior]) || RESERVED.has(tokens[prior] ?? '')) return false;
    prior -= 1;
  }
  if (tokens[prior] === 'as') prior -= 1;
  return tokens[prior] === ')' && isName(tokens[at + 1]) && isName(tokens[at + 2]);
}

/** Whether `sql` gives a table's columns names of its own, or cannot be read to tell. */
export function renamesColumns(sql: string, conforming = false): boolean {
  const plain = sqlTokens(sql, conforming);
  if (plain === undefined) return true;
  // `UESCAPE` and its string follow a name of Unicode escapes alone: of no meaning here, as the
  // name is `` ` `` alone. A word `uescape` after anything else is a name of its own.
  const all = plain
    .filter((token) => token !== "'")
    .map((token) => (token.startsWith('"') ? '"' : token));
  const tokens = all.filter((each, at) => each !== 'uescape' || all[at - 1] !== '`');
  const levels: Level[] = [{ from: 'none', typed: false }];
  for (const at of tokens.keys()) {
    if (!moved(levels, tokens, at) && listedAt(tokens, at, levels.at(-1))) return true;
  }
  return false;
}

/**
 * Moves `levels` by the token at `at` — a parenthesis, a word that opens or ends a `FROM` list —
 * and whether it was one such.
 */
function moved(levels: Level[], tokens: readonly string[], at: number): boolean {
  const word = tokens[at] ?? '';
  const prior = tokens[at - 1] ?? '';
  const level = levels.at(-1);
  if (word === '(') {
    // A join's parenthesis, of a `FROM` list as its level is, or a call's, a list's, a type's.
    const joined =
      level?.from === 'list' && (FROM_OPENERS.has(prior) || prior === ',' || prior === '(');
    levels.push({ from: joined ? 'list' : 'none', typed: TYPED.has(prior) });
    return true;
  }
  if (word === ')') {
    if (levels.length > 1) levels.pop();
    return true;
  }
  // A word after a `.` is a name — a table's, `public.on` — whatever word it is: a number's `.`
  // is its own (`1.`).
  return (
    level !== undefined && prior !== '.' && wordMoved(level, word, prior, tokens[at + 1] ?? '')
  );
}

/**
 * Moves `level` by `word`, between `prior` and `next`, if it opens or ends a `FROM` list, and
 * whether it did.
 */
function wordMoved(level: Level, word: string, prior: string, next: string): boolean {
  if (FROM_OPENERS.has(word) || (word === ',' && level.from === 'condition')) {
    level.from = 'list';
    return true;
  }
  if (JOIN_CONDITIONS.has(word) && level.from === 'list') {
    level.from = 'condition';
    return true;
  }
  if (closes(word, prior, next)) {
    level.from = 'none';
    return true;
  }
  return false;
}

/** Whether the name at `at`, of the level `level`, is an alias of a table that names its columns. */
function listedAt(tokens: readonly string[], at: number, level: Level | undefined): boolean {
  const word = tokens[at];
  return (
    tokens[at + 1] === '(' &&
    level?.from === 'list' &&
    !level.typed &&
    isName(word) &&
    !RESERVED.has(word) &&
    aliasedAt(tokens, at)
  );
}
