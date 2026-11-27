import {
  folded,
  isChar,
  isWord,
  placesOf,
  plainTokensOf,
  QUALIFIED,
  type Token,
  unwrapped,
} from './where.ts';

/**
 * What a statement of SQLite reads scope by scope, as Drizzle writes one of more than one table: its
 * sources and joins, the `SELECT`s nested in any clause, and the terms that hold of a row of a source
 * wherever that row counts. The grammar is closed: what this reads not plainly answers nothing, and
 * the statement then reads whole every table its bytecode opens.
 *
 * A term `o.c = v` restricts `o` where it stands at the top level of an `AND` of its own scope's
 * `WHERE`, of an inner join's `ON`, or of the `ON` of the `LEFT JOIN` whose right table `o` is: a row
 * of `o` of another `c` changes no answer, at any depth and under `NOT EXISTS` too, as what is
 * restricted is the subquery's own rows. Of a `LEFT JOIN`'s `ON` a term says nothing of another
 * table, whose row stands whether it holds or not. Under an `OR`, a `CASE` or a `NOT` it says nothing.
 */

/** A source of a scope: a table by its name in the text, or what is no table (`table` of none). */
export interface Occurrence {
  readonly alias: string;
  readonly table: string | undefined;
  readonly scope: Scope;
}

/** A `SELECT`: the scope around it, its sources, and what its conditions say. */
export interface Scope {
  readonly parent: Scope | undefined;
  readonly occurrences: Occurrence[];
  readonly facts: Fact[];
}

/** A column of a source. */
export interface ColumnRef {
  readonly occurrence: Occurrence;
  readonly column: string;
}

/**
 * What a term of a condition says, `on` being the right table of the `LEFT JOIN` whose `ON` it stands
 * in: a column equal to one of the statement's parameters, or two columns equal.
 */
export type Fact =
  | {
      readonly kind: 'params';
      readonly of: ColumnRef;
      readonly params: readonly number[];
      readonly on: Occurrence | undefined;
    }
  | {
      readonly kind: 'equal';
      readonly a: ColumnRef;
      readonly b: ColumnRef;
      readonly on: Occurrence | undefined;
    };

/** What a statement reads: its scopes, every source of them, and the functions it reads as tables. */
export interface StatementRead {
  readonly scopes: readonly Scope[];
  readonly occurrences: readonly Occurrence[];
  readonly functions: readonly string[];
}

/** The words of what this reads not, at any depth. */
const REFUSED = new Set([
  'except',
  'filter',
  'full',
  'intersect',
  'natural',
  'over',
  'recursive',
  'returning',
  'right',
  'union',
  'using',
  'values',
  'window',
  'with',
]);
/** The words that begin a clause of a `SELECT`. */
const CLAUSES = new Set(['from', 'group', 'having', 'limit', 'order', 'where']);
/** The words that make a term of a condition no term of its `AND`. */
const LOOSENING = new Set(['between', 'case', 'or']);
/** SQLite's functions read as tables of a text of JSON, which reads nothing of the database. */
const JSON_TABLES = new Set(['json_each', 'json_tree', 'jsonb_each', 'jsonb_tree']);
/** SQLite's words of a join's kind, up to three of which stand before `JOIN`, of any order. */
const JOIN_WORDS = new Set(['cross', 'full', 'inner', 'left', 'natural', 'outer', 'right']);
/** Whether a run of those words is a left join, of the runs this reads. */
const JOIN_RUNS: ReadonlyMap<string, boolean> = new Map([
  ['', false],
  ['inner', false],
  ['left', true],
  ['left outer', true],
]);

/** Where the parenthesis at `open` closes. */
function closingOf(tokens: readonly Token[], open: number): number | undefined {
  let depth = 0;
  for (let at = open; at < tokens.length; at += 1) {
    if (isChar(tokens[at], '(')) depth += 1;
    if (isChar(tokens[at], ')')) depth -= 1;
    if (depth === 0) return at;
  }
  return undefined;
}

/** The positions of `tokens` outside any parenthesis that `test` holds of. */
function atTop(tokens: readonly Token[], test: (token: Token) => boolean): readonly number[] {
  const found: number[] = [];
  let depth = 0;
  for (const [at, token] of tokens.entries()) {
    if (isChar(token, '(')) depth += 1;
    else if (isChar(token, ')')) depth -= 1;
    else if (depth === 0 && test(token)) found.push(at);
  }
  return found;
}

