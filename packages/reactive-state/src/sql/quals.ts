/**
 * The conditions of a scan of a plan the authority follows a read by: of the expression
 * PostgreSQL wrote of a scan's `Filter`, `Index Cond` or `Recheck Cond`, each term its top-level
 * `AND` joins that names a column of the scan's own relation equal to a statement's parameter
 * (`$n`), or to a constant — or one of a list of them (`= ANY (ARRAY[…])`), or a boolean column
 * alone (`t.c`, `NOT t.c`). A row the scan reads holds every term, so a change of a row that holds
 * one of them neither before nor after it changes nothing the scan read. Every other term — an
 * `OR`, a range, `IS`, a function, `COLLATE`, a column of another relation, a cast other than to
 * `text` — is left out: the read is followed by more changes, never fewer.
 */

/**
 * What a column is compared to: a statement's parameter, by its number, or a constant's text, of
 * the type PostgreSQL wrote it of where it wrote one (`'open'::status`).
 */
export type Operand =
  | { readonly parameter: number }
  | { readonly constant: string; readonly type?: string; readonly schema?: string };

/** A term of a scan's conditions: its column equal to one of `operands`. */
export interface Condition {
  readonly column: string;
  readonly operands: readonly Operand[];
  /** Whether the column was cast to `text` before it was compared: a text column's alone may be. */
  readonly cast: boolean;
  /** Whether the term was the column alone, `NOT` it or not: a boolean column's alone may be. */
  readonly bare: boolean;
}

type Token =
  | { readonly kind: 'name'; readonly text: string; readonly quoted: boolean }
  | { readonly kind: 'number'; readonly text: string }
  | { readonly kind: 'other' }
  | { readonly kind: 'parameter'; readonly number: number }
  | { readonly kind: 'punct'; readonly text: string }
  | { readonly kind: 'string'; readonly text: string };

const PUNCTUATION = new Set(['(', ')', ',', '.', '[', ']']);
const NAME_START = /[A-Za-z_]/u;
const NAME_PART = /[\w$]/u;
const DIGIT = /\d/u;

/** The text of a quoted run from `at`, its quotes doubled within it, and where it ends. */
function quotedRun(text: string, at: number, quote: string): readonly [string, number] | undefined {
  let value = '';
  let index = at + 1;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === quote) {
      if (text[index + 1] !== quote) {
        return [value, index + 1];
      }
      value += quote;
      index += 2;
    } else {
      value += char;
      index += 1;
    }
  }
  return undefined;
}

/** The run of characters from `at` that `pattern` takes, and where it ends. */
function runOf(text: string, at: number, pattern: RegExp): readonly [string, number] {
  let end = at;
  while (end < text.length && pattern.test(text[end] ?? '')) {
    end += 1;
  }
  return [text.slice(at, end), end];
}

/** The token at `at` of `text`, and where the next one may start. */
function tokenAt(text: string, at: number): readonly [Token, number] {
  const char = text[at] ?? '';
  if (char === "'" || char === '"') {
    const run = quotedRun(text, at, char);
    if (run === undefined) {
      return [{ kind: 'other' }, text.length];
    }
    const [value, end] = run;
    const token: Token =
      char === "'" ? { kind: 'string', text: value } : { kind: 'name', quoted: true, text: value };
    return [token, end];
  }
  if (char === '$') {
    const [digits, end] = runOf(text, at + 1, DIGIT);
    return [digits === '' ? { kind: 'other' } : { kind: 'parameter', number: Number(digits) }, end];
  }
  if (DIGIT.test(char)) {
    const [digits, end] = runOf(text, at, DIGIT);
    // A number of a fraction or an exponent is no whole number's.
    return NAME_PART.test(text[end] ?? '') || text[end] === '.'
      ? [{ kind: 'other' }, end + 1]
      : [{ kind: 'number', text: digits }, end];
  }
  if (NAME_START.test(char)) {
    const [name, end] = runOf(text, at, NAME_PART);
    return [{ kind: 'name', quoted: false, text: name }, end];
  }
  if (char === ':' && text[at + 1] === ':') {
    return [{ kind: 'punct', text: '::' }, at + 2];
  }
  if (char === '=' || PUNCTUATION.has(char)) {
    return [{ kind: 'punct', text: char }, at + 1];
  }
  return [{ kind: 'other' }, at + 1];
}

/** The tokens of an expression PostgreSQL wrote. */
function tokensOf(text: string): readonly Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    if (/\s/u.test(text[at] ?? '')) {
      at += 1;
    } else {
      const [token, next] = tokenAt(text, at);
      tokens.push(token);
      at = next;
    }
  }
  return tokens;
}

