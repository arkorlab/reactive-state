import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalFollower } from '../../src/authority/external.ts';
import { database, definitionOf } from '../../src/server/schema.ts';
import { followDrizzle } from '../../src/sql/index.ts';
import { bindingValue } from './d1-drizzle-binding.ts';
import { faultsOf, rendered } from './d1-drizzle-render.ts';

/**
 * What the database holds of a Drizzle schema's tables in D1 that the triggers do not answer for,
 * run in workerd: a unique column `NOT NULL` of a default, a table made again of the same text, the
 * triggers of before; and the binding outside a render, of a batch of statements of its own and
 * D1's, and of a session.
 */

const badges = sqliteTable(
  'badges',
  {
    id: integer().primaryKey(),
    owner: text().notNull(),
    code: text().notNull().default('x').unique(),
  },
  (table) => [index('badges_owner').on(table.owner)],
);
const schema = { badges };
/** A table of no unique index but its rowid's, whose inserts are of their rows. */
const plain = sqliteTable(
  'plain',
  {
    id: integer().primaryKey(),
    owner: text(),
  },
  (table) => [index('plain_owner').on(table.owner)],
);
/** The invitations of teams: one pending of an account in a team at most. */
const invites = sqliteTable(
  'invites',
  {
    id: text().primaryKey(),
    team: text().notNull(),
    account: text().notNull(),
    status: text().notNull(),
  },
  (table) => {
    return [
      uniqueIndex('invites_pending')
        .on(table.account, table.team)
        .where(sql`${table.status} = 'pending'`),
      index('invites_team').on(table.team),
    ];
  },
);
/** The same table, of the same database, as a schema that declares its index of all of its rows. */
const invitesWhole = sqliteTable(
  'invites',
  {
    id: text().primaryKey(),
    team: text().notNull(),
    account: text().notNull(),
    status: text().notNull(),
  },
  (table) => {
    return [
      uniqueIndex('invites_pending').on(table.account, table.team),
      index('invites_team').on(table.team),
    ];
  },
);
const follow = followDrizzle(schema);
const tables = definitionOf(database(follow.tables)).tables;
const db = env.REACTIVE_D1;

/** `invites` made anew of two invitations of one account in `t1`, the second cancelled. */
const INVITES = [
  'DROP TABLE IF EXISTS invites',
  'CREATE TABLE invites (id TEXT PRIMARY KEY, team TEXT NOT NULL, account TEXT NOT NULL, status TEXT NOT NULL)',
  "CREATE UNIQUE INDEX invites_pending ON invites (account, team) WHERE status = 'pending'",
  'CREATE INDEX invites_team ON invites (team)',
  "INSERT INTO invites VALUES ('x1', 't1', 'a1', 'pending'), ('x2', 't1', 'a1', 'canceled')",
] as const;

/**
 * A follow of `invites` as `table` declares it, the table made anew by `statements` and its log,
 * and a follower of it.
 */
async function invitations(
  table: typeof invites | typeof invitesWhole,
  statements: readonly string[] = INVITES,
) {
  const own = followDrizzle({ invites: table });
  await db.batch([...statements, ...own.captureSql()].map((statement) => db.prepare(statement)));
  const follower = new ExternalFollower(own.store(db), definitionOf(database(own.tables)).tables);
  return { follower, orm: drizzle(own.client(db), { schema: { invites: table } }) };
}

/** A follower of the store's log, read to its head. */
async function following() {
  const follower = new ExternalFollower(follow.store(db), tables);
  await follower.changed();
  return follower;
}

/** `db`, of a D1 that fails the first `PRAGMA index_list` it is asked, as a passing failure. */
function pragmaFailingOnce(): D1Database {
  let failing = 1;
  return new Proxy(db, {
    get: (target, key) => {
      if (key !== 'prepare') return bindingValue(target, key);
      return (statement: string) => {
        if (!statement.startsWith('PRAGMA index_list') || failing <= 0) {
          return target.prepare(statement);
        }
        failing -= 1;
        return target.prepare('SELECT * FROM "refused PRAGMA"');
      };
    },
  });
}

/** The statements that make `badges` anew, of its rows `owners`. */
function made(...owners: readonly string[]): readonly string[] {
  return [
    'DROP TABLE IF EXISTS badges',
    "CREATE TABLE badges (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, code TEXT NOT NULL DEFAULT 'x' UNIQUE)",
    'CREATE INDEX IF NOT EXISTS badges_owner ON badges (owner)',
    ...owners.map(
      (owner, at) => `INSERT INTO badges VALUES (${String(at + 1)}, '${owner}', '${owner}-code')`,
    ),
  ];
}

