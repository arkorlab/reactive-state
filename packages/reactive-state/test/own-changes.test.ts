import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { followDrizzle } from '../src/sql/index.ts';
import { type LocalD1, localD1 } from '../src/sql/sqlite/local-d1.ts';
import {
  type CountedBinding,
  counts,
  ownChanges,
  ownCount,
} from '../src/sql/sqlite/own-changes.ts';
import {
  changesOf,
  named,
  ownSchema,
  ownTasks,
  tablesOf,
  WRITES,
} from './support/own-changes-cases.ts';

/**
 * A D1 binding whose answers count each statement's own changes (`ownChanges`), of a file in D1's
 * shape (`localD1`), which counts a trigger's rows in a write's `meta.changes` as D1 does: of tables
 * whose writes the log's triggers follow, each write answers what the same write of the same
 * tables of no log answers.
 */

/** A database of memory alone, closed as the test ends. */
function database(): LocalD1 {
  const binding = localD1(':memory:');
  onTestFinished(() => {
    binding.close();
  });
  return binding;
}

/** Runs `statements` on `binding`, in one batch. */
async function ran(binding: LocalD1, statements: readonly string[]): Promise<void> {
  await binding.batch(statements.map((statement) => binding.prepare(statement)));
}

/** A database of the followed tables, their log made, and of their twins of no log. */
async function followed(): Promise<LocalD1> {
  const binding = database();
  await ran(binding, [...tablesOf('own_'), ...tablesOf('plain_')]);
  await ran(binding, followDrizzle(ownSchema).captureSql());
  return binding;
}

/** The rows of the log. */
async function logged(binding: LocalD1): Promise<unknown> {
  return binding.prepare('SELECT count(*) AS n FROM _rs_changes').first('n');
}

/** A binding of `answers` alone: what its batch answers, whatever it is sent. */
function stubbed(answers: readonly unknown[]): CountedBinding {
  const statement = {
    all: () => Promise.resolve(answers[1]),
    bind: () => statement,
    first: () => Promise.resolve(null),
    raw: () => Promise.resolve([]),
    run: () => Promise.resolve(answers[1]),
  };
  return {
    batch: () => Promise.resolve(answers),
    prepare: () => statement,
  };
}

/** An answer of a read of the log's head of `head`, after a statement of `own` direct changes. */
function headAt(head: number, own: number): unknown {
  return { meta: { changes: 0 }, results: [{ _rs_head: head, _rs_own: own }], success: true };
}

describe('a count of a write of its own', () => {
  it("is D1's count less the log's rows, where D1 counted more than the direct changes", () => {
    expect(ownCount(2, 1, 1)).toBe(1);
    // A cascade's rows, which D1 counts beside the direct ones, are kept.
    expect(ownCount(5, 2, 1)).toBe(3);
    // A conflict done nothing of, whose trigger before it logged the row it met.
    expect(ownCount(1, 1, 0)).toBe(0);
  });

  it("is D1's count where it counted the direct changes alone, or the log gained none", () => {
    expect(ownCount(1, 3, 1)).toBe(1);
    expect(ownCount(3, 0, 1)).toBe(3);
  });

  it('is none where D1 counted fewer than the log gained past the direct changes', () => {
    expect(ownCount(2, 5, 1)).toBeUndefined();
  });
});

