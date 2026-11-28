import { env } from 'cloudflare:workers';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, it } from 'vitest';

import { d1Executor, pruneChanges } from '../../src/cloudflare/d1-store.ts';
import { type DrizzleD1Follow, followDrizzle } from '../../src/sql/index.ts';
import { storeThrough } from '../support/follow-store.ts';

/**
 * The change log of a Drizzle schema's tables in D1, run in workerd, as `captureSql()` makes it and
 * a prune lets go of it — the follow's (`follow.prune`) or `./d1`'s (`pruneChanges`, through
 * `d1Executor`), one statement: its epoch, the head a prune keeps, the entries it keeps from the
 * first new one on, of a clock that stepped back too, and the triggers' stamps in milliseconds; a
 * page of the follow's store, of its bound alone; and the triggers' names and images, a key of 64
 * bits as its text too.
 */

const records = sqliteTable('log_records', { id: text().primaryKey() });
const schema = { records };
const db = env.REACTIVE_D1;
/** The times a test stamps the log's entries with, in milliseconds, and a page of the log. */
const TIMES = { old: 10, recent: 20 } as const;
const PAGE = 100;
/** A minute, in milliseconds: a prune's margin past a clock's granularity, either side of now. */
const MINUTE_MS = 60_000;
/** The greatest key SQLite's integers hold, past JavaScript's safe ones. */
const MAX_INTEGER = '9223372036854775807';
/**
 * More keys than one of D1's JSON calls takes (`KEYS_A_CALL`): each boolean column is a key. D1 as
 * Miniflare runs it takes more arguments than production's 32, so the case holds how the calls'
 * objects are joined; `test/d1-capture-arguments.test.ts` holds the limit of the text.
 */
const FLAGS = 20;

/** The follow's prune, and `./d1`'s, of the same statement. */
const PRUNES = [
  {
    what: "the follow's prune",
    prune: (follow: DrizzleD1Follow<typeof schema>, before: number) => follow.prune(db, before),
  },
  {
    what: "`./d1`'s pruneChanges",
    prune: (_follow: DrizzleD1Follow<typeof schema>, before: number) =>
      pruneChanges(d1Executor(db), before),
  },
] as const;

/** One statement of the application's own. */
async function run(statement: string, ...params: readonly unknown[]): Promise<void> {
  await db
    .prepare(statement)
    .bind(...params)
    .run();
}

/** The statements of `follow.captureSql()`, run in one batch. */
async function install(follow: { readonly captureSql: () => readonly string[] }): Promise<void> {
  await db.batch(follow.captureSql().map((statement) => db.prepare(statement)));
}

/** The log's own epoch, as the log's statements keep it. */
async function epochOf(): Promise<string | undefined> {
  const row = await db
    .prepare("SELECT value FROM _rs_meta WHERE key = 'epoch'")
    .first<{ value: string }>();
  return row?.value;
}

/** The entries of rows the log holds, by their numbers. */
async function rowEntries(): Promise<readonly number[]> {
  const { results } = await db
    .prepare("SELECT seq FROM _rs_changes WHERE id = 'row' ORDER BY seq")
    .all<{ seq: number }>();
  return results.map((row) => row.seq);
}

/** The log's entries after `seq`, as the triggers wrote them. */
async function logged(after: number) {
  const { results } = await db
    .prepare('SELECT tbl, id, before, after FROM _rs_changes WHERE seq > ? ORDER BY seq')
    .bind(after)
    .all<{ tbl: string; id: string; before: string | null; after: string | null }>();
  return results.map((row) => {
    return {
      after: row.after === null ? null : (JSON.parse(row.after) as unknown),
      before: row.before === null ? null : (JSON.parse(row.before) as unknown),
      id: row.id,
      tbl: row.tbl,
    };
  });
}

/** The log's head. */
async function head(): Promise<number> {
  const row = await db
    .prepare(
      "SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = '_rs_changes'), 0) AS seq",
    )
    .first<{ seq: number }>();
  return row?.seq ?? 0;
}

