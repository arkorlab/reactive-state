import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { hostOf } from '../src/authority/database-host.ts';
import { prepare } from '../src/cli/prepare.ts';
import { projectOfLoader } from '../src/next/config.ts';
import { database, table, text as textField } from '../src/server/index.ts';
import { reactiveDb } from '../src/sql/db.ts';

/**
 * What `reactive dev` does of an application before its authority starts, by where its files are:
 * what `next dev` and the authority's process around it do is the fixture's to show.
 */

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text().notNull() });
const schema = { tasks };
/** Drizzle's journal of one migration, as `drizzle-kit` writes it. */
const JOURNAL = {
  dialect: 'postgresql',
  entries: [
    { breakpoints: true, idx: 0, tag: '0000_first', version: '7', when: 1_700_000_000_000 },
  ],
  version: '7',
};
/** Each test makes a PGlite of its own, as long as a second and more under load. */
const TEST_TIMEOUT_MS = 20_000;

/** An application's root, of the migration above where `migrations` says, and of `seed` as its `src/seed.ts`. */
function projectOf({ migrations, seed }: { migrations?: boolean; seed?: string }) {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-dev-'));
  onTestFinished(() => {
    rmSync(root, { force: true, recursive: true });
  });
  const src = path.join(root, 'src');
  mkdirSync(src);
  if (migrations === true) {
    mkdirSync(path.join(root, 'drizzle/meta'), { recursive: true });
    writeFileSync(path.join(root, 'drizzle/meta/_journal.json'), JSON.stringify(JOURNAL));
    writeFileSync(
      path.join(root, 'drizzle/0000_first.sql'),
      'CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL);',
    );
  }
  if (seed !== undefined) writeFileSync(path.join(src, 'seed.ts'), seed);
  return { root, src };
}

/** An application whose `src/seed.ts` calls `run`, what the test counts its calls by. */
function seedOf(run: () => unknown) {
  const seeded = vi.fn(run);
  vi.stubGlobal('seededByTheTest', seeded);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  const project = projectOf({
    migrations: true,
    seed: 'export const seed = () => globalThis.seededByTheTest();',
  });
  return { ...project, seeded };
}