describe('what a statement is counted of', () => {
  it('is a write of rows, a WITH before one, and a text of a statement it reads not', () => {
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      '  update t set a = 1',
      '/* a comment */ DELETE FROM t',
      'REPLACE INTO t VALUES (1)',
      'WITH x AS (SELECT 1) UPDATE t SET a = 1',
      'WITH x AS (SELECT 1) SELECT * FROM t WHERE a = ?1',
      'INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)',
      '\u{FEFF}INSERT INTO t VALUES (1)',
      // An empty statement before a write, which D1 runs.
      '; INSERT INTO t VALUES (1)',
      '  ;\n UPDATE t SET a = 1',
      // A write of a table whose value or condition names the log, which it writes not.
      "INSERT INTO t (name) VALUES ('_rs_changes')",
      'UPDATE t SET a = 1 WHERE b IN (SELECT tbl FROM _rs_changes)',
    ]) {
      expect({ counted: counts(sql), sql }).toStrictEqual({ counted: true, sql });
    }
  });

  it('is none of a read, a statement of no rows, a text of none, nor a write of the log', () => {
    for (const sql of [
      'SELECT * FROM t',
      'VALUES (1)',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'EXPLAIN INSERT INTO t VALUES (1)',
      'PRAGMA table_info("t")',
      'CREATE TABLE t (a)',
      'DROP TABLE t',
      'ALTER TABLE t ADD COLUMN b',
      '',
      '  \n  -- a comment alone',
      '(1)',
      ';',
      "/* 'a comment' */ ; ''",
      // White space of any script, which D1 trims, and a comment after it.
      '\u{3000}',
      '\u{A0}\n\u{2028}',
      '\u{FEFF}',
      '\u{3000}-- a comment alone',
      "INSERT INTO _rs_changes (tbl, id, before, after, at) VALUES ('t', '', NULL, NULL, 0)",
      'DELETE FROM "_RS_CHANGES" WHERE seq < ?',
      'DELETE FROM main._rs_changes WHERE seq < ?',
    ]) {
      expect({ counted: counts(sql), sql }).toStrictEqual({ counted: false, sql });
    }
  });
});

