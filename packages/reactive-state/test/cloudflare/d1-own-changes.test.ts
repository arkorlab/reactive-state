import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import { followDrizzle } from '../../src/sql/index.ts';
import { ownChanges } from '../../src/sql/sqlite/own-changes.ts';
import {
  changesOf,
  DROPPED,
  named,
  ownSchema,
  ownTasks,
  tablesOf,
  WRITES,
} from '../support/own-changes-cases.ts';

/**
 * A D1 binding whose answers count each statement's own changes (`ownChanges`), run in workerd on
 * Miniflare's D1, which is not production's: of tables whose writes the log's triggers follow, each
 * write answers what the same write of the same tables of no log answers, through the binding, a
 * session of it and Drizzle.
 */

const db = env.REACTIVE_D1;

/** Runs `statements` on the database, in one batch. */
async function ran(statements: readonly string[]): Promise<void> {
  await db.batch(statements.map((statement) => db.prepare(statement)));
}

describe('ownChanges of a D1 binding whose tables log their changes', () => {
  beforeEach(async () => {
    await ran(DROPPED);
    await ran([...tablesOf('own_'), ...tablesOf('plain_')]);
    await ran(followDrizzle(ownSchema).captureSql());
  });

  it("counts the log's rows in what D1 itself answers", async () => {
    const { meta } = await db
      .prepare("INSERT INTO own_tasks (id, project_id, title) VALUES (1, 'p', 't')")
      .run();

    expect(meta.changes).toBe(2);
  });

  it("answers each write's own changes, as of the same tables of no log", async () => {
    const counted = ownChanges(db);

    for (const { sql, values } of WRITES) {
      const plain = await db
        .prepare(named(sql, 'plain_'))
        .bind(...values)
        .run();
      const own = await counted
        .prepare(named(sql, 'own_'))
        .bind(...values)
        .run();

      expect({ changes: own.meta.changes, sql }).toStrictEqual({
        changes: plain.meta.changes,
        sql,
      });
    }
  });

  it("answers each statement's own changes of a batch, in its order, a read among them", async () => {
    const counted = ownChanges(db);
    const writes = [
      "INSERT INTO {tasks} (id, project_id, title, code) VALUES (1, 'p', 'a', 'x'), (2, 'p', 'b', 'y')",
      'SELECT id, title FROM {tasks} ORDER BY id',
      "UPDATE {tasks} SET title = 'c' WHERE project_id = 'p'",
      "INSERT OR IGNORE INTO {tasks} (id, project_id, title, code) VALUES (3, 'q', 'd', 'x')",
      'DELETE FROM {tasks} WHERE id = 1',
    ];

    const plain = await db.batch(writes.map((sql) => db.prepare(named(sql, 'plain_'))));
    const own = await counted.batch(writes.map((sql) => counted.prepare(named(sql, 'own_'))));

    expect(own).toHaveLength(writes.length);
    expect(changesOf(own)).toStrictEqual(changesOf(plain));
    expect(own[1]?.results).toStrictEqual([
      { id: 1, title: 'a' },
      { id: 2, title: 'b' },
    ]);
  });

  it('answers the own changes and the rows of a RETURNING through all(), its rows through raw()', async () => {
    const counted = ownChanges(db);
    await counted
      .prepare("INSERT INTO own_tasks (id, project_id, title) VALUES (1, 'p', 'a')")
      .run();

    const all = await counted
      .prepare('UPDATE own_tasks SET title = ? WHERE id = ? RETURNING id, title')
      .bind('b', 1)
      .all();
    const raw = await counted
      .prepare('UPDATE own_tasks SET title = ? WHERE id = ? RETURNING title')
      .bind('c', 1)
      .raw();

    expect(all.meta.changes).toBe(1);
    expect(all.results).toStrictEqual([{ id: 1, title: 'b' }]);
    expect(raw).toStrictEqual([['c']]);
  });

  it('fails a write as D1 fails it, of nothing written', async () => {
    const counted = ownChanges(db);
    await counted
      .prepare("INSERT INTO own_tasks (id, project_id, title, code) VALUES (1, 'p', 't', 'a')")
      .run();
    const before = await db.prepare('SELECT count(*) AS n FROM _rs_changes').first('n');

    await expect(
      counted
        .prepare("INSERT INTO own_tasks (id, project_id, title, code) VALUES (2, 'p', 't', 'a')")
        .run(),
    ).rejects.toThrow('UNIQUE constraint failed');

    await expect(db.prepare('SELECT count(*) AS n FROM _rs_changes').first('n')).resolves.toBe(
      before,
    );
  });

  it('counts a write whose value names the log, which it writes not', async () => {
    const { meta } = await ownChanges(db)
      .prepare("INSERT INTO own_tasks (id, project_id, title) VALUES (1, 'p', '_rs_changes')")
      .run();

    expect(meta.changes).toBe(1);
  });

  it('counts a write after an empty statement, of one call and of a batch', async () => {
    const counted = ownChanges(db);
    const insert = "; INSERT INTO {tasks} (id, project_id, title) VALUES (?, 'p', 'a')";

    const plain = await db.prepare(named(insert, 'plain_')).bind(1).run();
    const own = await counted.prepare(named(insert, 'own_')).bind(1).run();
    const [batched] = await counted.batch([counted.prepare(named(insert, 'own_')).bind(2)]);

    expect(changesOf([own, batched])).toStrictEqual([plain.meta.changes, plain.meta.changes]);
  });

  it('answers none of a blank statement of a batch, as D1 does, and counts the others', async () => {
    const counted = ownChanges(db);
    const writes = [
      '',
      "INSERT INTO {tasks} (id, project_id, title) VALUES (1, 'p', 'a'), (2, 'p', 'b')",
      '  \n  -- nothing but a comment',
      "UPDATE {tasks} SET title = 'c' WHERE id = 1",
      'SELECT id FROM {tasks} ORDER BY id',
      '',
    ];

    const plain = await db.batch(writes.map((sql) => db.prepare(named(sql, 'plain_'))));
    const own = await counted.batch(writes.map((sql) => counted.prepare(named(sql, 'own_'))));

    expect(plain).toHaveLength(3);
    expect(own).toHaveLength(plain.length);
    expect(changesOf(own)).toStrictEqual(changesOf(plain));
    expect(own[2]?.results).toStrictEqual([{ id: 1 }, { id: 2 }]);
  });

  it('reads a text of white space of any script as blank, as D1 trims it', async () => {
    const counted = ownChanges(db);
    const writes = [
      "INSERT INTO {tasks} (id, project_id, title) VALUES (1, 'p', 'a')",
      '\u{3000}',
      '\u{A0}-- nothing but a comment',
      "UPDATE {tasks} SET title = 'c' WHERE id = 1",
    ];

    const plain = await db.batch(writes.map((sql) => db.prepare(named(sql, 'plain_'))));
    const own = await counted.batch(writes.map((sql) => counted.prepare(named(sql, 'own_'))));

    expect(changesOf(own)).toStrictEqual(changesOf(plain));
    await expect(counted.prepare('\u{3000}').run()).rejects.toThrow('No SQL statements detected');
  });

  it("refuses a session of the follow's client, as it wraps the binding the follow is given", () => {
    const client = followDrizzle(ownSchema).client(db);

    expect(() => ownChanges(client.withSession('first-primary'))).toThrow(
      "wraps the D1 binding the follow is given, not the follow's client",
    );
  });

  it("counts a session's writes, of one statement and of a batch", async () => {
    const session = ownChanges(db).withSession('first-primary');

    const inserted = await session
      .prepare("INSERT INTO own_tasks (id, project_id, title) VALUES (1, 'p', 'a'), (2, 'p', 'b')")
      .run();
    const [updated] = await session.batch([
      session.prepare("UPDATE own_tasks SET title = 'c' WHERE project_id = 'p'"),
    ]);

    expect(inserted.meta.changes).toBe(2);
    expect(updated?.meta.changes).toBe(2);
    expect(session.getBookmark()).toBeTypeOf('string');
  });

  it("counts a write of the application's Drizzle, of one statement and of a batch", async () => {
    const orm = drizzle(ownChanges(db), { schema: ownSchema });

    const inserted = await orm.insert(ownTasks).values({ id: 1, projectId: 'p', title: 'a' }).run();
    const [updated, rows] = await orm.batch([
      orm.update(ownTasks).set({ title: 'b' }).where(eq(ownTasks.id, 1)),
      orm.select({ title: ownTasks.title }).from(ownTasks),
    ]);

    expect(inserted.meta.changes).toBe(1);
    expect(updated.meta.changes).toBe(1);
    expect(rows).toStrictEqual([{ title: 'b' }]);
  });
});

describe('ownChanges of a D1 database of no log', () => {
  beforeEach(async () => {
    await ran(DROPPED);
    await ran(tablesOf('own_'));
  });

  it('answers what D1 answers, of a write and of a batch', async () => {
    const counted = ownChanges(db);

    const inserted = await counted
      .prepare("INSERT INTO own_tasks (id, project_id, title) VALUES (1, 'p', 'a')")
      .run();
    const [updated] = await counted.batch([
      counted.prepare("UPDATE own_tasks SET title = 'b' WHERE id = 1"),
    ]);

    expect(inserted.meta.changes).toBe(1);
    expect(updated?.meta.changes).toBe(1);
  });
});