describe('what a development start prepares', () => {
  const { pglite } = { pglite: process.env['PGLITE_DIR'] };

  beforeEach(() => {
    process.env['PGLITE_DIR'] = 'memory://';
  });

  afterEach(() => {
    if (pglite === undefined) delete process.env['PGLITE_DIR'];
    else process.env['PGLITE_DIR'] = pglite;
  });

  it(
    "runs the application's migrations, where it has any",
    async () => {
      const { db, orm } = await reactiveDb(schema);
      const { root, src } = projectOf({ migrations: true });

      await prepare(db, root, src);

      await expect(orm.execute(sql`SELECT count(*)::int AS n FROM tasks`)).resolves.toMatchObject({
        rows: [{ n: 0 }],
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs nothing of an application of no migrations and no seed',
    async () => {
      const { db, orm } = await reactiveDb(schema);
      const { root, src } = projectOf({});

      await prepare(db, root, src);

      await expect(orm.execute(sql`SELECT to_regclass('tasks') AS held`)).resolves.toMatchObject({
        rows: [{ held: null }],
      });
    },
    TEST_TIMEOUT_MS,
  );

  it('leaves the migrations of a database that opens no connection of its own', async () => {
    const db = database({ notes: table({ body: textField() }) });
    const { root, src } = projectOf({ migrations: true });

    await expect(prepare(db, root, src)).resolves.toBeUndefined();
  });

  it(
    "runs the application's seed, after its migrations",
    async () => {
      const { db, orm } = await reactiveDb(schema);
      const { root, seeded, src } = seedOf(async () =>
        orm.execute(sql`INSERT INTO tasks VALUES ('a', 'one') RETURNING id`),
      );

      await prepare(db, root, src);

      expect(seeded).toHaveBeenCalledTimes(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs the seed once of a database, however often it starts, so that it may be a plain insert',
    async () => {
      const { db, orm } = await reactiveDb(schema);
      const { root, seeded, src } = seedOf(() =>
        orm.execute(sql`INSERT INTO tasks VALUES ('a', 'one')`),
      );

      await prepare(db, root, src);
      await prepare(db, root, src);

      expect(seeded).toHaveBeenCalledTimes(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reads the seed's module after the migrations, which it may read of as it loads",
    async () => {
      const { db, orm } = await reactiveDb(schema);
      vi.stubGlobal('readAsItLoads', () => orm.execute(sql`SELECT 1 FROM tasks`));
      onTestFinished(() => {
        vi.unstubAllGlobals();
      });
      const { root, src } = projectOf({
        migrations: true,
        seed: 'await globalThis.readAsItLoads();\nexport const seed = () => undefined;',
      });

      await expect(prepare(db, root, src)).resolves.toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs a seed that failed again, as nothing says it ran',
    async () => {
      const { db } = await reactiveDb(schema);
      const failing = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error('The seed failed.'));
      const { root, seeded, src } = seedOf(failing);

      await expect(prepare(db, root, src)).rejects.toThrow('The seed failed.');

      await prepare(db, root, src);
      await prepare(db, root, src);

      expect(seeded).toHaveBeenCalledTimes(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs the seed of a database made anew, which says nothing of the one before',
    async () => {
      const { db: first } = await reactiveDb(schema);
      const { db: second } = await reactiveDb(schema);
      const { root, seeded, src } = seedOf(vi.fn());

      await prepare(first, root, src);
      await prepare(second, root, src);

      expect(seeded).toHaveBeenCalledTimes(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps what it noted in the schema of the database's log",
    async () => {
      const { db, orm } = await reactiveDb(schema, { namespace: 'another_log' });
      const { root, src } = seedOf(vi.fn());

      await prepare(db, root, src);

      await expect(
        orm.execute(sql`SELECT count(*)::int AS notes FROM another_log.seeded`),
      ).resolves.toMatchObject({ rows: [{ notes: 1 }] });
    },
    TEST_TIMEOUT_MS,
  );

  it('runs the seed at each start of a database that holds no note of it', async () => {
    const db = database({ notes: table({ body: textField() }) });
    const { root, seeded, src } = seedOf(vi.fn());

    await prepare(db, root, src);
    await prepare(db, root, src);

    expect(seeded).toHaveBeenCalledTimes(2);
  });

  it(
    "runs the migrations and the seed once of a schema of SQLite's tables, D1's",
    async () => {
      const kept = process.env['D1_FILE'];
      process.env['D1_FILE'] = ':memory:';
      onTestFinished(() => {
        if (kept === undefined) delete process.env['D1_FILE'];
        else process.env['D1_FILE'] = kept;
      });
      const d1Tasks = sqliteTable('tasks', {
        id: sqliteText().primaryKey(),
        title: sqliteText().notNull(),
      });
      const { db, orm } = await reactiveDb({ tasks: d1Tasks });
      onTestFinished(() => hostOf(db)?.close());
      const { root, seeded, src } = seedOf(() =>
        orm.insert(d1Tasks).values({ id: 'a', title: 'one' }),
      );

      await prepare(db, root, src);
      await prepare(db, root, src);

      expect(seeded).toHaveBeenCalledTimes(1);
      await expect(orm.select().from(d1Tasks)).resolves.toStrictEqual([{ id: 'a', title: 'one' }]);
    },
    TEST_TIMEOUT_MS,
  );

  it('says so of a seed that exports none to run', async () => {
    const db = database({ notes: table({ body: textField() }) });
    const { root, src } = projectOf({ seed: 'export const first = 1;' });

    await expect(prepare(db, root, src)).rejects.toThrow('exports no `seed`');
  });
});

describe('what a compile is given of a config', () => {
  it('reads what the rule of the components says, and leaves out what it does not', () => {
    expect(projectOfLoader({ out: '.out', root: '/app', src: 'lib' })).toStrictEqual({
      out: '.out',
      projectDir: '/app',
      src: 'lib',
    });
    expect(
      projectOfLoader({
        database: '@/store#store',
        out: '.reactive',
        prefetch: 'hours',
        root: '/app',
        session: '@/auth#session',
        share: 'off',
        src: 'src',
      }),
    ).toStrictEqual({
      database: '@/store#store',
      out: '.reactive',
      prefetch: 'hours',
      projectDir: '/app',
      session: '@/auth#session',
      share: false,
      src: 'src',
    });
  });
});