function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === 'punct' && token.text === text;
}

/** Whether `token` is the unquoted word `word`, as PostgreSQL writes its keywords. */
function isWord(token: Token | undefined, word: string): boolean {
  return token?.kind === 'name' && !token.quoted && token.text === word;
}

/** Where the parenthesis that `tokens[at]` opens closes, or `undefined` where none does. */
function closing(tokens: readonly Token[], at: number): number | undefined {
  let depth = 0;
  for (let index = at; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isPunct(token, '(')) depth += 1;
    if (isPunct(token, ')')) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

/** `tokens` without the parentheses that enclose them whole. */
function unwrapped(tokens: readonly Token[]): readonly Token[] {
  let inner = tokens;
  while (isPunct(inner[0], '(') && closing(inner, 0) === inner.length - 1) {
    inner = inner.slice(1, -1);
  }
  return inner;
}

/** The parts the top-level `AND`s of `tokens` join: one, where they join none. */
function partsOf(tokens: readonly Token[]): readonly (readonly Token[])[] {
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (isPunct(token, '(')) depth += 1;
    if (isPunct(token, ')')) depth -= 1;
    if (depth === 0 && isWord(token, 'AND')) {
      parts.push([]);
    } else {
      parts.at(-1)?.push(token);
    }
  }
  return parts;
}

/** The terms the top-level `AND`s of `tokens` join, each as far as it joins more of its own. */
function termsOf(tokens: readonly Token[]): readonly (readonly Token[])[] {
  const terms: (readonly Token[])[] = [];
  const pending: (readonly Token[])[] = [tokens];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const inner = unwrapped(next);
    const parts = partsOf(inner);
    if (parts.length === 1) {
      terms.push(inner);
    } else {
      pending.push(...parts);
    }
  }
  return terms;
}

/** What a token of a pattern must be. */
type Expected = (token: Token | undefined) => boolean;

function punct(text: string): Expected {
  return (token) => isPunct(token, text);
}

function keyword(text: string): Expected {
  return (token) => isWord(token, text);
}

function isName(token: Token | undefined): boolean {
  return token?.kind === 'name';
}

/** Whether `tokens` from `at` are what `pattern` expects, each in turn. */
function matchAt(tokens: readonly Token[], at: number, pattern: readonly Expected[]): boolean {
  return pattern.every((expected, offset) => expected(tokens[at + offset]));
}

/** A column of a relation: `alias.column`, the column's name its last token. */
const COLUMN: readonly Expected[] = [isName, punct('.'), isName];
/** A column cast to text, as PostgreSQL compares a `varchar` column to text: `(alias.column)::text`. */
const CAST_COLUMN: readonly Expected[] = [
  punct('('),
  ...COLUMN,
  punct(')'),
  punct('::'),
  keyword('text'),
];
/** Where a list of `ANY (ARRAY[…])` opens. */
const LIST_OPEN: readonly Expected[] = [keyword('ANY'), punct('('), keyword('ARRAY'), punct('[')];
/** Where a list of `ANY (ARRAY[…])` closes. */
const LIST_CLOSE: readonly Expected[] = [punct(']'), punct(')')];

/** The column `COLUMN` matched at `at`, where its relation is `alias`. */
function columnNamed(tokens: readonly Token[], at: number, alias: string): string | undefined {
  const [relation, , column] = tokens.slice(at, at + COLUMN.length);
  return relation?.kind === 'name' && column?.kind === 'name' && relation.text === alias
    ? column.text
    : undefined;
}

/** A column of the scan's relation, `alias.column`, as `tokens` from `at` name it, and its end. */
function columnAt(
  tokens: readonly Token[],
  at: number,
  alias: string,
): { readonly column: string; readonly cast: boolean; readonly end: number } | undefined {
  if (matchAt(tokens, at, COLUMN)) {
    const column = columnNamed(tokens, at, alias);
    return column === undefined ? undefined : { cast: false, column, end: at + COLUMN.length };
  }
  if (matchAt(tokens, at, CAST_COLUMN)) {
    const column = columnNamed(tokens, at + 1, alias);
    return column === undefined ? undefined : { cast: true, column, end: at + CAST_COLUMN.length };
  }
  return undefined;
}

