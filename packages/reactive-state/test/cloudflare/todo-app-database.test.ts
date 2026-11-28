import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { BoundRow, FieldRef } from '../../src/program.ts';
import { connected, orm } from '../support/todo-app/db.ts';
import { todoRow } from '../support/todo-app/rows.ts';
import { todos } from '../support/todo-app/schema.ts';
import { fresh } from './todo-app-database.ts';

/**
 * The test application's database in workerd, of its Drizzle schema: the suite's D1 made anew
 * for each test, of the seed, which the application's Drizzle and its bound rows read and write
 * through the same module as on Node. The cases run in their order: the second reads what the
 * first left, and the third runs after a test that connected a database.
 */

/** The title of the first to-do of the seed, as the application reads it. */
async function firstTitle(): Promise<string | undefined> {
  return (await orm.select().from(todos).where(eq(todos.id, 't1')))[0]?.title;
}

/** The row a reference is of. */
function rowOf(reference: FieldRef): BoundRow {
  if (reference.row === undefined) throw new Error('The reference names no row.');
  return reference.row;
}

describe('the test application’s database in workerd', () => {
  it('seeds the suite’s D1, which the application writes', async () => {
    await fresh();
    await orm.update(todos).set({ title: 'Renamed' }).where(eq(todos.id, 't1'));

    await expect(firstTitle()).resolves.toBe('Renamed');
  });

  it('makes it anew of the seed alone, whatever the test before wrote', async () => {
    const binding = await fresh();

    await expect(firstTitle()).resolves.toBe('一覧を作る');
    await expect(
      binding.prepare("SELECT count(*) AS n FROM _rs_changes WHERE id <> ''").first('n'),
    ).resolves.toBe(0);
  });

  it('connects none as a test ends, and refuses a second database in one test', async () => {
    expect(connected()).toBeUndefined();

    await fresh();

    await expect(fresh()).rejects.toThrow('give another engine over it');
  });

  it('reads and writes a bound row of the suite’s D1, as a state binds it', async () => {
    const binding = await fresh();
    const row = rowOf(todoRow('p1', 't1').title);

    await expect(row.read(['title', 'estimate', 'completed'])).resolves.toStrictEqual({
      completed: false,
      estimate: 2,
      title: '一覧を作る',
    });
    await expect(row.write('estimate', 1_000_001)).resolves.toBe('invalid');
    await expect(row.write('title', 'Written', '一覧を作る')).resolves.toBe('written');
    await expect(
      binding.prepare("SELECT title FROM todos WHERE id = 't1'").first('title'),
    ).resolves.toBe('Written');
  });

  it('reads no bound row of another project’s', async () => {
    await fresh();

    await expect(rowOf(todoRow('p2', 't1').title).read(['title'])).resolves.toBeUndefined();
  });
});
