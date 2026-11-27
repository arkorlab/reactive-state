import { identifierOf, sqlTokens } from './lex.ts';

/** The query context changes that a text can make directly, outside its quoted literal values. */
const CONTEXT_COMMANDS = new Set(['abort', 'commit', 'discard', 'end', 'reset', 'rollback', 'set']);

/**
 * Whether the `SET` at `at` sets a transaction's options (`SET TRANSACTION READ ONLY`), which no
 * plan reads: not a setting of that prefix (`SET transaction.name = 1`).
 */
function setsTransaction(tokens: readonly string[], at: number): boolean {
  return tokens[at] === 'set' && tokens[at + 1] === 'transaction' && tokens[at + 2] !== '.';
}

/**
 * Whether SQL changes the session or transaction context that a cached plan was asked under.
 * Unknown string syntax and Unicode-escaped identifiers are conservative mutations. The latter
 * can spell `set_config` without its name appearing in the text.
 */
export function changesContext(sql: string, conforming: boolean): boolean {
  const tokens = sqlTokens(sql, conforming);
  if (tokens === undefined) return true;
  return tokens.some((token, at) => {
    return (
      token === '`' ||
      ((at === 0 || tokens[at - 1] === ';') &&
        CONTEXT_COMMANDS.has(token) &&
        !setsTransaction(tokens, at)) ||
      (identifierOf(token) === 'set_config' && tokens[at + 1] === '(')
    );
  });
}

/** The commands that change a session's settings. */
const SESSION_COMMANDS = new Set(['discard', 'reset', 'set']);

/**
 * Whether SQL changes the settings of the session it runs on: of a pool, one connection of many,
 * which the others and the store would not share. A Unicode-escaped identifier may spell `set_config`
 * as `changesContext` says. A text the lexer cannot read is let run, as this guards a statement
 * outside a render, which the application wrote to run.
 */
export function changesSession(sql: string, conforming: boolean): boolean {
  const tokens = sqlTokens(sql, conforming);
  if (tokens === undefined) return false;
  return tokens.some((token, at) => {
    return (
      token === '`' ||
      ((at === 0 || tokens[at - 1] === ';') &&
        SESSION_COMMANDS.has(token) &&
        !setsTransaction(tokens, at)) ||
      (identifierOf(token) === 'set_config' && tokens[at + 1] === '(')
    );
  });
}

/** Whether the `SET` at `at` sets for the transaction alone (`SET LOCAL x = 1`). */
function setsLocal(tokens: readonly string[], at: number): boolean {
  return tokens[at] === 'set' && tokens[at + 1] === 'local';
}

/**
 * Whether the call of `set_config` whose parentheses open at `open` of `tokens` sets its setting
 * for the transaction alone: its third argument is the word `true`, as nothing else is known to be.
 */
function setsForTransaction(tokens: readonly string[], open: number): boolean {
  let depth = 0;
  for (let at = open; at < tokens.length; at += 1) {
    if (tokens[at] === '(') depth += 1;
    if (tokens[at] === ')') depth -= 1;
    if (depth === 0) return tokens[at - 2] === ',' && tokens[at - 1] === 'true';
  }
  return false;
}

/**
 * Whether SQL changes the settings of the session beyond the transaction it runs in, which stay
 * with the connection after it: any change `changesSession` says but those of `SET LOCAL` and of
 * `set_config(…, true)`, which end with the transaction. A third argument of `set_config` that is
 * not the word `true` is read as a session's.
 */
export function leavesSession(sql: string, conforming: boolean): boolean {
  const tokens = sqlTokens(sql, conforming);
  if (tokens === undefined) return false;
  return tokens.some((token, at) => {
    return (
      token === '`' ||
      ((at === 0 || tokens[at - 1] === ';') &&
        SESSION_COMMANDS.has(token) &&
        !setsTransaction(tokens, at) &&
        !setsLocal(tokens, at)) ||
      (identifierOf(token) === 'set_config' &&
        tokens[at + 1] === '(' &&
        !setsForTransaction(tokens, at + 1))
    );
  });
}

/** A temporary table's row type, which ordinary staging-table DDL intentionally does not follow. */
export interface TemporaryRowType {
  readonly name: string;
  readonly schema: string;
  readonly visible: boolean;
}

/**
 * Whether a text names one of the temporary row types. Any occurrence of a visible name is
 * conservative: PostgreSQL also takes a type's name before a literal, without CAST or `::`.
 * A qualified name of another schema is not the temporary type. A literal's contents name none.
 */
export function namesTemporaryRowType(
  sql: string,
  types: readonly TemporaryRowType[],
  conforming: boolean,
): boolean {
  if (types.length === 0) return false;
  const tokens = sqlTokens(sql, conforming);
  if (tokens === undefined || tokens.includes('`')) return true;
  for (const at of tokens.keys()) {
    const name = identifierOf(tokens[at]);
    if (name === undefined || tokens[at + 1] === '.') continue;
    const qualified = tokens[at - 1] === '.';
    const schema = qualified ? identifierOf(tokens[at - 2]) : undefined;
    if (
      types.some((type) => {
        return (
          type.name === name &&
          (qualified ? schema === 'pg_temp' || schema === type.schema : type.visible)
        );
      })
    )
      return true;
  }
  return false;
}
