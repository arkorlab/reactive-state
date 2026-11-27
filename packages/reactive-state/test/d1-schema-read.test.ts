import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { ExternalFollower } from '../src/authority/external.ts';
import { database as declared, definitionOf } from '../src/server/schema.ts';
import { followDrizzle } from '../src/sql/index.ts';
import { type LocalD1, localD1 } from '../src/sql/sqlite/local-d1.ts';
import { notedBy, rendered } from './cloudflare/d1-drizzle-render.ts';

/**
 * What the D1 follow reads of a database's schema (`sqlite_schema`), of a file in D1's shape: the
 * store, beside a page of the log, the whole of it — a plan of a followed table may stand on a table
 * nothing follows — once in ten seconds while each table's triggers are those `captureSql()` makes,
 * and once a second while one's are others; a plan, every table and index by its root page, and the
 * statements of the tables its statement names alone.
 */

const posts = sqliteTable(
  'posts',
  {
    id: integer().primaryKey(),
    owner: text().notNull(),
    title: text(),
  },
  (table) => [index('posts_owner').on(table.owner)],
);
const schema = { posts };
const follow = followDrizzle(schema);
/** The name of a trigger of the log of `posts`, as `captureSql()` makes it. */
const UPDATE_TRIGGER = `_rsd_${Buffer.from('posts').toString('hex')}_update`;
/** How long after a read of the schema the next is due, while the triggers stand: ten seconds. */
const SETTLED_MS = 10_000;
const PAST = { second: 1100, settled: SETTLED_MS + 100 } as const;

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

/** A database of the followed table and its log, and of a table nothing follows. */
async function followed(): Promise<LocalD1> {
  const binding = database();
  await ran(binding, [
    'CREATE TABLE posts (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, title TEXT)',
    'CREATE INDEX posts_owner ON posts (owner)',
    'CREATE TABLE audit (id INTEGER PRIMARY KEY, note TEXT)',
    'CREATE INDEX audit_note ON audit (note)',
    ...follow.captureSql(),
  ]);
  return binding;
}

/** The texts `binding` was given to prepare, of those `spy` saw, that read `sqlite_schema`. */
function schemaTexts(spy: { readonly mock: { readonly calls: readonly unknown[][] } }): string[] {
  return spy.mock.calls.flatMap(([asked]) =>
    typeof asked === 'string' && asked.includes('sqlite_schema') ? [asked] : [],
  );
}

/** The rows `statement` answers of `binding`. */
async function rowsOf(
  binding: LocalD1,
  statement: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const { results } = (await binding.prepare(statement).all()) as {
    readonly results: readonly Readonly<Record<string, unknown>>[];
  };
  return results;
}

/** The moment the clock of a test is held from. */
const START = Date.now();

/** The clock, held at `at` milliseconds past `START`. */
function clockAt(at: number): void {
  vi.spyOn(Date, 'now').mockReturnValue(START + at);
}