/**
 * The terms of `condition`'s top level `AND`, flattened through parentheses: none of a condition
 * that holds an `OR`, a `CASE` or a `BETWEEN`, whose `AND` is its own.
 */
function conjunctsOf(condition: readonly Token[]): readonly (readonly Token[])[] {
  const inner = unwrapped(condition);
  // A `SELECT` in parentheses is one value, whose `AND` is its own.
  if (isWord(inner[0], 'select')) return [];
  if (atTop(inner, (token) => token.kind === 'word' && LOOSENING.has(token.text)).length > 0) {
    return [];
  }
  const ands = atTop(inner, (token) => isWord(token, 'and'));
  if (ands.length === 0) return [inner];
  const parts: (readonly Token[])[] = [];
  let from = 0;
  for (const at of [...ands, inner.length]) {
    parts.push(...conjunctsOf(inner.slice(from, at)));
    from = at + 1;
  }
  return parts;
}

/** A source of a `FROM` clause and how it joins: its `ON`, of the first source none. */
interface Joined {
  readonly source: readonly Token[];
  readonly on: readonly Token[] | undefined;
  readonly left: boolean;
}

/** A `JOIN`'s kind: whether it is left, and how many words stand before it. */
interface JoinKind {
  readonly left: boolean;
  readonly words: number;
}

/**
 * What kind the `JOIN` at `at` is, of the whole run of words before it: none of a run this reads not,
 * of which SQLite takes more than it looks, and none of a word after `AS`, which is an alias.
 */
function joinBefore(tokens: readonly Token[], at: number): JoinKind | undefined {
  const run: string[] = [];
  for (let word = tokens[at - 1]; word?.kind === 'word' && JOIN_WORDS.has(word.text);) {
    run.unshift(word.text);
    word = tokens[at - run.length - 1];
  }
  const left = JOIN_RUNS.get(run.join(' '));
  if (left === undefined || isWord(tokens[at - run.length - 1], 'as')) return undefined;
  return { left, words: run.length };
}

/** The sources of the `FROM` clause `tokens`; none of a comma, or of what is read not plainly. */
function joinsOf(tokens: readonly Token[]): readonly Joined[] | undefined {
  if (atTop(tokens, (token) => isChar(token, ',')).length > 0) return undefined;
  const joined: Joined[] = [];
  let from = 0;
  let left = false;
  for (const at of [...atTop(tokens, (token) => isWord(token, 'join')), tokens.length]) {
    const next = at === tokens.length ? { left: false, words: 0 } : joinBefore(tokens, at);
    if (next === undefined) return undefined;
    const piece = tokens.slice(from, at - next.words);
    const ons = atTop(piece, (token) => isWord(token, 'on'));
    const [on] = ons;
    // The first source stands of no `ON`, and each that joins of one.
    if (ons.length !== (joined.length === 0 ? 0 : 1)) return undefined;
    joined.push({
      left,
      on: on === undefined ? undefined : piece.slice(on + 1),
      source: on === undefined ? piece : piece.slice(0, on),
    });
    from = at + 1;
    ({ left } = next);
  }
  return joined;
}

/** The name `tokens` after a source give it, `own` of none; `undefined` of what is no alias. */
function aliasOf(tokens: readonly Token[], own: string | undefined): string | undefined {
  if (tokens.length === 0) return own;
  const named = isWord(tokens[0], 'as') ? tokens.slice(1) : tokens;
  const [alias] = named;
  if (alias === undefined || named.length !== 1) return undefined;
  return alias.kind === 'name' || alias.kind === 'word' ? alias.text : undefined;
}

/** Reads the scopes of one statement. */
class Reader {
  /** Each parameter's place among the statement's. */
  readonly #places: ReadonlyMap<Token, number>;
  readonly scopes: Scope[] = [];
  readonly occurrences: Occurrence[] = [];
  readonly functions: string[] = [];

  constructor(places: ReadonlyMap<Token, number>) {
    this.#places = places;
  }

