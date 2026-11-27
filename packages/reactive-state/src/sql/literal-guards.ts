import { identifierOf } from './lex.ts';

/** PostgreSQL's keyword categories, carried by the existing first-plan catalog response. */
export interface TypeKeywords {
  readonly all: ReadonlySet<string>;
  /** Reserved and column-only words: none can name a user-defined type unquoted. */
  readonly nonTypes: ReadonlySet<string>;
  /** Reserved words alone: none names a column unquoted. */
  readonly reserved: ReadonlySet<string>;
}

/** Conservative syntax exceptions where no catalog keyword metadata was supplied. */
const SYNTAX = new Set([
  'all',
  'and',
  'as',
  'asymmetric',
  'between',
  'both',
  'case',
  'distinct',
  'else',
  'from',
  'in',
  'leading',
  'not',
  'on',
  'or',
  'placing',
  'select',
  'symmetric',
  'then',
  'to',
  'trailing',
  'using',
  'values',
  'when',
  'where',
]);
/** Keyword expressions that are values or end one, rather than a preceding type-name position. */
const VALUES = new Set([
  'current_catalog',
  'current_date',
  'current_role',
  'current_schema',
  'current_time',
  'current_timestamp',
  'current_user',
  'end',
  'false',
  'localtime',
  'localtimestamp',
  'null',
  'session_user',
  'system_user',
  'true',
  'user',
]);
const OPERATORS = new Set(['escape', 'ilike', 'like']);
/**
 * The words neither reserved nor column-only that PostgreSQL's grammar puts directly before an
 * expression, a closed set — but for `path`, of `XMLTABLE`, which is refused whole: in its context
 * each is syntax, a typed literal may follow it, and it proves no operand. Any other such word
 * before a literal operator is a column of its name.
 */
const LEADS = new Set([
  'by',
  'content',
  'document',
  'escape',
  'first',
  'groups',
  'ilike',
  'like',
  'next',
  'passing',
  'range',
  'ref',
  'return',
  'rows',
  'similar',
  'value',
  'version',
  'zone',
]);
/** The words of `LEADS` that are syntax wherever they stand. */
const ANYWHERE = new Set(['escape', 'ilike', 'like', 'return', 'similar']);
/** The words a window's frame opens with, before its bound (`ROWS '1' PRECEDING`). */
const FRAMES = new Set(['groups', 'range', 'rows']);
/** The call of a window's proved parentheses, which no function's name is. */
export const WINDOW = '(window)';
/**
 * The call of `OVER (` after `operator(…)`: a window where the grammar takes that for a function's
 * call (`xmlexists(operator(*) OVER (…) …`), or a function `over`'s where it takes it for the prefix
 * clause. In them a frame's word proves neither reading: no syntax, and no column.
 */
