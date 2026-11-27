import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import { followDrizzle } from '../src/sql/index.ts';

/**
 * D1's limit of the arguments one SQL function call takes, held of the text `captureSql()` writes
 * of a table of more keys than one `json_object` call takes: each image of a row's keys is made of
 * calls of 32 arguments at most. D1 as Miniflare runs it takes more, so no Workers test holds it.
 */

/** The most arguments D1 takes of one call of an SQL function. */
const D1 = { functionArguments: 32 } as const;
/** A table's boolean columns, each a key: with its id, 41 keys, 82 arguments of an image. */
const FLAGS = 40;
const CALL = 'json_object(';

/** Where the quoted string or name that opens at `open` ends: its quote doubled is one inside it. */
function closingQuote(source: string, open: number): number {
  const quote = source.charAt(open);
  let at = source.indexOf(quote, open + 1);
  while (at !== -1 && source.charAt(at + 1) === quote) at = source.indexOf(quote, at + 2);
  if (at === -1) throw new SyntaxError('A quoted string or name does not end.');
  return at;
}

/**
 * How many arguments the call whose list begins at `start`, past its `(`, takes: the commas of its
 * own level, none inside a nested call's parentheses or a quoted string or name.
 */
function argumentsAt(source: string, start: number): number {
  let depth = 0;
  let commas = 0;
  let empty = true;
  let at = start;
  while (at < source.length) {
    const char = source.charAt(at);
    if (char === ')' && depth === 0) return empty ? 0 : commas + 1;
    if (char.trim() !== '') empty = false;
    switch (char) {
      case "'":
      case '"': {
        at = closingQuote(source, at);
        break;
      }
      case '(': {
        depth += 1;
        break;
      }
      case ')': {
        depth -= 1;
        break;
      }
      case ',': {
        if (depth === 0) commas += 1;
        break;
      }
      default: {
        break;
      }
    }
    at += 1;
  }
  throw new SyntaxError('A call does not end.');
}

/** The arguments of each `json_object` call of `statement`, in the order they open. */
function jsonObjectArguments(statement: string): readonly number[] {
  const counts: number[] = [];
  for (let at = statement.indexOf(CALL); at !== -1; at = statement.indexOf(CALL, at + 1)) {
    counts.push(argumentsAt(statement, at + CALL.length));
  }
  return counts;
}

describe("the change log's triggers of a wide table in D1", () => {
  it('counts the arguments of each call alone, past quoted commas and nested calls', () => {
    expect(
      jsonObjectArguments(`json_object('a,b', json_object("x"",y", 1), CAST(f(1, 2) AS TEXT))`),
    ).toStrictEqual([3, 2]);
    expect(jsonObjectArguments("json_object() || json_object('it''s', 'a)')")).toStrictEqual([
      0, 2,
    ]);
  });

  it('writes no json_object call of more arguments than D1 takes', () => {
    const names = Array.from({ length: FLAGS }, (_, at) => `flag${String(at)}`);
    const flags = sqliteTable('wide_flags', {
      id: text().primaryKey(),
      ...Object.fromEntries(names.map((name) => [name, integer(name, { mode: 'boolean' })])),
    });

    const counts = followDrizzle({ flags })
      .captureSql()
      .flatMap((statement) => jsonObjectArguments(statement));

    expect(Math.max(...counts)).toBeLessThanOrEqual(D1.functionArguments);
    // A call of 16 keys, the most one takes: the images are read, not missed.
    expect(counts).toContain(D1.functionArguments);
  });
});