describe("what a D1 database holds of a Drizzle schema's tables", () => {
  beforeEach(async () => {
    await db.batch(
      [
        'DROP TABLE IF EXISTS _rs_changes',
        'DROP TABLE IF EXISTS _rs_meta',
        'DROP TABLE IF EXISTS codes',
        'DROP TABLE IF EXISTS pairs',
        'DROP TABLE IF EXISTS plain',
        'DROP TABLE IF EXISTS shadowed',
        'DROP TABLE IF EXISTS norms',
        'DROP TABLE IF EXISTS gens',
        'DROP VIEW IF EXISTS app_raising',
        'DROP TRIGGER IF EXISTS app_log',
        'DROP TABLE IF EXISTS sets',
        'DROP TABLE IF EXISTS posts',
        'DROP TABLE IF EXISTS invites',
        ...made(),
        "INSERT INTO badges VALUES (1, 'p1', 'x')",
        ...follow.captureSql(),
      ].map((statement) => db.prepare(statement)),
    );
  });

  it('renders a read again for a row a REPLACE deletes by a default of a NULL', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const dependencies = await rendered(() =>
      orm.select().from(badges).where(eq(badges.owner, 'p1')),
    );
    const follower = await following();

    // `code` is NULL as the trigger before the insert reads it, and `'x'` as SQLite writes it.
    await db
      .prepare("INSERT OR REPLACE INTO badges (id, owner, code) VALUES (2, 'p2', NULL)")
      .run();
    const { results } = await db.prepare('SELECT id FROM badges').all();

    expect(results).toStrictEqual([{ id: 2 }]);
    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('renders a read again for a table made again of the same text', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const dependencies = await rendered(() =>
      orm.select().from(badges).where(eq(badges.owner, 'p1')),
    );
    const follower = await following();

    await db.batch(
      [...made('p1'), ...follow.captureSql()].map((statement) => db.prepare(statement)),
    );

    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('renders a read again for an insert of a table whose rowid a generated column shadows', async () => {
    const shadowed = sqliteTable(
      'shadowed',
      { id: integer().primaryKey(), owner: text() },
      (table) => [index('shadowed_owner').on(table.owner)],
    );
    const own = followDrizzle({ shadowed });
    await db.batch(
      [
        // PRAGMA table_info omits this generated shadow. SQLite 3.54 forbids adding a rowid alias
        // with ALTER TABLE, so declare it when the table is created.
        'CREATE TABLE shadowed (id INTEGER PRIMARY KEY, owner TEXT, rowid TEXT GENERATED ALWAYS AS (owner) VIRTUAL)',
        'CREATE INDEX shadowed_owner ON shadowed (owner)',
        "INSERT INTO shadowed VALUES (1, 'p1')",
        ...own.captureSql(),
      ].map((statement) => db.prepare(statement)),
    );

    await expect(
      db.prepare('SELECT rowid FROM shadowed WHERE id = 1').first('rowid'),
    ).resolves.toBe('p1');

    const orm = drizzle(own.client(db), { schema: { shadowed } });
    const dependencies = await rendered(() =>
      orm.select({ id: shadowed.id }).from(shadowed).where(eq(shadowed.owner, 'p1')),
    );
    const follower = new ExternalFollower(own.store(db), definitionOf(database(own.tables)).tables);
    await follower.changed();

    await db.prepare("INSERT INTO shadowed (id, owner) VALUES (2, 'p2')").run();

    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('renders a read again for a row an update meets by a unique index of its own collation', async () => {
    const codes = sqliteTable('codes', { id: integer().primaryKey(), code: text().unique() });
    const own = followDrizzle({ codes });
    await db.batch(
      [
        'DROP TABLE IF EXISTS codes',
        // The column finds 'A' and 'a' one; its unique index finds them two.
        'CREATE TABLE codes (id INTEGER PRIMARY KEY, code TEXT COLLATE NOCASE)',
        'CREATE UNIQUE INDEX codes_code ON codes (code COLLATE BINARY)',
        "INSERT INTO codes VALUES (1, 'A'), (2, 'a')",
        ...own.captureSql(),
      ].map((statement) => db.prepare(statement)),
    );
    const orm = drizzle(own.client(db), { schema: { codes } });
    const dependencies = await rendered(() => orm.select().from(codes).where(eq(codes.id, 1)));
    const follower = new ExternalFollower(own.store(db), definitionOf(database(own.tables)).tables);
    await follower.changed();

    await db.prepare("UPDATE OR REPLACE codes SET code = 'A' WHERE id = 2").run();
    const { results } = await db.prepare('SELECT id FROM codes').all();

    expect(results).toStrictEqual([{ id: 2 }]);
    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('renders a read again for a row an update meets by a unique index wider than declared', async () => {
    const pairs = sqliteTable(
      'pairs',
      { id: integer().primaryKey(), a: text().unique(), b: text(), owner: integer() },
      (table) => [index('pairs_owner').on(table.owner)],
    );
    const own = followDrizzle({ pairs });
    await db.batch(
      [
        // `a` alone is declared unique; the database's index is of `a` and `b`.
        'CREATE TABLE pairs (id INTEGER PRIMARY KEY, a TEXT, b TEXT, owner INTEGER)',
        'CREATE UNIQUE INDEX pairs_a_b ON pairs (a, b)',
        'CREATE INDEX pairs_owner ON pairs (owner)',
        "INSERT INTO pairs VALUES (1, 'x', 'p', 1), (2, 'x', 'q', 2)",
        ...own.captureSql(),
      ].map((statement) => db.prepare(statement)),
    );
    const orm = drizzle(own.client(db), { schema: { pairs } });
    const dependencies = await rendered(() => orm.select().from(pairs).where(eq(pairs.owner, 1)));
    const follower = new ExternalFollower(own.store(db), definitionOf(database(own.tables)).tables);
    await follower.changed();

    // Of `b` alone, which the trigger before the update reads not of the set `a`.
    await db.prepare("UPDATE OR REPLACE pairs SET b = 'p' WHERE id = 2").run();
    const { results } = await db.prepare('SELECT id FROM pairs').all();

    expect(results).toStrictEqual([{ id: 2 }]);
    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('asks D1 for the unique indexes again a while after it answered none', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // The warning of a D1 that answered no `PRAGMA`, kept out of the output.
    });
    const own = followDrizzle({ plain });
    await db.batch(
      [
        'CREATE TABLE plain (id INTEGER PRIMARY KEY, owner TEXT)',
        'CREATE INDEX plain_owner ON plain (owner)',
        "INSERT INTO plain VALUES (1, 'p1')",
        ...own.captureSql(),
      ].map((statement) => db.prepare(statement)),
    );
    const orm = drizzle(own.client(db), { schema: { plain } });
    const dependencies = await rendered(() =>
      orm.select().from(plain).where(eq(plain.owner, 'p1')),
    );
    const follower = new ExternalFollower(
      own.store(pragmaFailingOnce()),
      definitionOf(database(own.tables)).tables,
    );
    // Of no answer, each insert is of the table; a minute after, the indexes are asked again.
    await follower.changed();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    await follower.changed();
    clock.mockRestore();
    warned.mockRestore();

    await db.prepare("INSERT INTO plain VALUES (2, 'p2')").run();

    expect(dependencies.changedBy(await follower.changed())).toBe(false);
  });

  it('renders every read again while a table has triggers other than captureSql makes', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
      // The warning of triggers of before, kept out of the output.
    });
    const orm = drizzle(follow.client(db), { schema });
    const dependencies = await rendered(() =>
      orm.select().from(badges).where(eq(badges.owner, 'p1')),
    );
    // A trigger of the table's (`_rsd_<hex of "badges">_update`), dropped as a migration that
    // makes the table again drops them all.
    await db.prepare('DROP TRIGGER "_rsd_626164676573_update"').run();
    const follower = await following();

    await db.prepare("UPDATE badges SET owner = 'p2' WHERE id = 1").run();
    // The next read of the schema, a second after, is of another epoch.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1100);
    const changed = await follower.changed();
    clock.mockRestore();

    expect(dependencies.changedBy(changed)).toBe(true);
    expect(warned).toHaveBeenCalledWith(expect.stringMatching(/badges are not those/u));

    warned.mockRestore();
  });

  it('runs a batch of its own statements and D1’s outside a render', async () => {
    const tracked = follow.client(db);

    const answers = await tracked.batch([
      tracked.prepare('SELECT 1 AS one'),
      db.prepare('SELECT 2 AS two'),
    ]);

    expect(answers.map((answer) => answer.results)).toStrictEqual([[{ one: 1 }], [{ two: 2 }]]);
  });

  it('refuses in a render a session opened outside one, and its statements', async () => {
    const session = follow.client(db).withSession('first-primary');
    // Prepared, and bound, outside the render: run in it.
    const prepared = session.prepare('SELECT owner FROM badges');
    const bound = session.prepare('SELECT owner FROM badges WHERE id = ?').bind(1);

    await expect(rendered(() => session.prepare('SELECT owner FROM badges').all())).rejects.toThrow(
      /runs no D1 `prepare`/u,
    );
    await expect(rendered(() => prepared.all())).rejects.toThrow(/runs no D1 `all`/u);
    await expect(rendered(() => bound.first())).rejects.toThrow(/runs no D1 `first`/u);
    await expect(session.prepare('SELECT 1 AS one').all()).resolves.toMatchObject({
      results: [{ one: 1 }],
    });
    await expect(session.batch([prepared, bound])).resolves.toMatchObject([
      { results: [{ owner: 'p1' }] },
      { results: [{ owner: 'p1' }] },
    ]);
  });

  it('renders a read again for a row a REPLACE meets by a generated unique column of a default', async () => {
    const norms = sqliteTable('norms', {
      id: integer().primaryKey(),
      code: text().notNull().default('x'),
      norm: text().unique(),
    });
    const own = followDrizzle({ norms });
    await db.batch(
      [
        // `norm` is of `code`, which a `REPLACE` of a `NULL` writes its default in place of.
        "CREATE TABLE norms (id INTEGER PRIMARY KEY, code TEXT NOT NULL DEFAULT 'x', norm TEXT GENERATED ALWAYS AS (code) VIRTUAL UNIQUE)",
        "INSERT INTO norms (id, code) VALUES (1, 'x')",
        ...own.captureSql(),
      ].map((statement) => db.prepare(statement)),
    );
    const orm = drizzle(own.client(db), { schema: { norms } });
    const dependencies = await rendered(() =>
      orm.select({ id: norms.id }).from(norms).where(eq(norms.id, 1)),
    );
    const follower = new ExternalFollower(own.store(db), definitionOf(database(own.tables)).tables);
    await follower.changed();

    await db.prepare('INSERT OR REPLACE INTO norms (id, code) VALUES (2, NULL)').run();
    const { results } = await db.prepare('SELECT id FROM norms').all();

    expect(results).toStrictEqual([{ id: 2 }]);
    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it.each([
    ["SELECT RAISE(IGNORE) WHERE NEW.owner = 'p1'"],
    ["SELECT RAISE/**/(IGNORE) WHERE NEW.owner = 'p1'"],
    // A view's `RAISE`, which the trigger's text names not.
    ["SELECT r FROM app_raising WHERE NEW.owner = 'p1'"],
  ])(
    'renders every read again while a trigger of its own made after the log runs %s',
    async (raise) => {
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
        // The warning of a trigger that fires before the log's, kept out of the output.
      });
      const own = followDrizzle({ plain });
      await db.batch(
        [
          'CREATE TABLE plain (id INTEGER PRIMARY KEY, owner TEXT)',
          'CREATE INDEX plain_owner ON plain (owner)',
          ...own.captureSql(),
          // Newer than the log's, so fired first, and skipping them of the rows it ignores.
          'CREATE VIEW app_raising AS SELECT RAISE(IGNORE) AS r',
          `CREATE TRIGGER app_drafts AFTER INSERT ON plain BEGIN ${raise}; END`,
        ].map((statement) => db.prepare(statement)),
      );
      const orm = drizzle(own.client(db), { schema: { plain } });
      const dependencies = await rendered(() =>
        orm.select().from(plain).where(eq(plain.owner, 'p1')),
      );
      const follower = new ExternalFollower(
        own.store(db),
        definitionOf(database(own.tables)).tables,
      );
      await follower.changed();

      await db.prepare("INSERT INTO plain VALUES (1, 'p1')").run();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1100);
      const changed = await follower.changed();
      clock.mockRestore();
      warned.mockRestore();

      expect(dependencies.changedBy(changed)).toBe(true);
    },
  );

  it('renders a read again for a row a REPLACE meets by a generated unique column of the rowid', async () => {
    const gens = sqliteTable('gens', { id: integer().primaryKey(), norm: integer().unique() });
    const own = followDrizzle({ gens });
    await db.batch(
      [
        // `norm` is of the rowid SQLite assigns, `-1` as the trigger before the insert reads it.
        'CREATE TABLE gens (id INTEGER PRIMARY KEY, norm INTEGER GENERATED ALWAYS AS (id % 2) VIRTUAL UNIQUE)',
        'INSERT INTO gens (id) VALUES (1), (2)',
        ...own.captureSql(),
      ].map((statement) => db.prepare(statement)),
    );
    const orm = drizzle(own.client(db), { schema: { gens } });
    const dependencies = await rendered(() =>
      orm.select({ id: gens.id }).from(gens).where(eq(gens.id, 1)),
    );
    const follower = new ExternalFollower(own.store(db), definitionOf(database(own.tables)).tables);
    await follower.changed();

    await db.prepare('INSERT OR REPLACE INTO gens (id) VALUES (NULL)').run();
    const { results } = await db.prepare('SELECT id FROM gens ORDER BY id').all();

    expect(results).toStrictEqual([{ id: 2 }, { id: 3 }]);
    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('renders a read again for a row an update meets by a column a trigger of its own set', async () => {
    const sets = sqliteTable(
      'sets',
      { id: integer().primaryKey(), a: text(), b: text() },
      (table) => [uniqueIndex('sets_a_b').on(table.a, table.b)],
    );
    const own = followDrizzle({ sets });
    await db.batch(
      [
        'CREATE TABLE sets (id INTEGER PRIMARY KEY, a TEXT, b TEXT)',
        'CREATE UNIQUE INDEX sets_a_b ON sets (a, b)',
        "INSERT INTO sets VALUES (1, 'x', 'p'), (2, 'y', 'q')",
        // Older than the log's, as a migration before `captureSql()` makes it: of `b`, which the
        // update's `SET` names not, and SQLite reads again after the triggers before it.
        "CREATE TRIGGER app_sets BEFORE UPDATE OF a ON sets BEGIN UPDATE sets SET b = 'q' WHERE id = NEW.id; END",
        ...own.captureSql(),
      ].map((statement) => db.prepare(statement)),
    );
    const orm = drizzle(own.client(db), { schema: { sets } });
    const dependencies = await rendered(() => orm.select().from(sets).where(eq(sets.id, 2)));
    const follower = new ExternalFollower(own.store(db), definitionOf(database(own.tables)).tables);
    await follower.changed();

    await db.prepare("UPDATE OR REPLACE sets SET a = 'y' WHERE id = 1").run();
    const { results } = await db.prepare('SELECT id, a, b FROM sets').all();

    expect(results).toStrictEqual([{ a: 'y', b: 'q', id: 1 }]);
    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it.each([
    // A name past ASCII: `app after` of U+00A0, which SQLite runs before the update.
    [
      "CREATE TRIGGER app\u{A0}after BEFORE UPDATE OF a ON sets BEGIN UPDATE sets SET a = 'w', b = 'q' WHERE id = NEW.id; END",
    ],
    // Named as a log's, of a `WHEN` whose string holds a log's words: the application's still.
    [
      "CREATE TRIGGER \"_rsd_ab_update\" BEFORE UPDATE OF a ON sets WHEN ' BEGIN INSERT INTO _rs_changes ' IS NOT NULL BEGIN UPDATE sets SET a = 'w', b = 'q' WHERE id = NEW.id; END",
    ],
    // Its table in another case, as `sqlite_schema` keeps it.
    [
      "CREATE TRIGGER app_sets BEFORE UPDATE OF a ON SETS BEGIN UPDATE sets SET a = 'w', b = 'q' WHERE id = NEW.id; END",
    ],
  ])(
    'renders a read again for a row an update meets by a trigger of its own: %s',
    async (trigger) => {
      const sets = sqliteTable(
        'sets',
        { id: integer().primaryKey(), a: text(), b: text() },
        (table) => [uniqueIndex('sets_a_b').on(table.a, table.b)],
      );
      const own = followDrizzle({ sets });
      await db.batch(
        [
          'CREATE TABLE sets (id INTEGER PRIMARY KEY, a TEXT, b TEXT)',
          'CREATE UNIQUE INDEX sets_a_b ON sets (a, b)',
          "INSERT INTO sets VALUES (1, 'x', 'p'), (2, 'x', 'q')",
          trigger,
          ...own.captureSql(),
        ].map((statement) => db.prepare(statement)),
      );
      const orm = drizzle(own.client(db), { schema: { sets } });
      const dependencies = await rendered(() => orm.select().from(sets).where(eq(sets.id, 2)));
      const follower = new ExternalFollower(
        own.store(db),
        definitionOf(database(own.tables)).tables,
      );
      await follower.changed();

      await db.prepare("UPDATE OR REPLACE sets SET a = 'x' WHERE id = 1").run();

      expect(dependencies.changedBy(await follower.changed())).toBe(true);
    },
  );

  it('refuses a render a text of a byte order mark, a space to SQLite where a token begins', async () => {
    const statement = 'SELECT 1 AS v \u{FEFF}FROM "badges"';

    await expect(faultsOf(() => follow.client(db).prepare(statement).all())).resolves.toStrictEqual(
      [new Error(`A component runs no text of a byte order mark as it renders: ${statement}`)],
    );
  });

  it('renders a read again for a row an update meets by values a trigger of its own set back', async () => {
    const sets = sqliteTable(
      'sets',
      { id: integer().primaryKey(), a: text(), b: text() },
      (table) => [uniqueIndex('sets_a_b').on(table.a, table.b)],
    );
    const own = followDrizzle({ sets });
    await db.batch(
      [
        'CREATE TABLE sets (id INTEGER PRIMARY KEY, a TEXT, b TEXT)',
        'CREATE UNIQUE INDEX sets_a_b ON sets (a, b)',
        "INSERT INTO sets VALUES (1, 'x', 'p'), (2, 'x', 'q')",
        // The update's own value of `a` reads kept to the log's trigger; `b` is read again after.
        "CREATE TRIGGER app_sets BEFORE UPDATE OF a ON sets BEGIN UPDATE sets SET a = 'w', b = 'q' WHERE id = NEW.id; END",
        ...own.captureSql(),
      ].map((statement) => db.prepare(statement)),
    );
    const orm = drizzle(own.client(db), { schema: { sets } });
    const dependencies = await rendered(() => orm.select().from(sets).where(eq(sets.id, 2)));
    const follower = new ExternalFollower(own.store(db), definitionOf(database(own.tables)).tables);
    await follower.changed();

    await db.prepare("UPDATE OR REPLACE sets SET a = 'x' WHERE id = 1").run();
    const { results } = await db.prepare('SELECT id, a, b FROM sets').all();

    expect(results).toStrictEqual([{ a: 'x', b: 'q', id: 1 }]);
    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('logs an update of a composite unique set of no trigger of its own by its rows alone', async () => {
    const posts = sqliteTable(
      'posts',
      { id: integer().primaryKey(), tenant: text(), slug: text() },
      (table) => [uniqueIndex('posts_tenant_slug').on(table.tenant, table.slug)],
    );
    const own = followDrizzle({ posts });
    await db.batch(
      [
        'CREATE TABLE posts (id INTEGER PRIMARY KEY, tenant TEXT, slug TEXT)',
        'CREATE UNIQUE INDEX posts_tenant_slug ON posts (tenant, slug)',
        "INSERT INTO posts VALUES (1, 't1', 's1'), (2, 't2', 's2')",
        ...own.captureSql(),
      ].map((statement) => db.prepare(statement)),
    );
    const at = await db
      .prepare(
        "SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = '_rs_changes'), 0) AS seq",
      )
      .first<{ seq: number }>();

    // A slug another tenant holds: the set's values, (t1, s2), meet no row.
    await db.prepare("UPDATE OR REPLACE posts SET slug = 's2' WHERE id = 1").run();
    const { results } = await db
      .prepare('SELECT before FROM _rs_changes WHERE seq > ?')
      .bind(at?.seq ?? 0)
      .all<{ before: string | null }>();

    expect(results.map((row) => JSON.parse(row.before ?? 'null') as unknown)).toStrictEqual([
      { k_id: '1', k_slug: 's1', k_tenant: 't1' },
    ]);
  });

  it('logs an update of a table of an AFTER trigger of its own by its rows', async () => {
    const own = followDrizzle({ plain });
    await db.batch(
      [
        'CREATE TABLE plain (id INTEGER PRIMARY KEY, owner TEXT)',
        'CREATE INDEX plain_owner ON plain (owner)',
        "INSERT INTO plain VALUES (1, 'p1'), (2, 'p2')",
        // Older than the log's, and after its event: it changes no value an update writes.
        'CREATE TRIGGER "app ""after"" sync" AFTER UPDATE ON plain BEGIN SELECT 1; END',
        ...own.captureSql(),
      ].map((statement) => db.prepare(statement)),
    );
    const orm = drizzle(own.client(db), { schema: { plain } });
    const dependencies = await rendered(() =>
      orm.select().from(plain).where(eq(plain.owner, 'p1')),
    );
    const follower = new ExternalFollower(own.store(db), definitionOf(database(own.tables)).tables);
    await follower.changed();

    await db.prepare("UPDATE plain SET owner = 'p3' WHERE id = 2").run();

    expect(dependencies.changedBy(await follower.changed())).toBe(false);
  });

  it("keeps its epoch where another follow's log, of the table by another name, triggers it", async () => {
    // A key named `raise`, which a log's trigger names quoted, as no keyword.
    const users = sqliteTable(
      'people',
      {
        id: integer().primaryKey(),
        raise: text(),
      },
      (table) => [index('people_raise').on(table.raise)],
    );
    const members = sqliteTable(
      'people',
      { id: integer().primaryKey(), raise: text() },
      (table) => [index('people_raise').on(table.raise)],
    );
    const first = followDrizzle({ users });
    const second = followDrizzle({ members });
    await db.batch(
      [
        'DROP TABLE IF EXISTS people',
        'CREATE TABLE people (id INTEGER PRIMARY KEY, "raise" TEXT)',
        'CREATE INDEX people_raise ON people ("raise")',
        ...first.captureSql(),
        // Newer than the first's: the second's log, of the table declared as `members`.
        ...second.captureSql(),
      ].map((statement) => db.prepare(statement)),
    );
    const store = first.store(db);

    const read = await store.changes(0, 10);
    // The next read of the schema, ten seconds after, while the triggers are those `captureSql()`
    // makes.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_100);
    const again = await store.changes(0, 10);
    clock.mockRestore();

    expect(read.epoch).not.toMatch(/:u\d+$/u);
    expect(again.epoch).toBe(read.epoch);
  });

  it.each([
    // Named as a log's, of a `WHEN` whose string holds a log's words, and of statements of its own.
    [
      `CREATE TRIGGER "_rsd_ab_insert" AFTER INSERT ON plain WHEN ' BEGIN INSERT INTO _rs_changes ' IS NOT NULL BEGIN SELECT RAISE(IGNORE) WHERE NEW.owner = 'p1'; END`,
    ],
    // Named as a log's, appending to the log of a view whose `RAISE` its text names not.
    [
      `CREATE TRIGGER "_rsd_ab_insert" AFTER INSERT ON "plain" BEGIN INSERT INTO _rs_changes (tbl, id, before, after, at) SELECT r, 'row', NULL, NULL, 0 FROM app_raising; END`,
    ],
    // Of the log's own table, which drops the entries it ignores.
    [`CREATE TRIGGER app_log BEFORE INSERT ON _rs_changes BEGIN SELECT RAISE(IGNORE); END`],
  ])(
    'renders every read again while a trigger of its own passes for the log’s: %#',
    async (trigger) => {
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {
        // The warning of a trigger that fires before the log's, kept out of the output.
      });
      const own = followDrizzle({ plain });
      await db.batch(
        [
          'CREATE TABLE plain (id INTEGER PRIMARY KEY, owner TEXT)',
          'CREATE INDEX plain_owner ON plain (owner)',
          ...own.captureSql(),
          'CREATE VIEW app_raising AS SELECT RAISE(IGNORE) AS r',
          trigger,
        ].map((statement) => db.prepare(statement)),
      );
      const orm = drizzle(own.client(db), { schema: { plain } });
      const dependencies = await rendered(() =>
        orm.select().from(plain).where(eq(plain.owner, 'p1')),
      );
      const follower = new ExternalFollower(
        own.store(db),
        definitionOf(database(own.tables)).tables,
      );
      await follower.changed();

      await db.prepare("INSERT INTO plain VALUES (1, 'p1')").run();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1100);
      const changed = await follower.changed();
      clock.mockRestore();
      warned.mockRestore();

      expect(dependencies.changedBy(changed)).toBe(true);
    },
  );

  it('refuses a PRAGMA in a render before its plan, which would set the flag', async () => {
    const orm = drizzle(follow.client(db), { schema });

    for (const pragma of [
      'PRAGMA case_sensitive_like = ON',
      '/* a flag */ PRAGMA case_sensitive_like(1)',
    ]) {
      await expect(faultsOf(() => orm.run(sql.raw(pragma)))).resolves.toStrictEqual([
        new Error(`A component runs no PRAGMA as it renders: ${pragma}`),
      ]);
    }
    const like = await db.prepare("SELECT 'a' LIKE 'A' AS v").first<{ v: number }>();

    expect(like?.v).toBe(1);
  });

  it('refuses in a render a pragma_ function, of which pragma_optimize writes', async () => {
    const tracked = follow.client(db);
    await db.prepare('DROP TABLE IF EXISTS sqlite_stat1').run();

    for (const read of [
      'SELECT * FROM pragma_optimize(65538)',
      'SELECT * FROM "PRAGMA_OPTIMIZE"',
      "SELECT * FROM 'pragma_optimize'()",
    ]) {
      await expect(faultsOf(() => tracked.prepare(read).all())).resolves.toStrictEqual([
        new Error(`A component runs no PRAGMA as it renders: ${read}`),
      ]);
    }
    const stats = await db
      .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'sqlite_stat1'")
      .first<{ n: number }>();

    expect(stats?.n).toBe(0);
  });

  it('refuses a render a text of another kind than a query, whose plan would be a statement', async () => {
    const orm = drizzle(follow.client(db), { schema });
    const statement = '/* c */ query plan pragma case_sensitive_like = ON';

    await expect(faultsOf(() => orm.run(sql.raw(statement)))).resolves.toStrictEqual([
      new Error(`A component runs a query alone as it renders: ${statement}`),
    ]);

    const like = await db.prepare("SELECT 'a' LIKE 'A' AS v").first<{ v: number }>();

    expect(like?.v).toBe(1);
  });

  it('refuses in a render a session the binding holds', async () => {
    // Older D1 bindings exposed this session. Keep that escape-path coverage with an authored
    // binding now that workerd keeps its own always-primary session in a private field.
    const session = db.withSession('first-primary');
    const legacy = new Proxy(db, {
      get: (target, key) => {
        if (key === 'alwaysPrimarySession') return session;
        return bindingValue(target, key);
      },
    });
    const held = Reflect.get(follow.client(legacy), 'alwaysPrimarySession') as D1DatabaseSession;

    await expect(faultsOf(() => held.prepare('SELECT 1 AS one').all())).resolves.toStrictEqual([
      new Error('A render runs no D1 `prepare`: query by statements, which are followed.'),
    ]);
  });

  it("runs a session's batch of its tracked statements outside a render", async () => {
    const tracked = follow.client(db);

    await expect(
      tracked.withSession('first-primary').batch([tracked.prepare('SELECT 1 AS one')]),
    ).resolves.toMatchObject([{ results: [{ one: 1 }] }]);
  });

  it("answers an object's own methods of the binding in a render", async () => {
    const tracked = follow.client(db);

    await expect(faultsOf(() => Promise.resolve(tracked.valueOf()))).resolves.toStrictEqual([]);
  });

  it("notes a render's batch of D1's statements as its fault, though its code catches it", async () => {
    const tracked = follow.client(db);

    const faults = await faultsOf(() =>
      tracked.batch([tracked.prepare('SELECT 1 AS one'), db.prepare('SELECT 2 AS two')]),
    );

    expect(faults).toStrictEqual([
      new Error('A render batches the statements of its tracked D1 binding alone.'),
    ]);
  });

  it("renders a read of a team nothing for another team's rows a unique index of part of the rows meets", async () => {
    const { follower, orm } = await invitations(invites);
    const dependencies = await rendered(() =>
      orm.select().from(invites).where(eq(invites.team, 't1')),
    );
    await follower.changed();

    // Of the same account in another team: an invitation, its renewal, and its taking up.
    const upsert =
      "INSERT INTO invites VALUES (?, 't2', 'a1', 'pending') ON CONFLICT (account, team) WHERE status = 'pending' DO UPDATE SET status = 'pending'";
    await db.prepare(upsert).bind('y1').run();
    await db.prepare(upsert).bind('y2').run();
    await db.prepare("UPDATE invites SET status = 'accepted' WHERE id = 'y1'").run();

    expect(dependencies.changedBy(await follower.changed())).toBe(false);
  });

  it('renders a read again for a row a REPLACE deletes by a unique index of part of the rows', async () => {
    const { follower, orm } = await invitations(invites);
    const dependencies = await rendered(() =>
      orm.select().from(invites).where(eq(invites.id, 'x1')),
    );
    await follower.changed();

    await db.prepare("INSERT OR REPLACE INTO invites VALUES ('x3', 't1', 'a1', 'pending')").run();
    const { results } = await db.prepare('SELECT id FROM invites ORDER BY id').all();

    expect(results).toStrictEqual([{ id: 'x2' }, { id: 'x3' }]);
    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('renders a read again for a row an update meets by the condition of a unique index alone', async () => {
    const { follower, orm } = await invitations(invites);
    const dependencies = await rendered(() =>
      orm.select().from(invites).where(eq(invites.id, 'x1')),
    );
    await follower.changed();

    // Of `status` alone: the set's values stay, and the row comes into the index over `x1`.
    await db.prepare("UPDATE OR REPLACE invites SET status = 'pending' WHERE id = 'x2'").run();
    const { results } = await db.prepare('SELECT id FROM invites').all();

    expect(results).toStrictEqual([{ id: 'x2' }]);
    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('renders a read of a team nothing for another team, of an index of all the rows declared of part', async () => {
    // The database's index is of all of the rows, which the set the schema declares of part of
    // them meets at each insert and update too.
    const { follower, orm } = await invitations(invites, [
      'DROP TABLE IF EXISTS invites',
      'CREATE TABLE invites (id TEXT PRIMARY KEY, team TEXT NOT NULL, account TEXT NOT NULL, status TEXT NOT NULL)',
      'CREATE UNIQUE INDEX invites_pending ON invites (account, team)',
      'CREATE INDEX invites_team ON invites (team)',
      "INSERT INTO invites VALUES ('x1', 't1', 'a1', 'pending')",
    ]);
    const dependencies = await rendered(() =>
      orm.select().from(invites).where(eq(invites.team, 't1')),
    );
    await follower.changed();

    await db.prepare("INSERT INTO invites VALUES ('y1', 't2', 'a1', 'pending')").run();

    expect(dependencies.changedBy(await follower.changed())).toBe(false);
  });

  it('renders a read again for a row a REPLACE takes by a unique index of part of the rows of a default', async () => {
    // `account` is NULL as the trigger before the insert reads it, and `'x'` as SQLite writes it.
    const { follower, orm } = await invitations(invites, [
      'DROP TABLE IF EXISTS invites',
      "CREATE TABLE invites (id TEXT PRIMARY KEY, team TEXT NOT NULL, account TEXT NOT NULL DEFAULT 'x', status TEXT NOT NULL)",
      "CREATE UNIQUE INDEX invites_pending ON invites (account, team) WHERE status = 'pending'",
      'CREATE INDEX invites_team ON invites (team)',
      "INSERT INTO invites VALUES ('x1', 't1', 'x', 'pending')",
    ]);
    const dependencies = await rendered(() =>
      orm.select().from(invites).where(eq(invites.id, 'x1')),
    );
    await follower.changed();

    await db
      .prepare(
        "INSERT OR REPLACE INTO invites (id, team, account, status) VALUES ('x3', 't1', NULL, 'pending')",
      )
      .run();
    const { results } = await db.prepare('SELECT id FROM invites').all();

    expect(results).toStrictEqual([{ id: 'x3' }]);
    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('renders a read again for a row an update meets by a unique index of part of the rows declared of all', async () => {
    // The schema's index of all of the rows, whose set the trigger before an update reads changed
    // alone; the database's of the pending ones.
    const { follower, orm } = await invitations(invitesWhole);
    const dependencies = await rendered(() =>
      orm.select().from(invitesWhole).where(eq(invitesWhole.id, 'x1')),
    );
    await follower.changed();

    await db.prepare("UPDATE OR REPLACE invites SET status = 'pending' WHERE id = 'x2'").run();
    const { results } = await db.prepare('SELECT id FROM invites').all();

    expect(results).toStrictEqual([{ id: 'x2' }]);
    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });
});