describe('the change log of a Drizzle schema in D1, and its prune', () => {
  beforeEach(async () => {
    await db.batch(
      [
        'DROP TABLE IF EXISTS log_records',
        'DROP TABLE IF EXISTS _rs_changes',
        'DROP TABLE IF EXISTS _rs_meta',
        'CREATE TABLE log_records (id TEXT PRIMARY KEY NOT NULL)',
      ].map((statement) => db.prepare(statement)),
    );
    await install(followDrizzle(schema));
  });

  it.each(PRUNES)('keeps the head once $what lets go of every entry', async ({ prune }) => {
    const follow = followDrizzle(schema);
    const store = storeThrough(follow, db);
    await run("INSERT INTO log_records VALUES ('one'), ('two')");
    await run('UPDATE _rs_changes SET at = ?', TIMES.old);
    const before = await store.changes(0, PAGE);

    await prune(follow, TIMES.recent);
    const empty = await store.changes(0, PAGE);
    await run("INSERT INTO log_records VALUES ('three')");
    const next = await store.changes(before.head, PAGE);

    // The capture's entry of the table, then one of each row.
    expect(before.changes).toHaveLength(3);
    // What was let go of is behind the floor: a follower there renders again what read the tables.
    expect(empty).toStrictEqual({
      changes: [],
      epoch: before.epoch,
      floor: before.head + 1,
      head: before.head,
    });
    expect(next.changes).toHaveLength(1);
    expect(next.changes[0]?.seq).toBeGreaterThan(before.head);
  });

  it.each(PRUNES)('keeps each entry after the first new one, of $what', async ({ prune }) => {
    const follow = followDrizzle(schema);
    const store = storeThrough(follow, db);
    for (const id of ['one', 'two', 'three', 'four']) {
      await run('INSERT INTO log_records VALUES (?)', id);
    }
    const [first, second, third, fourth] = await rowEntries();
    // The database's clock stepped back as the third was written: stamped before the second.
    await run('UPDATE _rs_changes SET at = ?', TIMES.old);
    await run('UPDATE _rs_changes SET at = ? WHERE seq IN (?, ?)', TIMES.recent, second, fourth);

    await prune(follow, TIMES.recent);
    const kept = await store.changes(0, PAGE);

    // The capture's entry and the first are let go of: none is let go of from between two kept,
    // nor from the first new one on, the last new one's either.
    expect(first).toBeLessThan(second ?? 0);
    expect(kept.changes.map((change) => change.seq)).toStrictEqual([second, third, fourth]);
    expect(kept.floor).toBe(second);
  });

  it.each(PRUNES)('reads the triggers’ stamps in milliseconds, of $what', async ({ prune }) => {
    const follow = followDrizzle(schema);
    await run("INSERT INTO log_records VALUES ('one')");
    const [entry] = await rowEntries();

    // Of the stamps as the triggers wrote them: an entry of now is newer than a minute before.
    await prune(follow, Date.now() - MINUTE_MS);
    const kept = await rowEntries();
    await prune(follow, Date.now() + MINUTE_MS);
    const left = await rowEntries();

    expect(kept).toStrictEqual([entry]);
    expect(left).toStrictEqual([]);
  });

  it('answers each row of a statement through `d1Executor`, of its parameters in order', async () => {
    const rows = await d1Executor(db).all('SELECT ?1 AS v, ?2 AS w UNION ALL SELECT ?2, ?1', [
      7,
      'eight',
    ]);

    expect(rows).toStrictEqual([
      { v: 7, w: 'eight' },
      { v: 'eight', w: 7 },
    ]);
  });

  it("reads a page of the follow's log of its bound alone, of one head and epoch", async () => {
    const store = storeThrough(followDrizzle(schema), db);
    await run("INSERT INTO log_records VALUES ('one'), ('two')");

    const page = await store.changes(0, 1);
    const tail = await store.changes(page.changes[0]?.seq ?? 0, 1);

    // The capture's entry of the table, then the rows': more than either page holds.
    expect(page.head).toBe(3);
    expect(page.changes).toHaveLength(1);
    expect(tail.changes).toHaveLength(1);
    expect(page.head).toBe(tail.head);
    expect(page.epoch).toBe(tail.epoch);
    expect(tail.changes[0]?.seq).toBeGreaterThan(page.changes[0]?.seq ?? 0);
  });

  it("keeps the log's epoch as `captureSql()` runs again, and begins it anew of a log made again", async () => {
    const follow = followDrizzle(schema);
    const store = storeThrough(follow, db);
    const first = await epochOf();
    await install(follow);
    const again = await epochOf();
    const read = await store.changes(0, PAGE);

    await run('DROP TABLE _rs_changes');
    await install(follow);
    // Read before the store reads the schema again: the epoch alone tells of the log made again.
    const remade = await store.changes(read.head, PAGE);

    expect(first).toBeTypeOf('string');
    expect(again).toBe(first);
    await expect(epochOf()).resolves.not.toBe(first);
    expect(remade.epoch).not.toBe(read.epoch);
    expect(remade.head).toBeLessThan(read.head);
  });

  it('logs every write of two tables whose declared names differ in case alone', async () => {
    // SQLite's names are of any case: the triggers' names hold the declared name's bytes in hex.
    const named = {
      records: sqliteTable('lower"records', { id: text().primaryKey(), title: text() }),
      Records: sqliteTable('upper records', { id: text().primaryKey(), title: text() }),
    };
    const physical = ['"lower""records"', '"upper records"'];
    for (const table of physical) {
      await run(`DROP TABLE IF EXISTS ${table}`);
      await run(`CREATE TABLE ${table} (id TEXT PRIMARY KEY NOT NULL, title TEXT)`);
    }
    await install(followDrizzle(named));
    const at = await head();

    for (const table of physical) {
      await run(`INSERT INTO ${table} VALUES ('one', 'before')`);
      await run(`UPDATE ${table} SET title = 'after' WHERE id = 'one'`);
      await run(`DELETE FROM ${table} WHERE id = 'one'`);
    }
    const entries = await logged(at);

    expect(entries.map((entry) => entry.tbl)).toStrictEqual(
      Object.keys(named).flatMap((name) => [name, name, name]),
    );
    expect(entries.map((entry) => [entry.before, entry.after])).toStrictEqual(
      Object.keys(named).flatMap(() => {
        return [
          [null, { k_id: 'one' }],
          [{ k_id: 'one' }, { k_id: 'one' }],
          [{ k_id: 'one' }, null],
        ];
      }),
    );
  });

  it('logs a key of 64 bits as its text, of an insert and a delete', async () => {
    const big = sqliteTable('big_records', { id: integer().primaryKey() });
    await run('DROP TABLE IF EXISTS big_records');
    await run('CREATE TABLE big_records (id INTEGER PRIMARY KEY)');
    await install(followDrizzle({ big }));
    const at = await head();

    // Written in the statements' text: a JavaScript number would round it.
    await run(`INSERT INTO big_records VALUES (${MAX_INTEGER})`);
    await run(`DELETE FROM big_records WHERE id = ${MAX_INTEGER}`);
    const { results } = await db
      .prepare("SELECT before, after FROM _rs_changes WHERE seq > ? AND id = 'row' ORDER BY seq")
      .bind(at)
      .all<{ before: string | null; after: string | null }>();

    const image = `{"k_id":"${MAX_INTEGER}"}`;

    expect(results).toStrictEqual([
      { after: image, before: null },
      { after: null, before: image },
    ]);
  });

  it('logs every key of a row of more keys than one D1 JSON call takes', async () => {
    const names = Array.from({ length: FLAGS }, (_, at) => `flag${String(at)}`);
    const flags = sqliteTable('wide_flags', {
      id: text().primaryKey(),
      ...Object.fromEntries(names.map((name) => [name, integer(name, { mode: 'boolean' })])),
    });
    await run('DROP TABLE IF EXISTS wide_flags');
    const columns = names.map((name) => `${name} INTEGER`).join(', ');
    await run(`CREATE TABLE wide_flags (id TEXT PRIMARY KEY NOT NULL, ${columns})`);
    await install(followDrizzle({ flags }));
    const at = await head();

    await run("INSERT INTO wide_flags (id, flag0, flag19) VALUES ('wide', 1, 1)");
    const [entry] = await logged(at);

    expect(entry?.after).toStrictEqual({
      k_id: 'wide',
      ...Object.fromEntries(names.map((name) => [`k_${name}`, null])),
      k_flag0: '1',
      k_flag19: '1',
    });
  });
});