describe('ownChanges of a D1 binding whose tables log their changes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts the log's rows in what the binding itself answers", async () => {
    const binding = await followed();

    await expect(
      binding.prepare("INSERT INTO own_tasks (id, project_id, title) VALUES (1, 'p', 't')").run(),
    ).resolves.toMatchObject({ meta: { changes: 2 } });
  });

  it("answers each write's own changes, as of the same tables of no log", async () => {
    const binding = await followed();
    const counted = ownChanges(binding);

    for (const { sql, values } of WRITES) {
      const plain = await binding
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

    await expect(logged(binding)).resolves.toBeGreaterThan(WRITES.length);
  });

  it("answers the own changes and the rows of a write's RETURNING through all()", async () => {
    const binding = await followed();
    const counted = ownChanges(binding);
    for (const prefix of ['own_', 'plain_'] as const) {
      await binding
        .prepare(named("INSERT INTO {tasks} (id, project_id, title) VALUES (1, 'p', 'a')", prefix))
        .run();
    }
    const update = 'UPDATE {tasks} SET title = ? WHERE project_id = ? RETURNING id, title';

    const plain = await binding.prepare(named(update, 'plain_')).bind('b', 'p').all();
    const own = await counted.prepare(named(update, 'own_')).bind('b', 'p').all();

    expect(own.results).toStrictEqual([{ id: 1, title: 'b' }]);
    expect(own.meta.changes).toBe(plain.meta.changes);
  });

  it("answers each statement's own changes of a batch, in its order, a read among them", async () => {
    const binding = await followed();
    const counted = ownChanges(binding);
    const writes = [
      "INSERT INTO {tasks} (id, project_id, title, code) VALUES (1, 'p', 'a', 'x'), (2, 'p', 'b', 'y')",
      'SELECT id, title FROM {tasks} ORDER BY id',
      "UPDATE {tasks} SET title = 'c' WHERE project_id = 'p'",
      "INSERT OR IGNORE INTO {tasks} (id, project_id, title, code) VALUES (3, 'q', 'd', 'x')",
      'DELETE FROM {tasks} WHERE id = 1',
    ];
    const of = (through: CountedBinding, prefix: 'own_' | 'plain_') =>
      writes.map((sql) => through.prepare(named(sql, prefix)));

    const plain = await binding.batch(of(binding, 'plain_'));
    const own = await counted.batch(of(counted, 'own_'));

    expect(own).toHaveLength(writes.length);
    expect(changesOf(own)).toStrictEqual(changesOf(plain));
    expect(own[1]).toMatchObject({
      results: [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' },
      ],
    });
  });

  it('runs a statement of the log, raw() and first() as they are, in no batch', async () => {
    const binding = await followed();
    const counted = ownChanges(binding);
    const batch = vi.spyOn(binding, 'batch');

    await expect(
      counted
        .prepare(
          "INSERT INTO _rs_changes (tbl, id, before, after, at) VALUES ('ownTasks', '', NULL, NULL, 0)",
        )
        .run(),
    ).resolves.toMatchObject({ meta: { changes: 1 } });
    await expect(
      counted
        .prepare("INSERT INTO own_tasks (id, project_id, title) VALUES (1, 'p', 'a') RETURNING id")
        .raw(),
    ).resolves.toStrictEqual([[1]]);
    await expect(
      counted
        .prepare("UPDATE own_tasks SET title = 'b' WHERE id = 1 RETURNING title")
        .first('title'),
    ).resolves.toBe('b');
    await expect(counted.prepare('SELECT title FROM own_tasks').all()).resolves.toMatchObject({
      results: [{ title: 'b' }],
    });

    expect(batch).not.toHaveBeenCalled();
  });

  it('runs a statement it did not make as it is, of a batch it counts the others of', async () => {
    const binding = await followed();
    const counted = ownChanges(binding);
    const insert = "INSERT INTO own_tasks (id, project_id, title) VALUES (?, 'p', 't')";

    const [foreign, own] = await counted.batch([
      binding.prepare(insert).bind(1),
      counted.prepare(insert).bind(2),
    ]);

    expect(changesOf([foreign, own])).toStrictEqual([2, 1]);
  });

  it('counts a write whose value names the log, which it writes not', async () => {
    const binding = await followed();
    const counted = ownChanges(binding);

    await expect(
      counted
        .prepare("INSERT INTO own_tasks (id, project_id, title) VALUES (1, 'p', '_rs_changes')")
        .run(),
    ).resolves.toMatchObject({ meta: { changes: 1 } });
  });

  it('counts a write after an empty statement, of one call and of a batch', async () => {
    const binding = await followed();
    const counted = ownChanges(binding);
    const insert = "; INSERT INTO {tasks} (id, project_id, title) VALUES (?, 'p', 'a')";

    const plain = await binding.prepare(named(insert, 'plain_')).bind(1).run();
    const own = await counted.prepare(named(insert, 'own_')).bind(1).run();
    const [batched] = await counted.batch([counted.prepare(named(insert, 'own_')).bind(2)]);

    expect(changesOf([own, batched])).toStrictEqual([plain.meta.changes, plain.meta.changes]);
  });

  it('answers none of a blank statement of a batch, as D1 does, and counts the others', async () => {
    const binding = await followed();
    const counted = ownChanges(binding);
    const writes = [
      '',
      "INSERT INTO {tasks} (id, project_id, title) VALUES (1, 'p', 'a'), (2, 'p', 'b')",
      '  \n  -- nothing but a comment',
      "UPDATE {tasks} SET title = 'c' WHERE id = 1",
      'SELECT id FROM {tasks} ORDER BY id',
      '',
    ];

    const plain = await binding.batch(writes.map((sql) => binding.prepare(named(sql, 'plain_'))));
    const own = await counted.batch(writes.map((sql) => counted.prepare(named(sql, 'own_'))));

    expect(plain).toHaveLength(3);
    expect(own).toHaveLength(plain.length);
    expect(changesOf(own)).toStrictEqual(changesOf(plain));
    expect(own[2]).toMatchObject({ results: [{ id: 1 }, { id: 2 }] });
  });

  it('reads a text of white space of any script as blank, as D1 trims it', async () => {
    const binding = await followed();
    const counted = ownChanges(binding);
    const writes = [
      "INSERT INTO {tasks} (id, project_id, title) VALUES (1, 'p', 'a')",
      '\u{3000}',
      '\u{A0}-- nothing but a comment',
      "UPDATE {tasks} SET title = 'c' WHERE id = 1",
    ];

    const plain = await binding.batch(writes.map((sql) => binding.prepare(named(sql, 'plain_'))));
    const own = await counted.batch(writes.map((sql) => counted.prepare(named(sql, 'own_'))));

    expect(changesOf(own)).toStrictEqual(changesOf(plain));
    await expect(counted.prepare('\u{3000}').run()).rejects.toThrow('No SQL statements detected');
  });

  it('sends a counted statement D1 answered none of again, as it is, as D1 ran none of it', async () => {
    const binding = await followed();
    const heads = new WeakSet();
    // A D1 that reads the statement as blank: of the batch, it answers the reads of the head alone.
    const dropping: CountedBinding = {
      batch: async (statements) => {
        return binding.batch(
          statements.filter((each) => typeof each === 'object' && each !== null && heads.has(each)),
        );
      },
      prepare: (sql) => {
        const statement = binding.prepare(sql);
        if (sql.includes('_rs_head')) heads.add(statement);
        return statement;
      },
    };
    const insert = ownChanges(dropping).prepare(
      "INSERT INTO own_tasks (id, project_id, title) VALUES (1, 'p', 't')",
    ) as { run: () => Promise<unknown> };

    await expect(insert.run()).resolves.toMatchObject({ meta: { changes: 2 } });
    await expect(binding.prepare('SELECT count(*) AS n FROM own_tasks').first('n')).resolves.toBe(
      1,
    );
  });

  it('runs a text of no statement as it is, as D1 refuses it', async () => {
    const binding = await followed();
    const counted = ownChanges(binding);
    const batch = vi.spyOn(binding, 'batch');

    await expect(counted.prepare('').run()).rejects.toThrow('No SQL statements detected');

    expect(batch).not.toHaveBeenCalled();
  });

  it('fails a write as D1 fails it, of nothing written', async () => {
    const binding = await followed();
    const counted = ownChanges(binding);
    await counted
      .prepare("INSERT INTO own_tasks (id, project_id, title, code) VALUES (1, 'p', 't', 'a')")
      .run();
    const before = await logged(binding);

    await expect(
      counted
        .prepare("INSERT INTO own_tasks (id, project_id, title, code) VALUES (2, 'p', 't', 'a')")
        .run(),
    ).rejects.toThrow('UNIQUE constraint failed');
    await expect(
      counted.batch([
        counted.prepare("UPDATE own_tasks SET title = 'u' WHERE id = 1"),
        counted.prepare(
          "INSERT INTO own_tasks (id, project_id, title, code) VALUES (3, 'p', 't', 'a')",
        ),
      ]),
    ).rejects.toThrow('UNIQUE constraint failed');

    await expect(logged(binding)).resolves.toBe(before);
    await expect(binding.prepare('SELECT title FROM own_tasks').all()).resolves.toMatchObject({
      results: [{ title: 't' }],
    });
  });

  it("counts a write of the application's Drizzle, of one statement and of a batch", async () => {
    const binding = await followed();
    const orm = drizzle(ownChanges(binding) as never, { schema: ownSchema });

    const inserted = await orm.insert(ownTasks).values({ id: 1, projectId: 'p', title: 'a' }).run();
    const [updated, rows] = await orm.batch([
      orm.update(ownTasks).set({ title: 'b' }).where(eq(ownTasks.id, 1)),
      orm.select({ title: ownTasks.title }).from(ownTasks),
    ]);

    expect(changesOf([inserted, updated])).toStrictEqual([1, 1]);
    expect(rows).toStrictEqual([{ title: 'b' }]);
  });

  it('is one wrapper of a binding, and a wrapper of its own as it is', async () => {
    const binding = await followed();
    const counted = ownChanges(binding);

    expect(ownChanges(binding)).toBe(counted);
    expect(ownChanges(counted)).toBe(counted);
  });
});

