import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { eq, sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { hostOf } from '../src/authority/database-host.ts';
import { startAuthority } from '../src/authority/index.ts';
import { refuse } from '../src/server/index.ts';
import { reactiveDb } from '../src/sql/db.ts';
import { logTrigger } from '../src/sql/sqlite/installed.ts';
import { type LocalD1, localD1 } from '../src/sql/sqlite/local-d1.ts';

/**
 * `reactiveDb` of a schema of SQLite's tables, which D1 keeps: of no Cloudflare in the process, a
 * file of SQLite's in D1's shape, whose log the authority makes and follows as it starts.
 */

const tasks = sqliteTable('tasks', {
  id: text().primaryKey(),
  title: text().notNull(),
  done: integer({ mode: 'boolean' }).notNull().default(false),
});
const schema = { tasks };
const DDL =
  'CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL, done integer NOT NULL DEFAULT 0)';
const BUILD = 'b_reactive_db_d1';
/** A table that drops a duplicate row, with a trigger of the application's that audits it first. */
const IGNORING = [
  'CREATE TABLE tasks (id text PRIMARY KEY ON CONFLICT IGNORE, title text NOT NULL, done integer NOT NULL DEFAULT 0)',
  'CREATE TABLE audit (id text)',
  'CREATE TRIGGER audited BEFORE INSERT ON tasks BEGIN INSERT INTO audit VALUES (NEW.id); END',
];
/** A table whose trigger of the application's, before a delete, deletes the row itself. */
const DELETING = [
  DDL,
  'CREATE TRIGGER deleting BEFORE DELETE ON tasks BEGIN DELETE FROM tasks WHERE id = OLD.id; END',
];
/** A table with a trigger of the application's that runs after an update. */
const AFTER_UPDATE = [
  DDL,
  'CREATE TABLE audit (id text)',
  'CREATE TRIGGER audited AFTER UPDATE ON tasks BEGIN INSERT INTO audit VALUES (NEW.id); END',
];
/** Rows `a` and `b`: an update of `a` to the key `b` meets a row, so the log is written first. */
const TWO_ROWS = [DDL, "INSERT INTO tasks VALUES ('b', 'two', 0)"];
/** A trigger of the application's on the log, made once the authority has: it deletes row `a`. */
const ON_LOG = [
  "CREATE TRIGGER zz_log AFTER INSERT ON _rs_changes BEGIN DELETE FROM tasks WHERE id = 'a'; END",
];
/** The audit table a temporary trigger writes, and a plain `tasks`. */
const AUDITED = [DDL, 'CREATE TABLE audit (id text)'];
/** A temporary trigger that audits and drops an insert into the table of the file. */
const TEMP_TRIGGER = [
  'CREATE TEMP TRIGGER dropped BEFORE INSERT ON main.tasks BEGIN INSERT INTO audit VALUES (NEW.id); SELECT RAISE(IGNORE); END',
];
/** A temporary table of the name, of a key that drops a duplicate, with its own audit trigger. */
const TEMP_TABLE = [
  'CREATE TEMP TABLE tasks (id text PRIMARY KEY ON CONFLICT IGNORE, title text NOT NULL, done integer NOT NULL DEFAULT 0)',
  "INSERT INTO temp.tasks VALUES ('a', 'one', 0)",
  'CREATE TEMP TRIGGER audited BEFORE INSERT ON temp.tasks BEGIN INSERT INTO main.audit VALUES (NEW.id); END',
];
/** An indexed table of rows, and a trigger that runs `pragma_optimize` and drops the insert. */
const PRAGMA_TRIGGER = [
  DDL,
  'CREATE INDEX tasks_title ON tasks (title)',
  "INSERT INTO tasks VALUES ('b', 'two', 0)",
  'CREATE TRIGGER optimizing BEFORE INSERT ON tasks BEGIN SELECT * FROM pragma_optimize(65538); SELECT RAISE(IGNORE); END',
];
/** An indexed table of rows, and a view of no row whose read runs `pragma_optimize`. */
const PRAGMA_VIEW = [
  DDL,
  'CREATE INDEX tasks_title ON tasks (title)',
  "INSERT INTO tasks VALUES ('b', 'two', 0)",
  'CREATE TABLE audit (id text)',
  "CREATE VIEW opt AS SELECT 'x' AS id FROM pragma_optimize(65538)",
];
/** An indexed table of rows, and an FTS5 table whose content is `pragma_optimize`. */
const PRAGMA_CONTENT = [
  DDL,
  'CREATE INDEX tasks_title ON tasks (title)',
  "INSERT INTO tasks VALUES ('b', 'two', 0)",
  "CREATE VIRTUAL TABLE ft USING fts5(optimize, content='pragma_optimize', content_rowid='arg')",
];
/** An FTS5 table of a plain content table. */
const PLAIN_CONTENT = [
  DDL,
  "CREATE VIRTUAL TABLE fts USING fts5(title, content='tasks', content_rowid='rowid')",
];
/** A table with a generated column and a column that names a pragma: no virtual table. */
const GENERATED = [
  DDL,
  'CREATE TABLE notes (a INTEGER, pragma_note TEXT, b INTEGER AS (a + 1) VIRTUAL)',
];
/** A trigger shaped as the log's own that joins a view which raises, made once the log is. */
const JOINING = [
  'CREATE VIEW quiet AS SELECT raise(ignore) AS x',
  `CREATE TRIGGER "_rsd_00_replaced_insert" BEFORE INSERT ON "tasks" BEGIN INSERT INTO _rs_changes (tbl, id, before, after, at) SELECT 'tasks', quiet.x, NULL, NULL, 0 FROM "tasks" AS c JOIN quiet; END`,
];
/** The bodies of a log-shaped trigger that read the view `quiet`, which raises, but for a join. */
const READING_QUIET = [
  ['a comma join', `SELECT 'tasks', quiet.x, NULL, NULL, 0 FROM "tasks" AS c , quiet`],
  ['IN of a name', `VALUES ('tasks', '', NULL, NULL, 0 IN quiet)`],
  [
    'the own text in a string',
    `SELECT 'FROM "tasks" AS c WHERE ', quiet.x, NULL, NULL, 0 FROM quiet`,
  ],
  [
    'the own text in a comment',
    `SELECT 'tasks', quiet.x, NULL, NULL, 0 FROM quiet /* FROM "tasks" AS c WHERE */`,
  ],
] as const;
/** The log made again, as `changeLogSql()` makes it but for a check that raises on `at` 0. */
const CHECKED_LOG = [
  'DROP TABLE _rs_changes',
  'CREATE TABLE _rs_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, tbl TEXT NOT NULL, id TEXT NOT NULL, before TEXT, after TEXT, at INTEGER NOT NULL CHECK (at <> 0 OR raise(ignore)))',
];
/** A trigger shaped as the log's own that logs a row, then one the check raises on. */
const RAISING_LOG = [
  ...CHECKED_LOG,
  `CREATE TRIGGER "_rsd_00_replaced_insert" BEFORE INSERT ON "tasks" BEGIN INSERT INTO _rs_changes (tbl, id, before, after, at) VALUES ('tasks', '', NULL, NULL, 1); INSERT INTO _rs_changes (tbl, id, before, after, at) VALUES ('tasks', '', NULL, NULL, 0); END`,
];
/** A table keyed by the log's first row, which a cascade moves; a trigger upserts it away. */
const CASCADING = [
  'CREATE TABLE cascaded (x INTEGER PRIMARY KEY REFERENCES _rs_changes (seq) ON UPDATE CASCADE, y INTEGER)',
  'INSERT INTO cascaded VALUES (1, 0)',
  `CREATE TRIGGER "_rsd_00_replaced_update" BEFORE UPDATE ON "cascaded" BEGIN INSERT INTO _rs_changes (seq, tbl, id, before, after, at) VALUES (1, 't', '', NULL, NULL, 0) ON CONFLICT (seq) DO UPDATE SET seq = 2; END`,
];
const cascaded = sqliteTable('cascaded', { x: integer().primaryKey(), y: integer() });
/** The log made again, its key replacing on conflict, and a table keyed by one of its rows. */
const REPLACING_LOG = [
  'DROP TABLE _rs_changes',
  'CREATE TABLE _rs_changes (seq INTEGER PRIMARY KEY ON CONFLICT REPLACE, tbl TEXT NOT NULL, id TEXT NOT NULL, before TEXT, after TEXT, at INTEGER NOT NULL)',
  "INSERT INTO _rs_changes VALUES (1, 'x', 'x', NULL, NULL, 0)",
  'CREATE TABLE cascaded (x INTEGER PRIMARY KEY REFERENCES _rs_changes (seq) ON DELETE CASCADE, y INTEGER)',
  'INSERT INTO cascaded VALUES (1, 0)',
  `CREATE TRIGGER "_rsd_00_replaced_update" BEFORE UPDATE ON "cascaded" BEGIN INSERT INTO _rs_changes (seq, tbl, id, before, after, at) VALUES (1, 't', '', NULL, NULL, 0); END`,
];
/** A table with a trigger of the application's that raises after an update. */
const AFTER_RAISE = [
  DDL,
  'CREATE TRIGGER raising AFTER UPDATE ON tasks BEGIN SELECT RAISE(IGNORE); END',
];
/** A view that ends the statement that reads it, `RAISE(IGNORE)`. */
const QUIET_VIEW = [DDL, 'CREATE VIEW quiet AS SELECT raise(ignore) AS x'];
/** How long an operation sleeps past its time in a test of its time, and its time. */
const SLOW = { pastMs: 600, timeoutMs: 200 } as const;
/** How long another process holds a file's lock of SQLite's in a test. */
const HELD_MS = 600;
/**
 * A process that holds the lock of SQLite's of the file it is given for as long as it is told, and
 * writes the file it is told of just before it lets go: another start of the file's, to wait for.
 */
const HOLDER = `
const { writeFileSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const [file, marker, ms] = process.argv.slice(1);
const lock = new DatabaseSync(file);
lock.exec('BEGIN EXCLUSIVE');
console.log('held');
setTimeout(() => {
  writeFileSync(marker, '');
  lock.exec('COMMIT');
}, Number(ms));
`;
/** Drizzle's journal of one migration, as `drizzle-kit` writes it of SQLite. */
const JOURNAL = {
  dialect: 'sqlite',
  entries: [
    { breakpoints: true, idx: 0, tag: '0000_first', version: '6', when: 1_700_000_000_000 },
  ],
  version: '7',
};

/** What a process has of where the file is: none, unless a test says. */
const environment = { file: process.env['D1_FILE'] };

/** A directory of the test's own, removed as it ends. */
function directory(): string {
  const made = mkdtempSync(path.join(tmpdir(), 'reactive-d1-'));
  onTestFinished(() => {
    rmSync(made, { force: true, recursive: true });
  });
  return made;
}

/**
 * Has another process hold `file` from as this resolves, for `HELD_MS`: `marker` is there once it
 * lets go.
 */
async function heldElsewhere(file: string, marker: string): Promise<void> {
  const holder = spawn(process.execPath, ['-e', HOLDER, file, marker, String(HELD_MS)]);
  onTestFinished(() => {
    holder.kill();
  });
  const said: string[] = [];
  holder.stdout.on('data', (data: Buffer) => {
    said.push(String(data));
  });
  await vi.waitFor(
    () => {
      expect(said.join('')).toContain('held');
    },
    { timeout: 10_000 },
  );
}

/** Whether `file`'s lock of SQLite's is there to take now, of no process holding it. */
function free(file: string): boolean {
  using probe = new DatabaseSync(file);
  try {
    probe.exec('BEGIN EXCLUSIVE');
    return true;
  } catch {
    return false;
  }
}

/** A database of memory alone in D1's shape, closed as the test ends. */
function memory(): LocalD1 {
  const binding = localD1(':memory:');
  onTestFinished(() => {
    binding.close();
  });
  return binding;
}

/** A folder of Drizzle's migrations of one, `statements`, as `drizzle-kit` writes one of SQLite. */
function migrationsOf(statements: string): string {
  const folder = path.join(directory(), 'drizzle');
  mkdirSync(path.join(folder, 'meta'), { recursive: true });
  writeFileSync(path.join(folder, 'meta/_journal.json'), JSON.stringify(JOURNAL));
  writeFileSync(path.join(folder, '0000_first.sql'), statements);
  return folder;
}

/** A database of `schema` in its own file, its table made, its host closed as the test ends. */
async function opened(file = path.join(directory(), 'd1.sqlite')) {
  process.env['D1_FILE'] = file;
  const opening = await reactiveDb(schema);
  onTestFinished(async () => {
    await hostOf(opening.db)?.close();
  });
  return opening;
}

/** The application's Drizzle over the file, as an operation's code writes through it. */
type Orm = Awaited<ReturnType<typeof opened>>['orm'];

/** What an operation's file is made of beside the table of one task `a`, and how long a call may run. */
interface Setting {
  /** The statements that make the tables and triggers, in place of `DDL`. */
  readonly ddl?: readonly string[];
  /** The statements that run once the authority has started, which makes the log. */
  readonly after?: readonly string[];
  readonly timeoutMs?: number;
}

/**
 * The authority of one operation, `write`, over a file of one task `a`: sends it, and answers what
 * it was rejected with, of the operation `id` given or a new one's.
 */
async function operating(
  write: (orm: Orm) => Promise<void>,
  setting: Setting = {},
): Promise<((id?: string) => Promise<unknown>) & { readonly orm: Orm }> {
  const { db, orm } = await opened();
  const statements = setting.ddl ?? [DDL];
  for (const statement of statements) await orm.run(sql.raw(statement));
  await orm.insert(tasks).values({ id: 'a', title: 'one' });
  const authority = await startAuthority({
    buildId: BUILD,
    database: db,
    operations: { 'actions/tasks': { write: async () => write(orm) } },
    programs: [],
    ...(setting.timeoutMs !== undefined && { timeoutMs: setting.timeoutMs }),
  });
  onTestFinished(() => authority.close());
  const after = setting.after ?? [];
  for (const statement of after) await orm.run(sql.raw(statement));
  const { sessionId } = await authority.engine.login('alice');
  const operate = async (id = crypto.randomUUID()): Promise<unknown> => {
    try {
      return await authority.engine.operate(sessionId, {
        args: [],
        build: BUILD,
        module: 'actions/tasks',
        name: 'write',
        operationId: id,
      });
    } catch (error) {
      return error;
    }
  };
  return Object.assign(operate, { orm });
}

describe('reactiveDb of a schema of SQLite', () => {
  beforeEach(() => {
    delete process.env['DATABASE_URL'];
  });

  afterEach(() => {
    if (environment.file === undefined) delete process.env['D1_FILE'];
    else process.env['D1_FILE'] = environment.file;
  });

  it('is a file of SQLite in D1 shape, whose log the authority makes and follows', async () => {
    const { db, orm } = await opened();
    await orm.run(sql.raw(DDL));
    const authority = await startAuthority({ buildId: BUILD, database: db, programs: [] });
    onTestFinished(() => authority.close());

    await orm.insert(tasks).values({ id: 'a', title: 'one' });
    await authority.engine.poke();

    const [logged] = await orm.all<{ entries: number }>(
      sql`SELECT count(*) AS entries FROM _rs_changes`,
    );

    expect(logged?.entries).toBeGreaterThan(0);
  });

  it('keeps its records in the file between runs', async () => {
    const file = path.join(directory(), 'kept/d1.sqlite');
    const first = await opened(file);
    await first.orm.run(sql.raw(DDL));
    await first.orm.insert(tasks).values({ id: 'a', title: 'kept' });
    await hostOf(first.db)?.close();

    const again = await opened(file);

    await expect(again.orm.select().from(tasks)).resolves.toStrictEqual([
      { done: false, id: 'a', title: 'kept' },
    ]);
  });

  it("answers what a write returns, and reads a boolean as Drizzle's mode says", async () => {
    const { orm } = await opened();
    await orm.run(sql.raw(DDL));

    await expect(
      orm.insert(tasks).values({ done: true, id: 'a', title: 'one' }).returning(),
    ).resolves.toStrictEqual([{ done: true, id: 'a', title: 'one' }]);
  });

  it("answers a write's own changes, not the rows the log's triggers wrote beside them", async () => {
    const { db, orm } = await opened();
    await orm.run(sql.raw(DDL));
    const authority = await startAuthority({ buildId: BUILD, database: db, programs: [] });
    onTestFinished(() => authority.close());

    const inserted = await orm.insert(tasks).values({ id: 'a', title: 'one' }).run();
    const [updated] = await orm.batch([
      orm.update(tasks).set({ title: 'two' }).where(eq(tasks.id, 'a')),
    ]);

    expect(inserted).toMatchObject({ meta: { changes: 1 } });
    expect(updated).toMatchObject({ meta: { changes: 1 } });
    // The log's own rows of the two writes, which D1's count holds beside theirs.
    await expect(
      orm.all<{ entries: number }>(
        sql`SELECT count(*) AS entries FROM _rs_changes WHERE id = 'row'`,
      ),
    ).resolves.toStrictEqual([{ entries: 2 }]);
  });

  it('counts what a trigger writes in what a write changed, as D1 does', async () => {
    const binding = memory();
    await binding.prepare('CREATE TABLE a (id integer PRIMARY KEY)').run();
    await binding.prepare('CREATE TABLE b (id integer)').run();
    await binding
      .prepare('CREATE TRIGGER a_b AFTER INSERT ON a BEGIN INSERT INTO b VALUES (new.id); END')
      .run();

    await expect(binding.prepare('INSERT INTO a VALUES (1)').run()).resolves.toMatchObject({
      meta: { changes: 2 },
    });
    await expect(
      binding.prepare('INSERT INTO a VALUES (2) RETURNING id').all(),
    ).resolves.toMatchObject({ meta: { changes: 2 }, results: [{ id: 2 }] });
    await expect(binding.prepare('SELECT id FROM a').all()).resolves.toMatchObject({
      meta: { changes: 0 },
    });
  });

  it('refuses a statement of a transaction behind a comment', async () => {
    const binding = memory();

    await expect(binding.prepare('/* the migration */ BEGIN').run()).rejects.toThrow('one batch');
    await expect(binding.prepare('-- the migration\nBEGIN').run()).rejects.toThrow('one batch');
    await expect(binding.prepare('-- one\n/* two */\n  SAVEPOINT s').run()).rejects.toThrow(
      'one batch',
    );
    await expect(binding.prepare('; BEGIN').run()).rejects.toThrow('one batch');
    await expect(binding.prepare('SELECT 1; BEGIN').run()).rejects.toThrow('one batch');
    await expect(binding.prepare('-- begin\nSELECT 1 AS one').first('one')).resolves.toBe(1);
    await expect(binding.prepare("/* a */ SELECT '*/ end' AS one").first('one')).resolves.toBe(
      '*/ end',
    );
  });

  it('migrates and seeds alone of the processes that open its file', async () => {
    const file = path.join(directory(), 'd1.sqlite');
    const marker = `${file}.let-go`;
    const { db } = await opened(file);
    await heldElsewhere(`${file}.lock`, marker);
    const ran = { after: false };

    await hostOf(db)?.alone(() => {
      ran.after = existsSync(marker);
      return Promise.resolve();
    });

    expect(ran.after).toBe(true);
  });

  it('lets go of the lock as its work ends, or fails', async () => {
    const file = path.join(directory(), 'd1.sqlite');
    const { db } = await opened(file);
    const work = vi.fn<() => Promise<void>>();

    await hostOf(db)?.alone(work);
    const afterWork = free(`${file}.lock`);

    await expect(hostOf(db)?.alone(() => Promise.reject(new Error('Not now.')))).rejects.toThrow(
      'Not now.',
    );

    const afterFailure = free(`${file}.lock`);

    expect(work).toHaveBeenCalledTimes(1);
    expect({ afterFailure, afterWork }).toStrictEqual({ afterFailure: true, afterWork: true });
  });

  it('starts a database of memory alone with no file of its own', async () => {
    const { db } = await opened(':memory:');
    const work = vi.fn<() => Promise<void>>();

    await hostOf(db)?.alone(work);

    expect(work).toHaveBeenCalledTimes(1);
    expect(existsSync(':memory:.lock')).toBe(false);
  });

  it('opens a file another process writes, once it is let go of', async () => {
    const file = path.join(directory(), 'd1.sqlite');
    const marker = `${file}.let-go`;
    await heldElsewhere(file, marker);

    const binding = localD1(file);
    onTestFinished(() => {
      binding.close();
    });

    expect(existsSync(marker)).toBe(true);
    await expect(binding.prepare('SELECT 1 AS one').first('one')).resolves.toBe(1);
  });

  it('binds a value as D1 binds it, and refuses at `bind` what D1 refuses', async () => {
    const binding = memory();
    const each =
      'SELECT typeof(?) AS a, ? AS b, ? AS c, ? AS d, hex(?) AS e, hex(?) AS f, hex(?) AS g, ? AS h, hex(?) AS i, hex(?) AS j';
    const values = [true, false, Infinity, NaN, [1, 2], new Uint8Array([3]).buffer];
    // A view's elements, each a byte, as D1 binds `Array.from(view)`: a `DataView` none.
    const views = [
      new Uint16Array([4, 300]),
      -0,
      new Float32Array([0.5]),
      new DataView(new ArrayBuffer(2)),
    ];
    const refused = [
      [new Date(0), 'object'],
      [{}, 'object'],
      [[256], 'object'],
      [1n, 'bigint'],
      [undefined, 'undefined'],
    ] as const;

    await expect(
      binding
        .prepare(each)
        .bind(...values, ...views)
        .first(),
    ).resolves.toStrictEqual({
      a: 'real',
      b: 0,
      c: null,
      d: null,
      e: '0102',
      f: '03',
      g: '042C',
      h: 0,
      i: '00',
      j: '',
    });

    for (const [value, type] of refused) {
      expect(() => binding.prepare('SELECT ?').bind(value)).toThrow(
        `D1_TYPE_ERROR: Type '${type}' not supported for value`,
      );
    }

    // An `Error`, as D1's, and no `TypeError`.
    expect(() => binding.prepare('SELECT ?').bind(undefined)).toThrow(
      expect.objectContaining({ name: 'Error' }),
    );
  });

  it('refuses a statement bound to more or fewer values than its parameters, as D1 does', async () => {
    const binding = memory();

    await expect(binding.prepare('SELECT ? AS a, ? AS b').bind(1).first()).rejects.toThrow(
      'Wrong number of parameter bindings',
    );
    await expect(binding.prepare('SELECT ? AS a').bind(1, 2).first()).rejects.toThrow(
      'Wrong number of parameter bindings',
    );
    await expect(binding.prepare('SELECT ?2 AS a').bind(1).first()).rejects.toThrow(
      'Wrong number of parameter bindings',
    );
    await expect(
      binding.prepare('SELECT ?2 AS a, ? AS b').bind(1, 2, 3).first(),
    ).resolves.toStrictEqual({ a: 2, b: 3 });
    await expect(
      binding.prepare('SELECT ?3 AS a, ?1 AS b').bind(1, 2, 3).first(),
    ).resolves.toStrictEqual({ a: 3, b: 1 });
    await expect(
      binding.prepare('SELECT \'?\' AS a, "?" AS b, ? AS c -- ?\n/* ? */').bind(1).first(),
    ).resolves.toStrictEqual({ a: '?', b: '?', c: 1 });
    await expect(binding.prepare('SELECT :a AS a').bind(1).first()).rejects.toThrow(
      'binds no named parameter',
    );
  });

  it('answers a value as D1 answers it: a blob as its bytes, an integer past 2^53 as a number', async () => {
    const binding = memory();

    await expect(
      binding.prepare(`SELECT x'0102' AS bytes, 9007199254740993 AS big, "text" AS quoted`).first(),
    ).resolves.toStrictEqual({ big: 9_007_199_254_740_992, bytes: [1, 2], quoted: 'text' });
    // What JSON carries, as D1 answers through it.
    await expect(
      binding.prepare('SELECT 9e999 AS inf, -9e999 AS ninf, -0.0 AS nz').first(),
    ).resolves.toStrictEqual({ inf: null, ninf: null, nz: 0 });
    await expect(binding.prepare("SELECT x'03' AS bytes").raw()).resolves.toStrictEqual([[[3]]]);
  });

  it('answers a key past 2^53 as a number, of a statement before the last too, and goes on', async () => {
    const binding = memory();
    await binding.prepare('CREATE TABLE t (id integer PRIMARY KEY)').run();

    await expect(
      binding.prepare('INSERT INTO t VALUES (9007199254740993)').run(),
    ).resolves.toMatchObject({ meta: { changes: 1, last_row_id: 9_007_199_254_740_992 } });
    await expect(binding.prepare('SELECT 1 AS one').first('one')).resolves.toBe(1);
    await expect(
      binding.prepare('SELECT 9007199254740993; SELECT 2 AS two').first('two'),
    ).resolves.toBe(2);
  });

  it("holds D1's limits: of parameters, columns, a compound's terms, a pattern, a text's length", async () => {
    const binding = memory();
    const columns = Array.from({ length: 101 }, (_, at) => `c${String(at)}`).join(', ');
    // About 116 KB: past D1's 100,000 bytes of a text, each statement far below it.
    const inserts = Array.from(
      { length: 4000 },
      (_, at) => `INSERT INTO t VALUES (${String(at)});`,
    );
    await binding.prepare('CREATE TABLE t (id integer)').run();

    await expect(
      binding
        .prepare(`SELECT ${Array.from({ length: 101 }, () => '?').join(', ')}`)
        .bind(...Array.from({ length: 101 }, () => 1))
        .all(),
    ).rejects.toThrow('too many SQL variables');
    await expect(binding.prepare(`CREATE TABLE wide (${columns})`).run()).rejects.toThrow(
      'too many columns',
    );
    await expect(
      binding.prepare(Array.from({ length: 6 }, () => 'SELECT 1').join(' UNION ALL ')).all(),
    ).rejects.toThrow('too many terms in compound SELECT');
    await expect(
      binding.prepare('SELECT ? LIKE ? AS a').bind('a', 'a'.repeat(51)).first(),
    ).rejects.toThrow('LIKE or GLOB pattern too complex');
    await expect(
      binding.prepare(`SELECT max(${Array.from({ length: 128 }, () => '1').join(', ')})`).all(),
    ).rejects.toThrow('too many arguments on function');
    await expect(binding.prepare(inserts.join('\n')).run()).rejects.toThrow('statement too long');
    await expect(binding.prepare('SELECT count(*) AS n FROM t').first('n')).resolves.toBe(0);
  });

  it('refuses triggers that fire triggers past ten deep, as D1 does', async () => {
    const binding = memory();
    const tables = Array.from(
      { length: 12 },
      (_, at) => `CREATE TABLE t${String(at)} (id integer)`,
    );
    const triggers = Array.from(
      { length: 11 },
      (_, at) =>
        `CREATE TRIGGER g${String(at)} AFTER INSERT ON t${String(at)} BEGIN INSERT INTO t${String(at + 1)} VALUES (new.id); END`,
    );
    await binding.batch([...tables, ...triggers].map((statement) => binding.prepare(statement)));

    await expect(binding.prepare('INSERT INTO t1 VALUES (1)').run()).resolves.toMatchObject({
      success: true,
    });
    await expect(binding.prepare('INSERT INTO t0 VALUES (1)').run()).rejects.toThrow(
      'triggers nested too deep',
    );
  });

  it('ends a text where only white space of ASCII follows its last statement, as D1 does', async () => {
    const binding = memory();
    await binding.prepare('CREATE TABLE t (id integer)').run();

    await expect(binding.prepare('INSERT INTO t VALUES (1);\n-- seeded\n').run()).rejects.toThrow(
      'SQL code did not contain a statement',
    );
    await expect(binding.prepare('SELECT ? AS a; -- end').bind(1).first()).rejects.toThrow(
      'only the last statement can have parameters',
    );
    await expect(binding.prepare('SELECT ? AS a;\u{A0}').bind(1).first()).rejects.toThrow(
      'only the last statement can have parameters',
    );
    await expect(binding.prepare('SELECT ? AS a; \t\r\n').bind(1).first('a')).resolves.toBe(1);
    await expect(binding.prepare('SELECT count(*) AS n FROM t').first('n')).resolves.toBe(0);
  });

  it('runs no text of no statement, and leaves a blank one of a batch out, as D1 does', async () => {
    const binding = memory();

    await expect(
      binding.batch([
        binding.prepare('SELECT 1 AS a'),
        binding.prepare('\n'),
        binding.prepare('\n  -- nothing'),
        binding.prepare('SELECT 2 AS b'),
      ]),
    ).resolves.toMatchObject([{ results: [{ a: 1 }] }, { results: [{ b: 2 }] }]);
    await expect(binding.batch([])).rejects.toThrow('No SQL statements detected');
    await expect(binding.prepare('\n  -- nothing').run()).rejects.toThrow(
      'No SQL statements detected',
    );
  });

  it('refuses the column a row holds not, as D1 does, and answers none of no row', async () => {
    const binding = memory();

    await expect(binding.prepare('SELECT 1 AS one').first('two')).rejects.toThrow(
      'D1_COLUMN_NOTFOUND: Column not found (two)',
    );
    await expect(binding.prepare('SELECT 1 AS one WHERE 0').first('two')).resolves.toBeNull();
  });

  it('runs each statement of a text as one call, as D1 does, and answers the last one', async () => {
    const binding = memory();
    await binding
      .prepare('CREATE TABLE a (id integer PRIMARY KEY); CREATE TABLE b (id integer)')
      .run();
    await binding.prepare('INSERT INTO a VALUES (1); INSERT INTO a VALUES (2);').run();

    await expect(
      binding.prepare('SELECT 0 AS id; SELECT id FROM a ORDER BY id DESC').all(),
    ).resolves.toMatchObject({ results: [{ id: 2 }, { id: 1 }] });
    await expect(binding.prepare('SELECT 1; SELECT ? AS id').bind(7).first('id')).resolves.toBe(7);
    await expect(
      binding.prepare('INSERT INTO b VALUES (3); INSERT INTO a VALUES (1)').run(),
    ).rejects.toThrow('UNIQUE constraint failed');
    await expect(binding.prepare('SELECT count(*) AS n FROM b').first('n')).resolves.toBe(0);
    await expect(binding.prepare('SELECT ?; SELECT 1').bind(1).run()).rejects.toThrow(
      'last statement',
    );
  });

  it('waits for another process in a batch that reads before it writes, as in one write', async () => {
    const file = path.join(directory(), 'd1.sqlite');
    const marker = `${file}.let-go`;
    const binding = localD1(file);
    onTestFinished(() => {
      binding.close();
    });
    await binding.prepare('CREATE TABLE a (id integer)').run();
    await heldElsewhere(file, marker);

    await binding.batch([
      binding.prepare('SELECT count(*) FROM a'),
      binding.prepare('INSERT INTO a VALUES (1)'),
    ]);

    expect(existsSync(marker)).toBe(true);
  });

  it('refuses a statement of a transaction, as D1 does, and runs a batch whole or not at all', async () => {
    const { orm } = await opened();
    await orm.run(sql.raw(DDL));

    await expect(
      orm.transaction(async (tx) => {
        await tx.insert(tasks).values({ id: 'a', title: 'one' });
      }),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining('one batch') } });
    await expect(
      orm.batch([
        orm.insert(tasks).values({ id: 'b', title: 'two' }),
        orm.insert(tasks).values({ id: 'b', title: 'the same key' }),
      ]),
    ).rejects.toThrow(/UNIQUE/u);

    await expect(orm.select().from(tasks)).resolves.toStrictEqual([]);
  });

  it("says what it refuses in D1's words, which a state's write is told apart by", async () => {
    const { orm } = await opened();
    await orm.run(sql.raw(`${DDL.slice(0, -1)}, CHECK (length(title) <= 3))`));
    await orm.insert(tasks).values({ id: 'a', title: 'one' });

    await expect(orm.insert(tasks).values({ id: 'b', title: 'long' })).rejects.toMatchObject({
      cause: {
        message: expect.stringMatching(
          /^D1_ERROR: CHECK constraint failed: .*: SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_CHECK\)$/u,
        ),
      },
    });
    await expect(orm.insert(tasks).values({ id: 'a', title: 'two' })).rejects.toMatchObject({
      cause: { message: expect.stringContaining('UNIQUE constraint failed: tasks.id') },
    });
  });

  it('keeps foreign keys, as D1 does', async () => {
    const { orm } = await opened();
    await orm.run(sql.raw(DDL));
    await orm.run(
      sql.raw('CREATE TABLE notes (id text PRIMARY KEY, task text REFERENCES tasks (id))'),
    );

    // A call is a transaction of its own, as on D1: of no effect there.
    await orm.run(sql`PRAGMA foreign_keys = OFF`);

    await expect(
      orm.run(sql`INSERT INTO notes VALUES ('n', 'no such task')`),
    ).rejects.toMatchObject({
      cause: { message: expect.stringContaining('SQLITE_CONSTRAINT_FOREIGNKEY') },
    });
  });

  it("runs the application's migrations of SQLite", async () => {
    const { db, orm } = await opened();

    await hostOf(db)?.migrate(migrationsOf(`${DDL};`));

    await expect(orm.select().from(tasks)).resolves.toStrictEqual([]);
  });

  it('runs a migration whose last chunk is blank, as D1 does', async () => {
    const { db, orm } = await opened();

    await hostOf(db)?.migrate(migrationsOf(`${DDL};\n--> statement-breakpoint\n`));

    await expect(orm.select().from(tasks)).resolves.toStrictEqual([]);
  });

  it('runs each statement of a migration of no breakpoint', async () => {
    const { db, orm } = await opened();
    const notes = 'CREATE TABLE notes (id text PRIMARY KEY)';

    await hostOf(db)?.migrate(migrationsOf(`${DDL};\n${notes};`));

    await expect(
      orm.all(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('notes', 'tasks') ORDER BY name`,
      ),
    ).resolves.toStrictEqual([{ name: 'notes' }, { name: 'tasks' }]);
  });

  it('runs the seed once of a database, however often it starts', async () => {
    const file = path.join(directory(), 'd1.sqlite');
    const first = vi.fn<() => Promise<void>>();
    const once = await opened(file);
    await hostOf(once.db)?.seed(first);
    await hostOf(once.db)?.close();

    const again = await opened(file);
    await hostOf(again.db)?.seed(first);

    expect(first).toHaveBeenCalledTimes(1);
  });

  it('runs a seed that failed again, as nothing says it ran', async () => {
    const { db } = await opened();
    const first = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('Not yet.'));

    await expect(hostOf(db)?.seed(first)).rejects.toThrow('Not yet.');

    await hostOf(db)?.seed(first);
    await hostOf(db)?.seed(first);

    expect(first).toHaveBeenCalledTimes(2);
  });

  describe('a server operation that writes through the file', () => {
    it('answers its own refusal after an update that matched no row', async () => {
      const operate = await operating(async (orm) => {
        await orm.update(tasks).set({ title: 'two' }).where(eq(tasks.id, 'absent'));
        refuse('NO_TASK');
      });

      await expect(operate()).resolves.toMatchObject({ code: 'NO_TASK', status: 422 });
    });

    it('answers a failure after an update that matched a row', async () => {
      const operate = await operating(async (orm) => {
        await orm.update(tasks).set({ title: 'two' }).where(eq(tasks.id, 'a'));
        refuse('NO_TASK');
      });

      await expect(operate()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    });

    it('answers its own refusal after an update with returning that matched no row', async () => {
      const operate = await operating(async (orm) => {
        await orm.update(tasks).set({ title: 'two' }).where(eq(tasks.id, 'absent')).returning();
        refuse('NO_TASK');
      });

      await expect(operate()).resolves.toMatchObject({ code: 'NO_TASK', status: 422 });
    });

    it('answers a failure after an update with returning that matched a row', async () => {
      const operate = await operating(async (orm) => {
        await orm.update(tasks).set({ title: 'two' }).where(eq(tasks.id, 'a')).returning();
        refuse('NO_TASK');
      });

      await expect(operate()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    });

    it('answers a failure after a duplicate insert a table drops, as a trigger of the application’s ran', async () => {
      const operate = await operating(
        async (orm) => {
          await orm.insert(tasks).values({ id: 'a', title: 'again' }).returning();
          refuse('NO_TASK');
        },
        { ddl: IGNORING },
      );

      await expect(operate()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    });

    it('answers a resend unsettled after a duplicate insert a table drops, and runs once', async () => {
      let runs = 0;
      const operate = await operating(
        async (orm) => {
          runs += 1;
          await orm.insert(tasks).values({ id: 'a', title: 'again' }).returning();
          await new Promise((resolve) => {
            setTimeout(resolve, SLOW.pastMs);
          });
        },
        { ddl: IGNORING, timeoutMs: SLOW.timeoutMs },
      );
      const id = crypto.randomUUID();

      const first = await operate(id);
      const again = await operate(id);

      expect(first).toMatchObject({ code: 'OPERATION_UNSETTLED', status: 500 });
      expect(again).toMatchObject({ code: 'OPERATION_UNSETTLED', status: 500 });
      expect(runs).toBe(1);
    });

    it('answers a failure after a delete a trigger of the application’s made a row short of', async () => {
      const operate = await operating(
        async (orm) => {
          await orm.delete(tasks).where(eq(tasks.id, 'a')).returning();
          refuse('NO_TASK');
        },
        { ddl: DELETING },
      );

      await expect(operate()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    });

    it('answers its own refusal after an update that matched no row, of a trigger that runs after', async () => {
      const operate = await operating(
        async (orm) => {
          await orm.update(tasks).set({ title: 'two' }).where(eq(tasks.id, 'absent')).returning();
          refuse('NO_TASK');
        },
        { ddl: AFTER_UPDATE },
      );

      await expect(operate()).resolves.toMatchObject({ code: 'NO_TASK', status: 422 });
    });

    it('answers a failure after an insert that did nothing on a key it holds', async () => {
      const operate = await operating(async (orm) => {
        await orm
          .insert(tasks)
          .values({ id: 'a', title: 'again' })
          .onConflictDoNothing()
          .returning();
        refuse('NO_TASK');
      });

      await expect(operate()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    });

    it('answers a failure after an update of a key a trigger on the log deleted the row of', async () => {
      const operate = await operating(
        async (orm) => {
          await orm.update(tasks).set({ id: 'b' }).where(eq(tasks.id, 'a')).returning();
          refuse('NO_TASK');
        },
        { after: ON_LOG, ddl: TWO_ROWS },
      );

      await expect(operate()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    });

    it('answers a resend unsettled after that update, and runs once', async () => {
      let runs = 0;
      const operate = await operating(
        async (orm) => {
          runs += 1;
          await orm.update(tasks).set({ id: 'b' }).where(eq(tasks.id, 'a')).returning();
          await new Promise((resolve) => {
            setTimeout(resolve, SLOW.pastMs);
          });
        },
        { after: ON_LOG, ddl: TWO_ROWS, timeoutMs: SLOW.timeoutMs },
      );
      const id = crypto.randomUUID();

      const first = await operate(id);
      const again = await operate(id);

      expect(first).toMatchObject({ code: 'OPERATION_UNSETTLED', status: 500 });
      expect(again).toMatchObject({ code: 'OPERATION_UNSETTLED', status: 500 });
      expect(runs).toBe(1);
    });

    it('answers a failure after a statement that writes uncounted through pragma_optimize', async () => {
      const operate = await operating(async (orm) => {
        await orm.run(sql.raw('WITH replace AS (SELECT 1) SELECT * FROM pragma_optimize(65538)'));
        refuse('NO_TASK');
      });

      await expect(operate()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    });

    it('answers a failure after an insert a temporary trigger drops', async () => {
      const operate = await operating(
        async (orm) => {
          await orm.insert(tasks).values({ id: 'c', title: 'three' }).returning();
          refuse('NO_TASK');
        },
        { after: TEMP_TRIGGER, ddl: AUDITED },
      );

      await expect(operate()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    });

    it('answers a failure after a duplicate insert a temporary table of its name drops', async () => {
      const operate = await operating(
        async (orm) => {
          await orm.insert(tasks).values({ id: 'a', title: 'again' }).returning();
          refuse('NO_TASK');
        },
        { after: TEMP_TABLE, ddl: AUDITED },
      );

      await expect(operate()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    });

    it('answers a failure after an insert whose trigger wrote statistics uncounted', async () => {
      const set = await operating(
        async (orm) => {
          await orm.insert(tasks).values({ id: 'n', title: 'new' });
          refuse('NO_TASK');
        },
        { ddl: PRAGMA_TRIGGER },
      );

      await expect(set()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
      await expect(
        set.orm.all(sql`SELECT count(*) AS n FROM sqlite_stat1`),
      ).resolves.not.toStrictEqual([{ n: 0 }]);
    });

    it('answers a failure after an insert of no row that read a pragma view', async () => {
      const set = await operating(
        async (orm) => {
          await orm.run(sql`INSERT INTO audit SELECT id FROM opt`);
          refuse('NO_TASK');
        },
        { ddl: PRAGMA_VIEW },
      );

      await expect(set()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
      await expect(
        set.orm.all(sql`SELECT count(*) AS n FROM sqlite_stat1`),
      ).resolves.not.toStrictEqual([{ n: 0 }]);
    });

    it('answers its own refusal after a zero-count update, of an AFTER trigger', async () => {
      const set = await operating(
        async (orm) => {
          await orm.update(tasks).set({ title: 'two' }).where(eq(tasks.id, 'absent'));
          refuse('NO_TASK');
        },
        { ddl: AFTER_UPDATE },
      );

      await expect(set()).resolves.toMatchObject({ code: 'NO_TASK', status: 422 });
    });

    it('answers its own refusal after an update returning a key that matched no row', async () => {
      const set = await operating(async (orm) => {
        await orm
          .update(tasks)
          .set({ title: 'x' })
          .where(eq(tasks.id, 'absent'))
          .returning({ id: tasks.id });
        refuse('NO_TASK');
      });

      await expect(set()).resolves.toMatchObject({ code: 'NO_TASK', status: 422 });
    });

    it('answers a failure after an update that returns through RAISE(IGNORE)', async () => {
      const set = await operating(async (orm) => {
        await orm
          .update(tasks)
          .set({ title: 'two' })
          .where(eq(tasks.id, 'a'))
          .returning({ id: tasks.id, gone: sql`raise(ignore)` });
        refuse('NO_TASK');
      });

      await expect(set()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    });

    it('answers a failure after an update that returns through a view that raises', async () => {
      const set = await operating(
        async (orm) => {
          await orm
            .update(tasks)
            .set({ title: 'two' })
            .where(eq(tasks.id, 'a'))
            .returning({ id: tasks.id, gone: sql`(select x from quiet)` });
          refuse('NO_TASK');
        },
        { ddl: QUIET_VIEW },
      );

      await expect(set()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    });

    it('answers a resend unsettled after an insert that raises, and runs once', async () => {
      let runs = 0;
      const set = await operating(
        async (orm) => {
          runs += 1;
          await orm
            .insert(tasks)
            .values({ id: 'n', title: 'new' })
            .returning({ id: tasks.id, gone: sql`raise(ignore)` });
          await new Promise((resolve) => {
            setTimeout(resolve, SLOW.pastMs);
          });
        },
        { timeoutMs: SLOW.timeoutMs },
      );
      const id = crypto.randomUUID();

      const first = await set(id);
      const again = await set(id);

      expect(first).toMatchObject({ code: 'OPERATION_UNSETTLED', status: 500 });
      expect(again).toMatchObject({ code: 'OPERATION_UNSETTLED', status: 500 });
      expect(runs).toBe(1);
    });

    it('answers a failure after a delete of a table whose content is a pragma', async () => {
      const set = await operating(
        async (orm) => {
          await orm.run(sql`DELETE FROM ft WHERE rowid = 65538`);
          refuse('NO_TASK');
        },
        { ddl: PRAGMA_CONTENT },
      );

      await expect(set()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
      await expect(
        set.orm.all(sql`SELECT count(*) AS n FROM sqlite_stat1`),
      ).resolves.not.toStrictEqual([{ n: 0 }]);
    });

    it('answers a failure after a delete with returning that read that table', async () => {
      const set = await operating(
        async (orm) => {
          await orm
            .delete(tasks)
            .where(sql`id = (SELECT optimize FROM ft WHERE rowid = 65538)`)
            .returning({ id: tasks.id });
          refuse('NO_TASK');
        },
        { ddl: PRAGMA_CONTENT },
      );

      await expect(set()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
      await expect(
        set.orm.all(sql`SELECT count(*) AS n FROM sqlite_stat1`),
      ).resolves.not.toStrictEqual([{ n: 0 }]);
    });

    it('answers its own refusal after a zero-count update, of FTS5 of plain content', async () => {
      const set = await operating(
        async (orm) => {
          await orm.update(tasks).set({ title: 'x' }).where(eq(tasks.id, 'absent'));
          refuse('NO_TASK');
        },
        { ddl: PLAIN_CONTENT },
      );

      await expect(set()).resolves.toMatchObject({ code: 'NO_TASK', status: 422 });
    });

    it.each(["ATTACH ':memory:' AS aux", 'DETACH aux', "  /* c */ attach ':memory:' AS aux"])(
      'refuses %s as D1 does',
      async (statement) => {
        const binding = memory();

        await expect(binding.prepare(statement).run()).rejects.toThrow(
          'D1_ERROR: not authorized: SQLITE_AUTH',
        );
        await expect(binding.batch([binding.prepare(statement)])).rejects.toThrow('SQLITE_AUTH');
      },
    );

    it('answers a failure after the FTS5 delete, with case_sensitive_like on', async () => {
      const set = await operating(
        async (orm) => {
          await orm.run(sql`DELETE FROM ft WHERE rowid = 65538`);
          refuse('NO_TASK');
        },
        { ddl: PRAGMA_CONTENT },
      );
      await set.orm.run(sql`PRAGMA case_sensitive_like = ON`);

      await expect(set()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
      await expect(
        set.orm.all(sql`SELECT count(*) AS n FROM sqlite_stat1`),
      ).resolves.not.toStrictEqual([{ n: 0 }]);
    });

    it('answers its own refusal, of a generated column and a pragma name', async () => {
      const set = await operating(
        async (orm) => {
          await orm.update(tasks).set({ title: 'x' }).where(eq(tasks.id, 'absent'));
          refuse('NO_TASK');
        },
        { ddl: GENERATED },
      );

      await expect(set()).resolves.toMatchObject({ code: 'NO_TASK', status: 422 });
    });

    it('answers a failure after an insert a log-shaped trigger joined a raising view', async () => {
      const set = await operating(
        async (orm) => {
          await orm.insert(tasks).values({ id: 'n', title: 'new' }).returning();
          refuse('NO_TASK');
        },
        { after: JOINING },
      );

      await expect(set()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    });

    it('reads the log’s real triggers as its own, and the same with a join as not', async () => {
      const set = await operating(async () => {
        await Promise.resolve();
      });
      const rows = await set.orm.all<Record<string, unknown>>(
        sql`SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' AND name LIKE '_rsd_%'`,
      );
      const joined = rows.map((row) => {
        return {
          ...row,
          sql: `${String(row['sql']).slice(0, -'; END'.length)} JOIN x; END`,
        };
      });

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((row) => logTrigger(row))).toStrictEqual(rows.map(() => true));
      expect(joined.map((row) => logTrigger(row))).toStrictEqual(rows.map(() => false));
    });

    it.each(READING_QUIET)(
      'answers a failure after an insert a log-shaped trigger read a raising view by %s',
      async (_what, body) => {
        const set = await operating(
          async (orm) => {
            await orm.insert(tasks).values({ id: 'n', title: 'new' }).returning();
            refuse('NO_TASK');
          },
          {
            after: [
              'CREATE VIEW quiet AS SELECT raise(ignore) AS x',
              `CREATE TRIGGER "_rsd_00_replaced_insert" BEFORE INSERT ON "tasks" BEGIN INSERT INTO _rs_changes (tbl, id, before, after, at) ${body}; END`,
            ],
          },
        );

        await expect(set()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
      },
    );

    it('answers a failure after an insert whose log row a check on the log raised on', async () => {
      const set = await operating(
        async (orm) => {
          await orm.insert(tasks).values({ id: 'n', title: 'new' }).returning();
          refuse('NO_TASK');
        },
        { after: RAISING_LOG },
      );

      await expect(set()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    });

    it('answers a failure after an update whose key a log upsert cascaded away', async () => {
      const set = await operating(
        async (orm) => {
          await orm.update(cascaded).set({ y: 3 }).where(eq(cascaded.x, 1)).returning();
          refuse('NO_TASK');
        },
        { after: CASCADING },
      );

      await expect(set()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    });

    it('answers a failure after an update whose row a replacing log deleted', async () => {
      const set = await operating(
        async (orm) => {
          await orm.update(cascaded).set({ y: 3 }).where(eq(cascaded.x, 1)).returning();
          refuse('NO_TASK');
        },
        { after: REPLACING_LOG },
      );

      await expect(set()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    });

    it('answers a failure after an update an AFTER trigger raised on', async () => {
      const set = await operating(
        async (orm) => {
          await orm.update(tasks).set({ title: 'two' }).where(eq(tasks.id, 'a')).returning();
          refuse('NO_TASK');
        },
        { ddl: AFTER_RAISE },
      );

      await expect(set()).resolves.toMatchObject({ code: 'OPERATION_FAILED', status: 500 });
    });
  });
});