describe('what the D1 store reads of the schema', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['an index of a followed table', 'CREATE INDEX posts_title ON posts (title)'],
    ['an index of a table nothing follows', 'CREATE INDEX audit_id ON audit (id)'],
    ['a table nothing follows', 'CREATE TABLE extra (id INTEGER PRIMARY KEY)'],
    ['a view', 'CREATE VIEW recent AS SELECT id FROM audit'],
    [
      'a trigger of the log’s own table',
      'CREATE TRIGGER log_held BEFORE DELETE ON _rs_changes BEGIN SELECT 1; END',
    ],
    [
      'a trigger of the application’s of a followed table',
      'CREATE TRIGGER posts_noted AFTER UPDATE ON posts BEGIN SELECT 1; END',
    ],
    ['a trigger of the log’s dropped', `DROP TRIGGER "${UPDATE_TRIGGER}"`],
  ])('takes another epoch for %s', async (_what, statement) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      // The warning of triggers that are not `captureSql()`'s, kept out of the output.
    });
    const binding = await followed();
    const store = follow.store(binding);
    clockAt(0);
    const before = await store.changes(0, 10);

    await ran(binding, [statement]);
    clockAt(PAST.settled);
    const after = await store.changes(0, 10);

    expect(after.epoch).not.toBe(before.epoch);
  });

  it('asks a plan anew once a table nothing follows loses the key its left join was left out by', async () => {
    const binding = await followed();
    await ran(binding, ['CREATE UNIQUE INDEX audit_note_key ON audit (note)']);
    const store = follow.store(binding);
    const orm = drizzle(follow.client(binding) as never, { schema });
    // SQLite leaves out a left join of a table whose unique key matches one row, of whose columns
    // the statement reads none.
    const joined = sql`SELECT "posts"."id" FROM "posts" LEFT JOIN "audit" ON "audit"."note" = "posts"."owner"`;
    const query = () => orm.get(joined);
    clockAt(0);
    const before = await store.changes(0, 10);

    await expect(notedBy(query)).resolves.toContainEqual(
      expect.objectContaining({ table: 'posts' }),
    );

    await ran(binding, ['DROP INDEX audit_note_key']);
    clockAt(PAST.settled);
    const after = await store.changes(0, 10);

    expect(after.epoch).not.toBe(before.epoch);
    // Drizzle's error of the query, of the render's fault as its cause: the join reads `audit` now.
    await expect(notedBy(query)).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/audit, which reactive-state does not follow/u),
      }),
    });
  });

  it('reads the schema once in ten seconds while the triggers are those captureSql() makes', async () => {
    const binding = await followed();
    const store = follow.store(binding);
    const prepared = vi.spyOn(binding, 'prepare');

    clockAt(0);
    await store.changes(0, 10);
    clockAt(PAST.second);
    await store.changes(0, 10);
    clockAt(SETTLED_MS - 1);
    await store.changes(0, 10);

    expect(schemaTexts(prepared)).toHaveLength(1);

    clockAt(PAST.settled);
    await store.changes(0, 10);

    expect(schemaTexts(prepared)).toHaveLength(2);
  });

  it('reads it each second while a table’s triggers are others, each read of another epoch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      // The warning of triggers that are not `captureSql()`'s, kept out of the output.
    });
    const binding = await followed();
    await ran(binding, [`DROP TRIGGER "${UPDATE_TRIGGER}"`]);
    const store = follow.store(binding);
    const prepared = vi.spyOn(binding, 'prepare');

    clockAt(0);
    const first = await store.changes(0, 10);
    clockAt(PAST.second);
    const second = await store.changes(0, 10);

    expect(schemaTexts(prepared)).toHaveLength(2);
    expect(first.epoch).toMatch(/:u1$/u);
    expect(second.epoch).toMatch(/:u2$/u);
  });
});

describe('what a plan of a D1 statement reads of the schema', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads every table and index, and the statements of the tables it names alone', async () => {
    const binding = await followed();
    const orm = drizzle(follow.client(binding) as never, { schema });
    const prepared = vi.spyOn(binding, 'prepare');

    await notedBy(() => orm.select().from(posts).where(eq(posts.owner, 'p1')));
    const [read = ''] = schemaTexts(prepared);
    const rows = await rowsOf(binding, read);

    expect(rows.map((row) => row['name'])).toStrictEqual(
      expect.arrayContaining(['posts', 'posts_owner', 'audit', 'audit_note', '_rs_changes']),
    );
    expect(rows.filter((row) => row['sql'] !== null).map((row) => row['name'])).toStrictEqual([
      'posts',
    ]);
  });

  it('reads the statement of a table it names in another case, whose collation keeps it whole', async () => {
    const tags = sqliteTable(
      'tags',
      {
        id: integer().primaryKey(),
        label: text(),
      },
      (table) => [index('tags_label').on(table.label)],
    );
    const items = sqliteTable('items', { id: integer().primaryKey(), tag: integer() });
    const own = followDrizzle({ items, tags });
    const binding = database();
    await ran(binding, [
      'CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT COLLATE NOCASE)',
      'CREATE INDEX tags_label ON tags (label)',
      'CREATE TABLE items (id INTEGER PRIMARY KEY, tag INTEGER)',
      "INSERT INTO tags VALUES (1, 'B')",
      'INSERT INTO items VALUES (1, 1)',
      ...own.captureSql(),
    ]);
    const orm = drizzle(own.client(binding) as never, { schema: { items, tags } });
    // The text names `TAGS`, which SQLite reads as `tags`, whose `label` compares in any case.
    const joined = sql`select "t"."id" from "TAGS" "t" join "items" "i" on "i"."tag" = "t"."id" where "t"."label" = ${'a'}`;
    const query = () => orm.all(joined);
    const dependencies = await rendered(query);
    const follower = new ExternalFollower(
      own.store(binding),
      definitionOf(declared(own.tables)).tables,
    );
    await follower.changed();

    // A label of `A`, which the statement's `= 'a'` finds by the column's collation.
    await ran(binding, ["UPDATE tags SET label = 'A' WHERE id = 1"]);

    expect(dependencies.changedBy(await follower.changed())).toBe(true);
  });

  it('reads no table’s statement of one that names none', async () => {
    const binding = await followed();
    const orm = drizzle(follow.client(binding) as never, { schema });
    const prepared = vi.spyOn(binding, 'prepare');

    await notedBy(() => orm.get(sql`SELECT 1 AS one`));
    const [read = ''] = schemaTexts(prepared);
    const rows = await rowsOf(binding, read);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row['sql'] !== null)).toStrictEqual([]);
  });
});
