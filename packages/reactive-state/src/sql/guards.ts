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
 * Whether the `SET` at `at` sets what holds for the transaction alone and no plan reads: its
 * constraints' deferral (`SET CONSTRAINTS ALL DEFERRED`), not a setting of that prefix
 * (`SET constraints.name = 1`).
 */
function setsConstraints(tokens: readonly string[], at: number): boolean {
  return tokens[at] === 'set' && tokens[at + 1] === 'constraints' && tokens[at + 2] !== '.';
}

/**
 * The tokens of `sql` as each string syntax the session may have reads them: of one known on
 * (`conforming`), that alone; of one not known, both, as a backslash in a string is a letter of it
 * in the one and may end it in the other. None where the text cannot be read in any of them.
 */
function readingsOf(sql: string, conforming: boolean): readonly (readonly string[])[] | undefined {
  const readings = (conforming ? [true] : [true, false])
    .map((each) => sqlTokens(sql, each))
    .filter((tokens) => tokens !== undefined);
  return readings.length === 0 ? undefined : readings;
}

/** Whether `tokens` change a setting of the session (`changesSession`). */
function changesIn(tokens: readonly string[]): boolean {
  return tokens.some((token, at) => {
    return (
      token === '`' ||
      ((at === 0 || tokens[at - 1] === ';') &&
        SESSION_COMMANDS.has(token) &&
        !setsTransaction(tokens, at) &&
        !setsConstraints(tokens, at)) ||
      (identifierOf(token) === 'set_config' && tokens[at + 1] === '(')
    );
  });
}

/**
 * Whether SQL changes the settings of the session it runs on: of a pool, one connection of many,
 * which the others and the store would not share. A Unicode-escaped identifier may spell `set_config`
 * as `changesContext` says. Read by each string syntax the session may have, a change either finds
 * counts; a text that cannot be read in any may change one, and is refused with it: what is let run
 * on a pool's connection may be given to the next to take it, which the text cannot say it leaves
 * as it was. A checked-out connection runs such a text and is closed as it is given back.
 */
