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
  if (token === 'as' && level?.typed === true) return at + 1;
  if (token === 'returning' && JSON_RETURNING.has(level?.call ?? '')) return at + 1;
  return token === "'" ? literalTypeAt(tokens, at, level?.call, keywords) : undefined;
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
  const levels: TypeLevel[] = [];
  for (const at of tokens.keys()) {
    const piece = tokens[at];
    if (piece === '(') {
      const level = levelAt(tokens, at);
      if (TYPED_TABLES.has(level.call ?? '')) return true;
      levels.push(level);
    } else if (piece === ')') {
      levels.pop();
    } else {
      const type = declaredAt(tokens, at, levels.at(-1), keywords);
      if (type !== undefined && !knownAt(tokens, type, known)) return true;
    }
  }
  return false;
}