  #occurrence(scope: Scope, alias: string, table: string | undefined): void {
    const occurrence = { alias, scope, table };
    this.occurrences.push(occurrence);
    scope.occurrences.push(occurrence);
  }

  /** Every `(select …)` of `tokens`, read as a scope below `scope`. */
  #nested(tokens: readonly Token[], scope: Scope): boolean {
    let at = 0;
    while (at < tokens.length) {
      if (isChar(tokens[at], '(') && isWord(tokens[at + 1], 'select')) {
        const end = closingOf(tokens, at);
        if (end === undefined) return false;
        if (this.select(tokens.slice(at + 1, end), scope) === undefined) return false;
        at = end;
      }
      // `x in "t"` reads a table no source names.
      if (isWord(tokens[at], 'in') && !isChar(tokens[at + 1], '(')) return false;
      at += 1;
    }
    return true;
  }

  /** A derived table: what it reads sees no sibling, so it stands below the scope around them. */
  #derived(tokens: readonly Token[], scope: Scope): boolean {
    const end = closingOf(tokens, 0);
    if (end === undefined) return false;
    const alias = aliasOf(tokens.slice(end + 1), undefined);
    if (alias === undefined) return false;
    if (this.select(tokens.slice(1, end), scope.parent) === undefined) return false;
    this.#occurrence(scope, alias, undefined);
    return true;
  }

  /** A function read as a table (`json_each(…)`). */
  #tableFunction(name: string, tokens: readonly Token[], scope: Scope): boolean {
    const end = closingOf(tokens, 1);
    if (end === undefined) return false;
    const alias = aliasOf(tokens.slice(end + 1), name);
    if (alias === undefined) return false;
    this.functions.push(name);
    this.#occurrence(scope, alias, undefined);
    return true;
  }

  /** The source `tokens`: a table, a derived table or a function, with its alias. */
  #source(tokens: readonly Token[], scope: Scope): boolean {
    const [first] = tokens;
    if (first?.kind === 'name') {
      const alias = aliasOf(tokens.slice(1), first.text);
      if (alias === undefined) return false;
      this.#occurrence(scope, alias, first.text);
      return true;
    }
    if (isChar(first, '(')) return isWord(tokens[1], 'select') && this.#derived(tokens, scope);
    if (first?.kind === 'word' && JSON_TABLES.has(first.text) && isChar(tokens[1], '(')) {
      return this.#tableFunction(first.text, tokens, scope);
    }
    return false;
  }

  /** The column `tokens` name, of the nearest scope that holds their source. */
  #column(tokens: readonly Token[], scope: Scope): ColumnRef | undefined {
    const [first, dot, second] = tokens;
    if (first?.kind !== 'name') return undefined;
    if (tokens.length === QUALIFIED.tokens && isChar(dot, '.') && second?.kind === 'name') {
      const alias = folded(first.text);
      for (let at: Scope | undefined = scope; at !== undefined; at = at.parent) {
        const occurrence = at.occurrences.find((each) => folded(each.alias) === alias);
        if (occurrence !== undefined) return { column: second.text, occurrence };
      }
      return undefined;
    }
    // A bare name of a nested `SELECT` may be of any scope around it: only the top's one source.
    const [only, another] = scope.occurrences;
    if (tokens.length !== 1 || scope.parent !== undefined) return undefined;
    if (only === undefined || another !== undefined) return undefined;
    return { column: first.text, occurrence: only };
  }

  /** The parameter `tokens` are alone. */
  #place(tokens: readonly Token[]): number | undefined {
    const [token] = tokens;
    return token !== undefined && tokens.length === 1 ? this.#places.get(token) : undefined;
  }

  /** What `left = right` says. */
  #equality(
    left: readonly Token[],
    right: readonly Token[],
    scope: Scope,
    on: Occurrence | undefined,
  ): void {
    const [a, b] = [this.#column(left, scope), this.#column(right, scope)];
    if (a !== undefined && b !== undefined) {
      scope.facts.push({ a, b, kind: 'equal', on });
      return;
    }
    const of = a ?? b;
    const place = this.#place(a === undefined ? left : right);
    if (of !== undefined && place !== undefined) {
      scope.facts.push({ kind: 'params', of, on, params: [place] });
    }
  }

  /** What `column in (?, ?)` says, of a list of parameters alone. */
  #list(term: readonly Token[], scope: Scope, on: Occurrence | undefined): void {
    const listed = term.findIndex((token) => isWord(token, 'in'));
    if (listed < 1 || !isChar(term[listed + 1], '(')) return;
    if (closingOf(term, listed + 1) !== term.length - 1) return;
    const of = this.#column(term.slice(0, listed), scope);
    const items = term.slice(listed + 2, -1);
    const places: (number | undefined)[] = [];
    for (let at = 0; at < items.length; at += 2) {
      const comma = items[at + 1];
      if (comma !== undefined && !isChar(comma, ',')) return;
      places.push(this.#place(items.slice(at, at + 1)));
    }
    const params = places.filter((place) => place !== undefined);
    if (of !== undefined && params.length > 0 && params.length === places.length) {
      scope.facts.push({ kind: 'params', of, on, params });
    }
  }

  /** What `condition` says, in `scope`: of a `LEFT JOIN`'s `ON`, `on` is its right table. */
  #facts(condition: readonly Token[], scope: Scope, on: Occurrence | undefined): void {
    for (const part of conjunctsOf(condition)) {
      const term = unwrapped(part);
      const equals = atTop(term, (token) => isChar(token, '='));
      const [at] = equals;
      if (at === undefined) this.#list(term, scope, on);
      if (at !== undefined && equals.length === 1) {
        this.#equality(term.slice(0, at), term.slice(at + 1), scope, on);
      }
    }
  }

  /** What the functions of `joined` are given, which sees every source of the scope. */
  #given(joined: readonly Joined[], scope: Scope): boolean {
    return joined.every(({ source }) => source[0]?.kind !== 'word' || this.#nested(source, scope));
  }

  /** The sources of a `FROM` clause and then their conditions, each of which sees them all. */
  #from(tokens: readonly Token[], scope: Scope): boolean {
    const joined = joinsOf(tokens);
    if (joined === undefined) return false;
    for (const { source } of joined) {
      if (!this.#source(source, scope)) return false;
    }
    if (!this.#given(joined, scope)) return false;
    for (const [at, { left, on }] of joined.entries()) {
      if (on !== undefined) {
        if (!this.#nested(on, scope)) return false;
        this.#facts(on, scope, left ? scope.occurrences[at] : undefined);
      }
    }
    return true;
  }

  /** The scope of `tokens`, `select …` of no parentheses, below `parent`. */
  select(tokens: readonly Token[], parent: Scope | undefined): Scope | undefined {
    if (!isWord(tokens[0], 'select')) return undefined;
    const scope: Scope = { facts: [], occurrences: [], parent };
    this.scopes.push(scope);
    const clauses = atTop(tokens, (token) => token.kind === 'word' && CLAUSES.has(token.text));
    const end = (at: number): number => clauses.find((each) => each > at) ?? tokens.length;
    const froms = clauses.filter((at) => isWord(tokens[at], 'from'));
    const [fromAt] = froms;
    // A second `FROM` of this level is no clause (`IS NOT DISTINCT FROM`), and an `OR` may stand past
    // it; nor is one past another clause, of whose text this would read twice.
    if (froms.length > 1 || (fromAt !== undefined && clauses[0] !== fromAt)) return undefined;
    // Nor is one right after `DISTINCT`, which no result column follows: its operand is no source.
    if (fromAt !== undefined && isWord(tokens[fromAt - 1], 'distinct')) return undefined;
    if (fromAt === undefined) return this.#nested(tokens.slice(1), scope) ? scope : undefined;
    if (!this.#from(tokens.slice(fromAt + 1, end(fromAt)), scope)) return undefined;
    if (!this.#nested(tokens.slice(1, fromAt), scope)) return undefined;
    const whereAt = clauses.find((at) => isWord(tokens[at], 'where'));
    if (whereAt !== undefined) {
      const condition = tokens.slice(whereAt + 1, end(whereAt));
      if (!this.#nested(condition, scope)) return undefined;
      this.#facts(condition, scope, undefined);
    }
    return this.#nested(tokens.slice(end(whereAt ?? fromAt)), scope) ? scope : undefined;
  }
}

/** What `sql` reads, scope by scope; `undefined` where it is not read plainly. */
export function statementRead(sql: string): StatementRead | undefined {
  const tokens = plainTokensOf(sql);
  if (tokens === undefined) return undefined;
  if (tokens.some((token) => token.kind === 'word' && REFUSED.has(token.text))) return undefined;
  const reader = new Reader(placesOf(tokens));
  if (reader.select(tokens, undefined) === undefined) return undefined;
  const { functions, occurrences, scopes } = reader;
  return { functions, occurrences, scopes };
}