export const UNPROVEN_WINDOW = '(window?)';
/** A character of an operator's, as `ORDER BY x USING <` ends in one. */
const OPERATOR_CHARACTER = /^[!#%&*+/<=>?@^|~-]$/u;
const JSON_OBJECTS = new Set(['json_object', 'json_objectagg']);
const JSON_PATHS = new Set(['json_exists', 'json_query', 'json_value']);
const XML_INPUTS = new Set(['xmlparse', 'xmlserialize']);
const VARYING = new Set(['bit', 'char', 'character', 'nchar']);
/** The tokens of a schema-qualified name. */
const QUALIFIED = { width: 3 } as const;

/**
 * Whether the parentheses from `at` to `closing` are a clause an expression begins after, no operand
 * of their own: of no qualified word, a name's (`pg_temp.operator(3)`), and an `OPERATOR(…)` of an
 * operator, as `operator(3)` of a type's modifiers is none.
 */
function opensClause(tokens: readonly string[], at: number, closing: number): boolean {
  const [before, first] = [tokens[at - 2], tokens[at - 1]];
  if (first === 'operator') {
    return before !== '.' && OPERATOR_CHARACTER.test(tokens[closing - 1] ?? '');
  }
  if (tokens[at - QUALIFIED.width] === '.') return false;
  return (first === 'on' && before === 'distinct') || (first === 'with' && before === 'returning');
}

/** Where the `(` of the `)` at `at` stands. */
function openingOf(tokens: readonly string[], at: number): number | undefined {
  let depth = 0;
  for (let index = at; index >= 0; index -= 1) {
    if (tokens[index] === ')') depth += 1;
    if (tokens[index] === '(') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

/** Whether the `)` at `at` closes `DISTINCT ON (…)`, `OPERATOR(…)` or `RETURNING WITH (…)`. */
function closesClause(tokens: readonly string[], at: number): boolean {
  if (tokens[at] !== ')') return false;
  const opening = openingOf(tokens, at);
  return opening !== undefined && opensClause(tokens, opening, at);
}

/** The call of the parentheses that `OVER (` opens at `at`, a window's where that is proved. */
function overCallAt(tokens: readonly string[], at: number): string | undefined {
  if (tokens[at - 2] !== ')') return undefined;
  if (!closesClause(tokens, at - 2)) return WINDOW;
  const opening = openingOf(tokens, at - 2) ?? 0;
  return tokens[opening - 1] === 'operator' ? UNPROVEN_WINDOW : undefined;
}

/**
 * The window's call of the `(` at `at`, where it opens one: after a call's `)` and `OVER` (`over(`
 * alone is a function of that name), or of a `WINDOW` clause's definitions (`WINDOW w AS (`,
 * `, v AS (`), which a CTE's or a generated column's `AS (` is none of.
 */
export function windowCallAt(tokens: readonly string[], at: number): string | undefined {
  if (tokens[at - 1] === 'over') return overCallAt(tokens, at);
  let opening: number | undefined = at;
  while (opening !== undefined && tokens[opening - 1] === 'as' && tokens[opening - 2] !== '.') {
    const before = opening - QUALIFIED.width;
    if (tokens[before] === 'window') return WINDOW;
    if (tokens[before] !== ',' || tokens[before - 1] !== ')') return undefined;
    opening = openingOf(tokens, before - 1);
  }
  return undefined;
}

/** Whether a word of `LEADS` is syntax by the word before it. */
function clauseWordAfter(word: string, prior: string): boolean {
  if (word === 'first' || word === 'next') return prior === 'fetch';
  if (word === 'ref' || word === 'value') return prior === 'by';
  return word === 'by' && (prior === 'order' || prior === 'group' || prior === 'partition');
}

/** Whether a word of `LEADS` is syntax of the call or the parentheses it stands in. */
function clauseWordOf(word: string, call: string): boolean {
  if (FRAMES.has(word)) return call === WINDOW || call === UNPROVEN_WINDOW;
  if (word === 'passing') return call === 'xmlexists' || JSON_PATHS.has(call);
  if (word === 'value') return JSON_OBJECTS.has(call);
  if (word === 'version') return call === 'xmlroot';
  return (word === 'content' || word === 'document') && XML_INPUTS.has(call);
}

/** Whether a word of `LEADS` at `at` is syntax where it stands, not a column of its name. */
function leadAt(tokens: readonly string[], at: number, call = ''): boolean {
  const word = tokens[at] ?? '';
  if (ANYWHERE.has(word)) return true;
  const prior = tokens[at - 1] ?? '';
  if (word === 'zone') return prior === 'time' && tokens[at - 2] === 'at';
  return clauseWordAfter(word, prior) || clauseWordOf(word, call);
}

/**
 * Whether the bare word at `at` proves an operand: of no keyword, or a field after a dot, or a
 * keyword a column may be named by that its context makes no syntax. The reserved words and
 * `BETWEEN`, the one column-only word before an expression, prove none.
 */
function wordValueAt(
  tokens: readonly string[],
  at: number,
  keywords: TypeKeywords | undefined,
  call: string | undefined,
): boolean {
  const token = tokens[at] ?? '';
  if (keywords === undefined || identifierOf(token) === undefined) return false;
  if (tokens[at - 1] === '.' || !keywords.all.has(token)) return true;
  if (keywords.nonTypes.has(token)) return token !== 'between' && !keywords.reserved.has(token);
  return !LEADS.has(token) || !leadAt(tokens, at, call);
}

/** Whether a token proves an operand before a literal operator, rather than another syntax word. */
function valueAt(
  tokens: readonly string[],
  at: number,
  keywords: TypeKeywords | undefined,
  call: string | undefined,
): boolean {
  const token = tokens[at] ?? '';
  if (closesClause(tokens, at)) return false;
  if (token === ')' || token === ']' || token === "'" || /^\.?[\d$]/u.test(token)) return true;
  if (VALUES.has(token) || token.startsWith('"') || endsCast(tokens, at)) return true;
  return wordValueAt(tokens, at, keywords, call);
}

/** Whether the operand ends in the type name of a cast already checked by the caller. */
function endsCast(tokens: readonly string[], at: number): boolean {
  let index = at;
  if (identifierOf(tokens[index]) === undefined) return false;
  while (tokens[index - 1] === '.' && identifierOf(tokens[index - 2]) !== undefined) index -= 2;
  return tokens[index - 1] === ':' && tokens[index - 2] === ':';
}

/** Built-in multiword type spellings and clause words before a literal. */
function fixedSyntaxAt(tokens: readonly string[], at: number): boolean {
  const word = tokens[at];
  const prior = tokens[at - 1];
  if (word === 'by' && (prior === 'order' || prior === 'group' || prior === 'partition'))
    return true;
  if (word === 'precision' && prior === 'double') return true;
  // A row count's: `FETCH FIRST '1' ROWS ONLY`, `FETCH NEXT '1' ROWS ONLY`.
  if (prior === 'fetch' && (word === 'first' || word === 'next')) return true;
  // A Unicode string's escape character (`U&'d!0061t' UESCAPE '!'`): no type's name follows a
  // literal it is no operand of.
  if (word === 'uescape' && prior === "'") return true;
  if (word === 'varying' && VARYING.has(prior ?? '')) return true;
  if (word !== 'zone' || prior !== 'time') return false;
  const before = tokens[at - 2];
  return before === 'at' || before === 'with' || before === 'without';
}

/** Whether the tokens before `at` are `USING` and its operator, an end of a window's `ORDER BY`. */
function afterUsing(tokens: readonly string[], at: number): boolean {
  let index = at - 1;
  if (tokens[index] === ')') {
    index = (openingOf(tokens, index) ?? 0) - 1;
    if (tokens[index] !== 'operator') return false;
    index -= 1;
    return tokens[index] === 'using' && tokens[index - 1] !== '.';
  }
  while (index >= 0 && OPERATOR_CHARACTER.test(tokens[index] ?? '')) index -= 1;
  return index < at - 1 && tokens[index] === 'using' && tokens[index - 1] !== '.';
}

/** Whether the tokens before `at` end a window's `ORDER BY` of a direction or of `NULLS`' order. */
function afterOrder(tokens: readonly string[], at: number): boolean {
  const prior = tokens[at - 1];
  if (prior === 'asc' || prior === 'desc') return true;
  return (prior === 'first' || prior === 'last') && tokens[at - 2] === 'nulls';
}

/** Whether the bound after the frame's word at `at` runs to `PRECEDING` within its parentheses. */
function boundEnds(tokens: readonly string[], at: number): boolean {
  let depth = 0;
  for (let index = at + 1; index < tokens.length; index += 1) {
    if (tokens[index] === '(') depth += 1;
    if (tokens[index] === ')') {
      if (depth === 0) return false;
      depth -= 1;
    }
    if (depth === 0 && tokens[index] === 'preceding') return true;
  }
  return false;
}

/**
 * Whether the word at `at` opens a window's frame before a literal bound (`ROWS '1' PRECEDING`,
 * `RANGE '1 day'::interval PRECEDING`): in a window's parentheses, at their start or after a proved
 * end of its `ORDER BY`. The bound's `PRECEDING` proves nothing alone, as a typed literal may take
 * it for its alias (`SELECT rows '1' preceding`).
 */
function frameAt(
  tokens: readonly string[],
  at: number,
  call: string | undefined,
  keywords: TypeKeywords | undefined,
): boolean {
  if (call !== WINDOW) return false;
  if (!FRAMES.has(tokens[at] ?? '') || !boundEnds(tokens, at)) return false;
  if (tokens[at - 1] === '(' || afterOrder(tokens, at) || afterUsing(tokens, at)) return true;
  return valueAt(tokens, at - 1, keywords, call);
}

/**
 * Whether the word at `at` ends XMLEXISTS's `PASSING` before its XML operand — `PASSING`, or
 * `PASSING BY REF` or `BY VALUE` — after a proved path operand.
 */
function xmlPassingAt(
  tokens: readonly string[],
  at: number,
  keywords: TypeKeywords | undefined,
): boolean {
  const word = tokens[at];
  let passing = at;
  if ((word === 'ref' || word === 'value') && tokens[at - 1] === 'by') passing = at - 2;
  return tokens[passing] === 'passing' && valueAt(tokens, passing - 1, keywords, 'xmlexists');
}

/** Context-specific JSON and XML words, which can also name user-defined types elsewhere. */
function namedSyntaxAt(
  tokens: readonly string[],
  at: number,
  call: string | undefined,
  keywords: TypeKeywords | undefined,
): boolean {
  const word = tokens[at];
  const prior = tokens[at - 1];
  if (word === 'passing' && call !== undefined && JSON_PATHS.has(call))
    return valueAt(tokens, at - 1, keywords, call);
  if (word === 'value' && JSON_OBJECTS.has(call ?? '') && valueAt(tokens, at - 1, keywords, call))
    return true;
  if (call === 'xmlexists' && xmlPassingAt(tokens, at, keywords)) return true;
  if (prior === '(' && call !== undefined && XML_INPUTS.has(call))
    return word === 'document' || word === 'content';
  return call === 'xmlroot' && word === 'version' && prior === ',';
}

/** A literal operator must have a proved left operand; its name alone grants no exemption. */
function syntaxAt(
  tokens: readonly string[],
  at: number,
  call: string | undefined,
  keywords: TypeKeywords | undefined,
): boolean {
  const word = tokens[at] ?? '';
  if (call === 'substring' && word === 'similar' && valueAt(tokens, at - 1, keywords, call))
    return true;
  if (OPERATORS.has(word)) {
    const operand = at - (tokens[at - 1] === 'not' ? 2 : 1);
    if (valueAt(tokens, operand, keywords, call)) return true;
  }
  return (
    fixedSyntaxAt(tokens, at) ||
    frameAt(tokens, at, call, keywords) ||
    namedSyntaxAt(tokens, at, call, keywords)
  );
}

/**
 * The type whose modifiers the `)` at `at` closes, before a literal (`numeric(3) '1'`,
 * `foo(3) '1'`): PostgreSQL reads a call's shape there as a type's. Nothing of a clause's `)`, which
 * an expression follows, nor of a type of more words than one, known by its grammar.
 */
function modifiedTypeAt(tokens: readonly string[], at: number): number | undefined {
  const opening = openingOf(tokens, at);
  if (opening === undefined || closesClause(tokens, at)) return undefined;
  if (identifierOf(tokens[opening - 1]) === undefined || fixedSyntaxAt(tokens, opening - 1))
    return undefined;
  return opening - (tokens[opening - 2] === '.' ? QUALIFIED.width : 1);
}

/**
 * The name before a literal that can be its type. Unknown names are checked in every expression
 * position, including simple CASE operands and specialized SQL constructs. Only keyword
 * categories or a proved syntax context exempt a word; an expression-start whitelist cannot. A
 * qualified name is a type's whatever its last word is (`pg_temp.between '(1)'`): PostgreSQL
 * takes a keyword there.
 */
export function literalTypeAt(
  tokens: readonly string[],
  at: number,
  call: string | undefined,
  keywords: TypeKeywords | undefined,
): number | undefined {
  const prior = tokens[at - 1];
  if (prior === ')') return modifiedTypeAt(tokens, at - 1);
  if (identifierOf(prior) === undefined) return undefined;
  if (tokens[at - 2] === '.') return at - QUALIFIED.width;
  if ((keywords?.nonTypes ?? SYNTAX).has(prior ?? '')) return undefined;
  return syntaxAt(tokens, at - 1, call, keywords) ? undefined : at - 1;
}
