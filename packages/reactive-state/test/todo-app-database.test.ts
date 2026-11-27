import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { fresh } from './support/todo-app/database.ts';
import { connected, orm } from './support/todo-app/db.ts';
import { counters, memberships, projects, todos } from './support/todo-app/schema.ts';

/**
 * The test application's database on Node, of its Drizzle schema in D1: a database of memory alone
 * made anew for each test, of the tables its Drizzle schema declares and the old application's
 * seed, which the application reads and writes until the test ends; one a test.
 */

/** The title of the first to-do of the seed, as the application reads it. */
async function firstTitle(): Promise<string | undefined> {
  return (await orm.select().from(todos).where(eq(todos.id, 't1')))[0]?.title;
}

describe('the test application’s database', () => {
  it('seeds the old application’s rows, under their ids', async () => {
    await fresh();

    await expect(orm.select().from(projects).orderBy(asc(projects.id))).resolves.toStrictEqual([
      { id: 'p1', ownerId: 'alice', title: '開発' },
      { id: 'p2', ownerId: 'alice', title: '運用' },
      { id: 'p3', ownerId: 'bob', title: 'Bob の作業' },
    ]);
    await expect(
      orm.select().from(memberships).orderBy(asc(memberships.id)),
    ).resolves.toStrictEqual([
      { canEdit: true, id: 'p1-bob', projectId: 'p1', userId: 'bob' },
      { canEdit: true, id: 'p2-bob', projectId: 'p2', userId: 'bob' },
    ]);
    await expect(orm.select().from(todos).orderBy(asc(todos.id))).resolves.toStrictEqual([
      { completed: false, estimate: 2, id: 't1', projectId: 'p1', title: '一覧を作る' },
      { completed: false, estimate: 3, id: 't2', projectId: 'p1', title: '同期を確認する' },
      { completed: false, estimate: 1, id: 't3', projectId: 'p2', title: '監視を見直す' },
    ]);
    await expect(orm.select().from(counters).orderBy(asc(counters.id))).resolves.toStrictEqual([
      { count: 0, id: 'main', ownerId: 'alice', title: 'Shared counter' },
      { count: 100, id: 'other', ownerId: 'alice', title: 'Unrelated counter' },
    ]);
  });

  it('logs no row of the seed, and each write after it', async () => {
    const binding = await fresh();
    const logged = async () => {
      const { results } = await binding
        .prepare('SELECT tbl, id FROM _rs_changes ORDER BY seq')
        .all();
      return results;
    };

    // Of the log's making: an entry of each table whole, and none of a row.
    await expect(logged()).resolves.toStrictEqual(
      ['counters', 'memberships', 'projects', 'todos'].map((tbl) => ({ id: '', tbl })),
    );

    await orm.update(todos).set({ title: 'Renamed' }).where(eq(todos.id, 't1'));

    await expect(logged()).resolves.toContainEqual({
      id: expect.stringMatching(/./u),
      tbl: 'todos',
    });
  });

  it('writes the database of its test', async () => {
    await fresh();
    await orm.update(todos).set({ title: 'Of the first' }).where(eq(todos.id, 't1'));

    await expect(firstTitle()).resolves.toBe('Of the first');
  });

  // Of the order of the cases: this one reads what the one before left, and the one after it runs
  // after a test that connected a database.
  it('makes each test’s database anew, whatever the test before wrote', async () => {
    await fresh();

    await expect(firstTitle()).resolves.toBe('一覧を作る');
  });

  it('refuses a statement of a test that made no database, naming the store', async () => {
    expect(connected()).toBeUndefined();

    await expect(firstTitle()).rejects.toThrow('The store `app` reads and writes D1');
  });

  it('refuses a second database in one test, naming the engine over the first', async () => {
    const first = await fresh();

    await expect(fresh()).rejects.toThrow(
      "This test's database is connected already, and every engine of the test reads it: give another engine over it (`reopened()` on Node), not a second database.",
    );
    expect(connected()).toBe(first);
  });
});