describe('ownChanges of a database of no log', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs a write as it is, and counts the very next once a log is made', async () => {
    const binding = database();
    await ran(binding, tablesOf('own_'));
    const counted = ownChanges(binding);
    const batch = vi.spyOn(binding, 'batch');
    const insert = "INSERT INTO own_tasks (id, project_id, title) VALUES (?, 'p', 't')";

    await expect(counted.prepare(insert).bind(1).run()).resolves.toMatchObject({
      meta: { changes: 1 },
    });
    // Refused of its read of the head, as the database has no `sqlite_sequence`.
    expect(batch).toHaveBeenCalledTimes(1);

    await ran(binding, followDrizzle(ownSchema).captureSql());

    await expect(counted.prepare(insert).bind(2).run()).resolves.toMatchObject({
      meta: { changes: 1 },
    });
    await expect(
      counted.batch([counted.prepare(insert).bind(3), counted.prepare(insert).bind(4)]),
    ).resolves.toMatchObject([{ meta: { changes: 1 } }, { meta: { changes: 1 } }]);
    await expect(binding.prepare(insert).bind(5).run()).resolves.toMatchObject({
      meta: { changes: 2 },
    });
  });
});

describe("ownChanges of the follow's client", () => {
  it('is refused, as the binding the follow is given is what it wraps', async () => {
    const binding = await followed();
    const follow = followDrizzle(ownSchema);

    expect(() => ownChanges(follow.client(binding))).toThrow(
      "wraps the D1 binding the follow is given, not the follow's client",
    );
    expect(() => follow.client(ownChanges(binding))).not.toThrow();
  });

  it("is refused of a session of the follow's client too", async () => {
    type Sessioned = LocalD1 & { readonly withSession: () => Sessioned };
    const sessioned: Sessioned = Object.assign(await followed(), {
      withSession: (): Sessioned => sessioned,
    });
    const client = followDrizzle(ownSchema).client(sessioned);

    expect(() => ownChanges(client.withSession())).toThrow(
      "wraps the D1 binding the follow is given, not the follow's client",
    );
  });
});