/** A schema-qualified type from `at`, where PostgreSQL writes two identifiers around a dot. */
function qualifiedTypeAt(
  tokens: readonly Token[],
  at: number,
): { readonly schema: string; readonly type: string; readonly end: number } | undefined {
  const schema = tokens[at];
  const name = tokens[at + 2];
  return schema?.kind === 'name' && isPunct(tokens[at + 1], '.') && name?.kind === 'name'
    ? { end: at + COLUMN.length, schema: schema.text, type: name.text }
    : undefined;
}

/** A parameter or a constant, as `tokens` from `at` write it, and where it ends. */
function operandAt(
  tokens: readonly Token[],
  at: number,
): { readonly operand: Operand; readonly end: number } | undefined {
  const token = tokens[at];
  if (token?.kind === 'parameter') {
    return { end: at + 1, operand: { parameter: token.number } };
  }
  if (token?.kind === 'number') {
    return { end: at + 1, operand: { constant: token.text } };
  }
  if (isWord(token, 'true') || isWord(token, 'false')) {
    return { end: at + 1, operand: { constant: token?.kind === 'name' ? token.text : '' } };
  }
  // A backslash PostgreSQL may have written doubled, as it does with `standard_conforming_strings`
  // off: the text is not known.
  if (token?.kind !== 'string' || token.text.includes('\\')) {
    return undefined;
  }
  // `'text'::type`: the constant's type, of one or more words, which `reads.ts` holds to the key's.
  let end = at + 1;
  if (!isPunct(tokens[end], '::')) {
    return { end, operand: { constant: token.text } };
  }
  end += 1;
  const qualified = qualifiedTypeAt(tokens, end);
  if (qualified !== undefined) {
    return {
      end: qualified.end,
      operand: { constant: token.text, schema: qualified.schema, type: qualified.type },
    };
  }
  const words: string[] = [];
  // A collation after the type is no part of it: the term goes on, and is left out.
  for (
    let next = tokens[end];
    next?.kind === 'name' && !isWord(next, 'COLLATE');
    next = tokens[end]
  ) {
    words.push(next.text);
    end += 1;
  }
  return { end, operand: { constant: token.text, type: words.join(' ') } };
}

/** The operands of `ANY (ARRAY[…])` from `at`, and where they end, or none of another form. */
function listAt(
  tokens: readonly Token[],
  at: number,
): { readonly operands: readonly Operand[]; readonly end: number } | undefined {
  if (!matchAt(tokens, at, LIST_OPEN)) {
    return undefined;
  }
  const operands: Operand[] = [];
  let index = at + LIST_OPEN.length;
  for (;;) {
    const found = operandAt(tokens, index);
    if (found === undefined) return undefined;
    operands.push(found.operand);
    index = found.end;
    if (!isPunct(tokens[index], ',')) break;
    index += 1;
  }
  return matchAt(tokens, index, LIST_CLOSE)
    ? { end: index + LIST_CLOSE.length, operands }
    : undefined;
}

/** The condition one term is, where it is one of those followed, of the scan's `alias`. */
function conditionOf(term: readonly Token[], alias: string): Condition | undefined {
  const negated = isWord(term[0], 'NOT');
  const alone = columnAt(term, negated ? 1 : 0, alias);
  if (alone?.end === term.length && !alone.cast) {
    return {
      bare: true,
      cast: false,
      column: alone.column,
      operands: [{ constant: String(!negated) }],
    };
  }
  const left = columnAt(term, 0, alias);
  if (left !== undefined && isPunct(term[left.end], '=')) {
    const list = listAt(term, left.end + 1);
    const single = list === undefined ? operandAt(term, left.end + 1) : undefined;
    const operands = list?.operands ?? (single === undefined ? undefined : [single.operand]);
    const end = list?.end ?? single?.end;
    return operands !== undefined && end === term.length
      ? { bare: false, cast: left.cast, column: left.column, operands }
      : undefined;
  }
  // `$n = alias.column`, the other way round.
  const first = operandAt(term, 0);
  if (first === undefined || !isPunct(term[first.end], '=')) {
    return undefined;
  }
  const right = columnAt(term, first.end + 1, alias);
  return right?.end === term.length
    ? { bare: false, cast: right.cast, column: right.column, operands: [first.operand] }
    : undefined;
}

/** The conditions of `expression`, a scan's, that name columns of its relation, `alias`. */
export function conditionsOf(expression: string, alias: string): readonly Condition[] {
  const conditions: Condition[] = [];
  const terms = termsOf(tokensOf(expression));
  for (const term of terms) {
    const condition = conditionOf(term, alias);
    if (condition !== undefined) conditions.push(condition);
  }
  return conditions;
}
