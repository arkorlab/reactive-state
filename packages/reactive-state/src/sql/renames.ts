/**
 * Whether a statement's text gives a table's columns names of its own (`FROM users AS u(email,
 * id)`). A plan writes a column by the name the statement gave it, which may be another column's
 * name, so no condition of such a statement is followed. The text is read as PostgreSQL lexes it —
 * its comments, strings, dollar-quoted bodies and quoted names left out — and a text that cannot be
 * read so is taken for one that does. Drizzle writes no such list.
 */

/**
 * A token of the plain text: a parameter (`$1`), whose `.` is a field's (`$1. where`); a number, its
 * `.` its own — of a fraction, an exponent, `_` between its digits, of hex, octal or binary digits
 * (`1.`, `.5e3`, `1_000.`, `0x1f`), of which no name PostgreSQL reads follows on — a word, `"` of a
 * quoted name, or another character but a space.
 */
const TOKEN = /\$\d+|\.?\d[\w.]*|[a-z_\P{ASCII}][\w$\P{ASCII}]*|\S/gu;
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
/** What opens a quoted name or a string of Unicode escapes, before its quote, as plain characters. */
const UNICODE = ['u', '&'] as const;
/** A dollar quote's opening: `$$` or `$tag$`, where it is looked for. */
const DOLLAR = /\$(?:[A-Z_\P{ASCII}][\w\P{ASCII}]*)?\$/iuy;
/** A line's end, of either character PostgreSQL ends a comment of a line at. */
const LINE_END = /[\n\r]/gu;
/** A space PostgreSQL reads between two tokens. */
const SPACE = /[ \t\n\r\f\v]/u;
/** The letters of a string's own before its quote: `B'…'`, `E'…'`, `N'…'`, `X'…'`. */
const PREFIXES: ReadonlySet<string> = new Set(['b', 'e', 'n', 'x']);
/** The letter of a string of escapes before its quote: `E'…'`. */
const ESCAPES: ReadonlySet<string> = new Set(['e']);
/** A character a word holds, before which an `E` of a string of escapes is no word's own. */
const WORD_PART = /[\w$\P{ASCII}]/u;

