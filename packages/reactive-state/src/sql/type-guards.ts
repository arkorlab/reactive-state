import { identifierOf, sqlTokens } from './lex.ts';
import { literalTypeAt, type TypeKeywords, windowCallAt } from './literal-guards.ts';
import { hasTypedRecordColumns } from './renames.ts';

export type { TypeKeywords } from './literal-guards.ts';

/** A permanent type whose identity the initial catalog proves, including its unqualified visibility. */
export interface KnownType {
  readonly name: string;
  readonly schema: string;
  readonly visible: boolean;
}

/** Standard type spellings that PostgreSQL resolves to built-ins rather than as ordinary names. */
const ALIASES = new Set([
  'bigint',
  'bit',
  'boolean',
  'char',
  'character',
  'dec',
  'decimal',
  'float',
  'int',
  'integer',
  'interval',
  'national',
  'nchar',
  'numeric',
  'real',
  'smallint',
  'time',
  'timestamp',
  'varchar',
]);
/** The tokens of a schema-qualified type name: schema, dot, name. */
const QUALIFIED = { width: 3 } as const;
/** Native SQL/JSON calls whose RETURNING clause declares a type. */
const JSON_RETURNING = new Set([
  'json_array',
  'json_arrayagg',
  'json_object',
  'json_objectagg',
  'json_query',
  'json_serialize',
  'json_value',
]);
/** The calls whose `AS` declares a type. */
const TYPED_CALLS = new Set(['cast', 'treat', 'xmlserialize']);
/** Table constructs whose nested COLUMNS type declarations this admission lexer does not prove. */
const TYPED_TABLES = new Set(['json_table', 'xmltable']);
/** PostgreSQL's functions that read a type or a relation of the text they are given. */
const TEXT_TYPE_CALLS = new Set([
  'pg_input_error_info',
  'pg_input_is_valid',
  'regclassin',
  'regoperatorin',
  'regprocedurein',
  'regtypein',
  'to_regclass',
  'to_regoperator',
  'to_regprocedure',
  'to_regtype',
  'to_regtypemod',
]);
/**
 * PostgreSQL's types whose input reads a type or a relation of a text, or a signature of types, and
 * their arrays by the names the catalog gives them.
 */
const TEXT_TYPES = new Set([
  '_regclass',
  '_regoperator',
  '_regprocedure',
  '_regtype',
  'regclass',
  'regoperator',
  'regprocedure',
  'regtype',
]);
/** The schema of PostgreSQL's own functions and types. */
const CATALOG = 'pg_catalog';

/** Whether the type at `at`, qualified or not, is known permanent catalog metadata. */
function knownAt(tokens: readonly string[], at: number, known: readonly KnownType[]): boolean {
  let name = identifierOf(tokens[at]);
  if (name === undefined) return false;
  let schema: string | undefined;
  if (tokens[at + 1] === '.') {
    schema = name;
    name = identifierOf(tokens[at + 2]);
    if (tokens[at + QUALIFIED.width] === '.') return false;
  } else if (
    ALIASES.has(tokens[at] ?? '') ||
    (tokens[at] === 'double' && tokens[at + 1] === 'precision')
  ) {
    return true;
  }
  return known.some(
    (type) => type.name === name && (schema === undefined ? type.visible : type.schema === schema),
  );
}

/** A parenthesized expression's native type-clause context. */
interface TypeLevel {
  readonly typed: boolean;
  readonly call: string | undefined;
}

/** The word a `(` at `at` opens the call of: a window's, or a call's by its name. */
function callAt(tokens: readonly string[], at: number): string | undefined {
  const window = windowCallAt(tokens, at);
  if (window !== undefined || tokens[at - 2] === '.') return window;
  return tokens[at - 1];
}

/** The type-clause context a `(` at `at` opens: of an `AS` of a type, or of a call, by its name. */
function levelAt(tokens: readonly string[], at: number): TypeLevel {
  return { typed: TYPED_CALLS.has(tokens[at - 1] ?? ''), call: callAt(tokens, at) };
}

