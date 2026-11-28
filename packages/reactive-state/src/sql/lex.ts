/** SQL tokens shared by column-alias detection and the followed client's admission guards. */

/**
 * A token of the plain text between its quoted names: a parameter (`$1`), whose `.` is a field's
 * (`$1. where`); a number, its `.` its own — of a fraction, an exponent, `_` between its digits, of
 * hex, octal or binary digits (`1.`, `.5e3`, `1_000.`, `0x1f`), of which no name PostgreSQL reads
 * follows on — a word, or another character but a space.
 */
const TOKEN = /\$\d+|\.?\d[\w.]*|[a-z_\P{ASCII}][\w$\P{ASCII}]*|\S/gu;
/** A quoted name of the plain text, its quotes doubled within it (`"a""b"`): a token of its own. */
const QUOTED = /(?:"[^"]*")+/gu;
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

/** A string or a dollar-quoted body of a text, as it was written between its quotes. */
export interface QuotedRun {
  /** Whether it is a dollar-quoted body (`$$…$$`) and not a string (`'…'`). */
  readonly dollar: boolean;
  readonly text: string;
}

/** Keeps in `runs` the string or dollar-quoted body that runs from `at` to `end` of `sql`. */
function keepRun(sql: string, at: number, end: number, runs: QuotedRun[]): void {
  if (sql[at] === "'") {
    runs.push({ dollar: false, text: sql.slice(at + 1, end - 1) });
    return;
  }
  DOLLAR.lastIndex = at;
  const [opening] = DOLLAR.exec(sql) ?? [];
  if (opening !== undefined) {
    runs.push({ dollar: true, text: sql.slice(at + opening.length, end - opening.length) });
  }
}

/**
 * `sql` in lower case, of no comment, string or dollar-quoted body, each quoted name a `"` — one of
 * Unicode escapes (`U&"x"`) a `` ` ``, after which `UESCAPE` may stand.
 */
function plainOf(sql: string, conforming: boolean, runs?: QuotedRun[]): string | undefined {
  const plain: string[] = [];
  let at = 0;
  while (at < sql.length) {
    const end = skippedTo(sql, at, conforming, plain);
    if (end === undefined) return undefined;
    if (end === at) {
      plain.push(lowered(sql[at] ?? ''));
      at += 1;
    } else {
      if (runs !== undefined && (sql[at] === "'" || sql[at] === '$')) keepRun(sql, at, end, runs);
      if (sql[at] === '"' && !opensUnicode(plain)) {
        plain.push('"', sql.slice(at + 1, end - 1), '"');
      } else {
        placed(plain, sql[at] ?? '');
      }
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
  } else if (opening === "'" || opening === '$') {
    plain.push("'");
  } else {
    plain.push(' ');
  }
}

/** Whether `plain` ends in one of `letters` that opens a token: of no word's character before it. */
function opensToken(plain: readonly string[], letters: ReadonlySet<string>): boolean {
  const last = plain.length - 1;
  return letters.has(plain[last] ?? '') && !WORD_PART.test(plain[last - 1] ?? '');
}

/** Whether the quote after `plain` is of Unicode escapes, whose decoded name is unknown. */
function opensUnicode(plain: readonly string[]): boolean {
  const at = plain.length - UNICODE.length;
  return (
    UNICODE.every((char, index) => plain[at + index] === char) &&
    !WORD_PART.test(plain[at - 1] ?? '')
  );
}

/**
 * SQL's tokens outside comments: literal values as a quote, unquoted names folded as PostgreSQL
 * folds them, quoted names kept with their quotes, and a Unicode-escaped name as a backtick. Nothing
 * where the session's string syntax is unknown and could put a literal's end elsewhere.
 */
export function sqlTokens(sql: string, conforming: boolean): readonly string[] | undefined {
  const plain = plainOf(sql, conforming);
  if (plain === undefined) return undefined;
  const tokens: string[] = [];
  let at = 0;
  for (const quoted of plain.matchAll(QUOTED)) {
    pushTokens(tokens, plain.slice(at, quoted.index));
    tokens.push(quoted[0]);
    at = quoted.index + quoted[0].length;
  }
  pushTokens(tokens, plain.slice(at));
  return tokens;
}

/**
 * Each string and dollar-quoted body of `sql`, in the order the `'` of its tokens stand for them
 * (`sqlTokens`): the code a `DO` block runs is written in one of them. Nothing where the text
 * cannot be read, as `sqlTokens` says.
 */
export function quotedRuns(sql: string, conforming: boolean): readonly QuotedRun[] | undefined {
  const runs: QuotedRun[] = [];
  return plainOf(sql, conforming, runs) === undefined ? undefined : runs;
}

/**
 * Puts the tokens of `text`, plain text between quoted names, after `tokens` one by one: a bulk
 * write's statement holds more of them than a call takes arguments.
 */
function pushTokens(tokens: string[], text: string): void {
  for (const [token] of text.matchAll(TOKEN)) tokens.push(token);
}

/** A token's identifier, unquoted and preserving a quoted name's case. */
export function identifierOf(word: string | undefined): string | undefined {
  if (word === undefined) return undefined;
  if (word.startsWith('"')) return word.slice(1, -1).replaceAll('""', '"');
  return /^[a-z_\P{ASCII}]/u.test(word) ? word : undefined;
}