/** Where a quoted run from `at` ends, its quote doubled within it — of `\` escapes too, if `escapes`. */
function quotedEnd(sql: string, at: number, escapes: boolean): number | undefined {
  const quote = sql[at];
  let index = at + 1;
  while (index < sql.length) {
    const char = sql[index];
    if ((escapes && char === '\\') || (char === quote && sql[index + 1] === quote)) {
      index += 2;
    } else if (char === quote) {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return undefined;
}

/** Where a block comment from `at` ends, of the comments nested in it. */
function commentEnd(sql: string, at: number): number | undefined {
  let depth = 0;
  let index = at;
  while (index < sql.length) {
    const pair = sql.slice(index, index + 2);
    if (pair === '/*') {
      depth += 1;
      index += 2;
    } else if (pair === '*/') {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
    } else {
      index += 1;
    }
  }
  return undefined;
}

/** Where a dollar-quoted body from `at` ends; `at` itself where no dollar quote opens there. */
function dollarEnd(sql: string, at: number): number | undefined {
  DOLLAR.lastIndex = at;
  const [opening] = DOLLAR.exec(sql) ?? [];
  if (opening === undefined) return at;
  const closing = sql.indexOf(opening, at + opening.length);
  return closing === -1 ? undefined : closing + opening.length;
}

/**
 * Where the run from `at` that the plain text leaves out ends — a comment, a string, a quoted name,
 * a dollar-quoted body — or `at` where none opens there; `undefined` where one never ends.
 */
function skippedTo(
  sql: string,
  at: number,
  conforming: boolean,
  plain: readonly string[],
): number | undefined {
  const char = sql[at];
  const pair = sql.slice(at, at + 2);
  if (pair === '--') {
    LINE_END.lastIndex = at;
    return LINE_END.exec(sql)?.index ?? sql.length;
  }
  if (pair === '/*') return commentEnd(sql, at);
  if (char === '"') return quotedEnd(sql, at, false);
  if (char === "'") return stringEnd(sql, at, conforming, plain);
  // A `$` within a name (`foo$x$`) opens no dollar quote, as PostgreSQL reads it: of the plain
  // text's character before it, which a run left out is no word's (`$$!$$$q$`).
  return char === '$' && !WORD_PART.test(plain.at(-1) ?? '') ? dollarEnd(sql, at) : at;
}

/**
 * Where a string from `at` ends, after `plain`, the plain text before it; `undefined` where it
 * never does, or cannot be read to tell.
 */
function stringEnd(
  sql: string,
  at: number,
  conforming: boolean,
  plain: readonly string[],
): number | undefined {
  const escapes = opensToken(plain, ESCAPES);
  const end = quotedEnd(sql, at, escapes);
  if (end === undefined) return undefined;
  // A string of escapes that goes on after a line's end, whose rest PostgreSQL reads of escapes too.
  if (escapes && continuedAt(sql, end)) return undefined;
  // A string of a `\` that is no string of escapes: where `standard_conforming_strings` is off,
  // or not known on, PostgreSQL may read its `\'` as a quote, and its end elsewhere — a text that
  // cannot be read.
  return !conforming && !escapes && sql.slice(at, end).includes('\\') ? undefined : end;
}

/**
 * Whether a string that ends at `at` goes on in another, as PostgreSQL joins two of a line's end
 * between them: spaces and comments of a line, then a quote.
 */
function continuedAt(sql: string, at: number): boolean {
  let index = at;
  while (index < sql.length) {
    if (SPACE.test(sql[index] ?? '')) {
      index += 1;
    } else if (sql.startsWith('--', index)) {
      LINE_END.lastIndex = index;
      index = LINE_END.exec(sql)?.index ?? sql.length;
    } else {
      return sql[index] === "'";
    }
  }
  return false;
}

/**
 * `sql` in lower case, of no comment, string or dollar-quoted body, each quoted name a `"` — one of
 * Unicode escapes (`U&"x"`) a `` ` ``, after which `UESCAPE` may stand.
 */
function plainOf(sql: string, conforming: boolean): string | undefined {
  const plain: string[] = [];
  let at = 0;
  while (at < sql.length) {
    const end = skippedTo(sql, at, conforming, plain);
    if (end === undefined) return undefined;
    if (end === at) {
      plain.push(lowered(sql[at] ?? ''));
      at += 1;
    } else {
      placed(plain, sql[at] ?? '');
      at = end;
    }
  }
  return plain.join('');
}

/**
 * `char` in lower case as PostgreSQL folds a name of UTF-8: of `A` to `Z` alone — the Kelvin sign
 * (U+212A) is no `k`, as JavaScript would fold it, which `liKe` would make a reserved word of.
 */
function lowered(char: string): string {
  return char >= 'A' && char <= 'Z' ? char.toLowerCase() : char;
}

/**
 * Puts after `plain`, the plain text's characters, the placeholder of a run it leaves out, which
 * `opening` opens: `"` of a quoted name, `` ` `` of one of Unicode escapes (its `U&` taken off), a
 * space of any other — a string's letter before its quote taken off too (`E'!'`).
 */
function placed(plain: string[], opening: string): void {
  const quoted = opening === '"' || opening === "'";
  const at = plain.length - UNICODE.length;
  // `U&` that opens a token before a quote: of a word that ends in `u` (`foru&'1'`), or before a
  // comment or a dollar body (`t.u&$$1$$`), `u` and `&` are tokens of their own.
  const escaped =
    quoted &&
    UNICODE.every((char, index) => plain[at + index] === char) &&
    !WORD_PART.test(plain[at - 1] ?? '');
  if (escaped) {
    plain.splice(at);
  } else if (opening === "'" && opensToken(plain, PREFIXES)) {
    plain.pop();
  }
  if (opening === '"') {
    plain.push(escaped ? '`' : '"');
  } else {
    plain.push(' ');
  }
}

/** Whether `plain` ends in one of `letters` that opens a token: of no word's character before it. */
function opensToken(plain: readonly string[], letters: ReadonlySet<string>): boolean {
  const last = plain.length - 1;
  return letters.has(plain[last] ?? '') && !WORD_PART.test(plain[last - 1] ?? '');
}

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

/** Whether `sql` gives a table's columns names of its own, or cannot be read to tell. */
export function renamesColumns(sql: string, conforming = false): boolean {
  const plain = plainOf(sql, conforming);
  if (plain === undefined) return true;
  // `UESCAPE` and its string follow a name of Unicode escapes alone: of no meaning here, as the
  // name is `` ` `` alone. A word `uescape` after anything else is a name of its own.
  const all = plain.match(TOKEN) ?? [];
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