describe('a count D1 answered that this reads not', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is answered as D1 gave it, and told once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Told: what it says is asserted below.
    });
    const answers = [headAt(0, 0), { meta: { changes: 2 }, results: [] }, headAt(5, 1)];
    const counted = ownChanges(stubbed(answers));

    await expect(
      (counted.prepare('INSERT INTO t VALUES (1)') as { run: () => Promise<unknown> }).run(),
    ).resolves.toMatchObject({ meta: { changes: 2 } });

    await counted.batch([counted.prepare('UPDATE t SET a = 1')]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('answered as D1 gave it');
  });

  it("is answered as it is of D1's count of the direct changes, which holds no log's row", async () => {
    const warn = vi.spyOn(console, 'warn');
    const answers = [headAt(0, 0), { meta: { changes: 1 }, results: [] }, headAt(2, 1)];
    const counted = ownChanges(stubbed(answers));

    await expect(
      (counted.prepare('INSERT INTO t VALUES (1)') as { run: () => Promise<unknown> }).run(),
    ).resolves.toMatchObject({ meta: { changes: 1 } });

    expect(warn).not.toHaveBeenCalled();
  });

  it('answers a batch whose answers are not one of each statement as D1 gave them, told once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      // Told: what it says is asserted below.
    });
    const extra = { meta: { changes: 0 }, results: [{ id: 1 }] };
    const answers = [headAt(0, 0), { meta: { changes: 2 }, results: [] }, extra];
    const counted = ownChanges(stubbed(answers));

    await expect(
      counted.batch([counted.prepare('INSERT INTO t VALUES (1)')]),
    ).resolves.toStrictEqual([answers[1], extra]);

    await counted.batch([counted.prepare('INSERT INTO t VALUES (2)')]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('otherwise than of one answer each');
  });
});