export function changesSession(sql: string, conforming: boolean): boolean {
  const readings = readingsOf(sql, conforming);
  return readings === undefined || readings.some((tokens) => changesIn(tokens));
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

/** Whether `tokens` change a setting beyond the transaction (`leavesSession`). */
function leavesIn(tokens: readonly string[]): boolean {
  return tokens.some((token, at) => {
    return (
      token === '`' ||
      ((at === 0 || tokens[at - 1] === ';') &&
        SESSION_COMMANDS.has(token) &&
        !setsTransaction(tokens, at) &&
        !setsConstraints(tokens, at) &&
        !setsLocal(tokens, at)) ||
      (identifierOf(token) === 'set_config' &&
        tokens[at + 1] === '(' &&
        !setsForTransaction(tokens, at + 1))
    );
  });
}

/**
 * Whether SQL changes the settings of the session beyond the transaction it runs in, which stay
 * with the connection after it: any change `changesSession` says but those of `SET LOCAL` and of
 * `set_config(…, true)`, which end with the transaction. A third argument of `set_config` that is
 * not the word `true` is read as a session's. Read by each string syntax the session may have, a
 * change either finds counts; a text that cannot be read in any may change one, as a connection
 * that is closed as it is given back loses nothing but its reconnection.
 */
export function leavesSession(sql: string, conforming: boolean): boolean {
  const readings = readingsOf(sql, conforming);
  return readings === undefined || readings.some((tokens) => leavesIn(tokens));
}

/** The words a statement that ends the transaction under way begins with. */
const TRANSACTION_ENDS = new Set(['abort', 'commit', 'end', 'rollback']);

/**
 * Whether the statement whose first word is at `at` of `tokens` ends the transaction under way: a
 * `COMMIT`, `END`, `ABORT` or `ROLLBACK`, with its options (`AND CHAIN`, `WORK`) — not a rollback to
 * a savepoint, which leaves the settings made before it, nor of a prepared transaction, another's.
 */
function endsTransactionAt(tokens: readonly string[], at: number): boolean {
  if (!TRANSACTION_ENDS.has(tokens[at] ?? '')) return false;
  const next = tokens[at + 1];
  const after = next === 'work' || next === 'transaction' ? tokens[at + 2] : next;
  return after !== 'prepared' && (after !== 'to' || tokens[at] !== 'rollback');
}

/**
 * Whether the settings a transaction holds for itself (`SET LOCAL`, `set_config(…, true)`) are held
 * after `tokens`, as `before` them: `sent`, while they go and where they stop short — one set stays,
 * and the end of the transaction is not told, for a statement that fails before it never ran it —
 * and `ran`, once every statement did, in the order the text has them.
 */
function scopedOver(tokens: readonly string[], before: boolean): Scoped {
  let ran = before;
  let sent = before;
  for (const [at, token] of tokens.entries()) {
    const opens = at === 0 || tokens[at - 1] === ';';
    if (opens && endsTransactionAt(tokens, at)) {
      ran = false;
    } else if (
      (opens && token === 'set' && tokens[at + 1] === 'local') ||
      (identifierOf(token) === 'set_config' &&
        tokens[at + 1] === '(' &&
        setsForTransaction(tokens, at + 1))
    ) {
      ran = true;
      sent = true;
    }
  }
  return { ran, sent };
}

/** What a text does of the settings a transaction holds for itself (`scopedAfter`). */
export interface Scoped {
  /** Whether they are held while the text goes, or after a statement of it fails. */
  readonly sent: boolean;
  /** Whether they are held once every statement of it ran. */
  readonly ran: boolean;
}

/**
 * What `sql`, a text of a connection's, does of the settings a transaction holds for itself
 * (`SET LOCAL`, `set_config(…, true)`) where they `before` it were: set by a statement of it, let
 * go of where a statement of it ends the transaction, whichever way it is written (`COMMIT;`,
 * `END`, `COMMIT AND CHAIN`), in the order the text has them. Let go of only where the text ran to
 * its end (`ran`): while it goes, or where it fails part-way, the transaction may be as it was
 * (`sent`), and holds what it held. Read by each string syntax the session may have, they are held
 * where either reading holds them; of a text that cannot be read in any, they may be, as a render
 * through the connection is refused only while its transaction is open.
 */
export function scopedAfter(sql: string, conforming: boolean, before: boolean): Scoped {
  const readings = readingsOf(sql, conforming);
  if (readings === undefined) return { ran: true, sent: true };
  const each = readings.map((tokens) => scopedOver(tokens, before));
  return { ran: each.some((one) => one.ran), sent: each.some((one) => one.sent) };
}

/**
 * Whether the end of a transaction that begins at `at` of `tokens` starts another at once
 * (`COMMIT AND CHAIN`), with its options before it (`WORK`, `TRANSACTION`).
 */
function chainsAt(tokens: readonly string[], at: number): boolean {
  const next = tokens[at + 1];
  const from = at + (next === 'work' || next === 'transaction' ? 2 : 1);
  return tokens[from] === 'and' && tokens[from + 1] === 'chain';
}

/**
 * Whether `tokens`, a text's, leave a transaction open: one opened (`BEGIN`, `START TRANSACTION`)
 * that no later statement of it ends, or ends and chains to another.
 */
function opensIn(tokens: readonly string[]): boolean {
  let open = false;
  for (const [at, token] of tokens.entries()) {
    if (at !== 0 && tokens[at - 1] !== ';') continue;
    if (token === 'begin' || (token === 'start' && tokens[at + 1] === 'transaction')) open = true;
    else if (endsTransactionAt(tokens, at)) open &&= chainsAt(tokens, at);
  }
  return open;
}

/**
 * Whether SQL leaves a transaction open on the connection it runs on: of a pool, one that is given
 * to the next to take it, who would write into a transaction no one commits. A text that opens one
 * and ends it (`BEGIN; …; COMMIT`) leaves none, one that chains (`COMMIT AND CHAIN`) leaves another
 * open. Read by each string syntax the session may have; a
 * text that cannot be read in any is for `changesSession` to refuse.
 */
export function leavesTransactionOpen(sql: string, conforming: boolean): boolean {
  const readings = readingsOf(sql, conforming);
  return readings?.some((tokens) => opensIn(tokens)) === true;
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