/** The type declared by a cast, SQL/JSON RETURNING clause or prefix literal at this token. */
function declaredAt(
  tokens: readonly string[],
  at: number,
  level: TypeLevel | undefined,
  keywords: TypeKeywords | undefined,
): number | undefined {
  const token = tokens[at];
  if (token === ':' && tokens[at - 1] === ':') return at + 1;
  // After a dot, either word is a column's (`t.as`), which declares nothing.
  const field = tokens[at - 1] === '.';
  if (!field && token === 'as' && level?.typed === true) return at + 1;
  if (!field && token === 'returning' && JSON_RETURNING.has(level?.call ?? '')) return at + 1;
  return token === "'" ? literalTypeAt(tokens, at, level?.call, keywords) : undefined;
}

/** Where each type `tokens` declare stands; nothing of a text that holds a typed table. */
function declaredTypesOf(
  tokens: readonly string[],
  keywords: TypeKeywords | undefined,
): readonly number[] | undefined {
  const types: number[] = [];
  const levels: TypeLevel[] = [];
  for (const at of tokens.keys()) {
    const piece = tokens[at];
    if (piece === '(') {
      const level = levelAt(tokens, at);
      if (TYPED_TABLES.has(level.call ?? '')) return undefined;
      levels.push(level);
    } else if (piece === ')') {
      levels.pop();
    } else {
      const type = declaredAt(tokens, at, levels.at(-1), keywords);
      if (type !== undefined) types.push(type);
    }
  }
  return types;
}

/**
 * Whether an explicit cast or a typed literal uses an unknown type. A temporary table created
 * after the first catalog may introduce a new row type without an event count; an unknown name
 * therefore never becomes permission to use it. Function-style conversions share ordinary
 * function-call syntax, whose hidden type and table reads remain outside this SQL contract.
 * Typed table constructs are refused until their type declarations can be proven.
 */
export function unknownTypeCast(
  sql: string,
  known: readonly KnownType[],
  conforming: boolean,
  keywords?: TypeKeywords,
): boolean {
  const tokens = sqlTokens(sql, conforming);
  if (tokens === undefined || tokens.includes('`') || hasTypedRecordColumns(tokens)) return true;
  const types = declaredTypesOf(tokens, keywords);
  return types === undefined || types.some((type) => !knownAt(tokens, type, known));
}

/** Whether the word at `at` is PostgreSQL's own: of no schema, or of its catalog's. */
function ownAt(tokens: readonly string[], at: number): boolean {
  return tokens[at - 1] !== '.' || identifierOf(tokens[at - 2]) === CATALOG;
}

/** Whether the type declared at `at` is one that reads a text, by the name it is written with. */
function readsTextAt(tokens: readonly string[], at: number): boolean {
  const qualified = tokens[at + 1] === '.';
  const name = identifierOf(tokens[qualified ? at + 2 : at]) ?? '';
  return TEXT_TYPES.has(name) && (!qualified || identifierOf(tokens[at]) === CATALOG);
}

/**
 * Whether a statement may read a type or a relation of a text: by a function of PostgreSQL's that
 * takes one (`to_regtype`, `pg_input_is_valid`), or by a cast or a typed literal of a type that reads
 * one (`'pg_temp.staging'::regtype`, `$1::regclass`), of any operand: nothing here reads a literal's
 * contents, and a cast's operand may be a text however it is written (`'x'::text::regclass`, a
 * column's). So `tableoid::regclass` is refused too, whose `tableoid` a statement may read as it is.
 */
export function namesTypeByText(
  sql: string,
  conforming: boolean,
  keywords?: TypeKeywords,
): boolean {
  const tokens = sqlTokens(sql, conforming);
  if (tokens === undefined) return false;
  const calls = tokens.some((token, at) => {
    return (
      tokens[at + 1] === '(' && TEXT_TYPE_CALLS.has(identifierOf(token) ?? '') && ownAt(tokens, at)
    );
  });
  if (calls) return true;
  const types = declaredTypesOf(tokens, keywords) ?? [];
  return types.some((type) => readsTextAt(tokens, type));
}
