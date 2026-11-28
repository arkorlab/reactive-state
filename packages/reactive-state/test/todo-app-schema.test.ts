import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import { fresh } from './support/todo-app/database.ts';
import { schema, TABLES } from './support/todo-app/schema.ts';

/**
 * The test application's tables, as the database makes them of its Drizzle schema: what it
 * enforces is what the old application's fields declared — each length and range, the `unique`
 * group, each default — written here as that declaration had them, apart from the schema's own
 * limits, so that a change of either is a failure here.
 */

/** A column as SQLite reads it of a table. */
interface Read {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

/** Text of `length` code points. */
function text(length: number, of = 'x'): string {
  return of.repeat(length);
}

/** A column of a table, as the table's configuration holds it. */
type Column = ReturnType<typeof getTableConfig>['columns'][number];

/** The default `column` is made of, as SQLite reads it back. */
function defaultOf(column: Column): string | null {
  if (column.default === undefined) return null;
  const written: unknown = column.mapToDriverValue(column.default);
  return typeof written === 'string' ? `'${written}'` : String(written);
}

/**
 * Each bound of the old declaration (`test/support/app/db.ts`): a row of a table, a column, the
 * last value it took, and the first it refused — of a length in code points, the database's unit.
 */
const BOUNDS = [
  ['a project’s owner', 'projects', 'p1', 'owner_id', text(64), text(65)],
  ['a project’s title', 'projects', 'p1', 'title', text(200), text(201)],
  ['a membership’s project', 'memberships', 'p1-bob', 'project_id', text(64), text(65)],
  ['a membership’s user', 'memberships', 'p1-bob', 'user_id', text(64), text(65)],
  ['a to-do’s project', 'todos', 't1', 'project_id', text(64), text(65)],
  ['a to-do’s title', 'todos', 't1', 'title', text(200), text(201)],
  ['a to-do’s title of emoji', 'todos', 't1', 'title', text(200, '😀'), text(201, '😀')],
  ['a to-do’s least estimate', 'todos', 't1', 'estimate', 0, -1],
  ['a to-do’s greatest estimate', 'todos', 't1', 'estimate', 1_000_000, 1_000_001],
  ['a counter’s owner', 'counters', 'main', 'owner_id', text(64), text(65)],
  ['a counter’s title', 'counters', 'main', 'title', text(200), text(201)],
  ['a counter’s least count', 'counters', 'main', 'count', -1_000_000, -1_000_001],
  ['a counter’s greatest count', 'counters', 'main', 'count', 1_000_000, 1_000_001],
] as const;

describe('the test application’s tables', () => {
  it('makes each column the schema declares, of its type, default and key', async () => {
    const binding = await fresh();

    for (const table of Object.values(schema)) {
      const config = getTableConfig(table);
      const { results } = await binding.prepare(`PRAGMA table_info(${config.name})`).all();

      expect(results as readonly Read[]).toStrictEqual(
        config.columns.map((column, cid) => {
          return {
            cid,
            dflt_value: defaultOf(column),
            name: column.name,
            notnull: column.notNull ? 1 : 0,
            pk: column.primary ? 1 : 0,
            type: column.getSQLType().toUpperCase(),
          };
        }),
      );
    }

    expect(new Set(Object.values(schema).map((table) => getTableConfig(table).name))).toStrictEqual(
      new Set(TABLES),
    );
  });

  it('makes each CHECK and each index the schema declares', async () => {
    const binding = await fresh();

    for (const table of Object.values(schema)) {
      const config = getTableConfig(table);
      const made = await binding
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .bind(config.name)
        .first('sql');
      const checks = config.checks.map((each) => `CONSTRAINT "${each.name}" CHECK (`);
      const { results } = await binding.prepare(`PRAGMA index_list(${config.name})`).all();
      const indexes = (results as readonly { name: string; origin: string; unique: number }[])
        .filter((index) => index.origin === 'c')
        .map((index) => [index.name, index.unique]);

      expect(checks.every((each) => String(made).includes(each))).toBe(true);
      expect(String(made).match(/CHECK \(/gu) ?? []).toHaveLength(checks.length);
      expect(indexes).toStrictEqual(
        config.indexes.map((index) => [index.config.name, index.config.unique ? 1 : 0]),
      );
    }
  });

  it.each(BOUNDS)('takes %s to its declared bound, and no further', async (...bound) => {
    const [, table, id, column, last, first] = bound;
    const binding = await fresh();
    const set = (value: number | string) =>
      binding.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).bind(value, id).run();

    await expect(set(last)).resolves.toMatchObject({ success: true });
    await expect(set(first)).rejects.toThrow('CHECK constraint failed');
  });

  it('holds one membership of a project’s user, and members of a project apart', async () => {
    const binding = await fresh();
    const member = async (id: string, user: string) => {
      return binding
        .prepare(
          "INSERT INTO memberships (id, project_id, user_id, can_edit) VALUES (?, 'p1', ?, 0)",
        )
        .bind(id, user)
        .run();
    };

    await expect(member('p1-carol', 'carol')).resolves.toMatchObject({ success: true });
    await expect(member('p1-bob-again', 'bob')).rejects.toThrow('UNIQUE constraint failed');
    await expect(
      binding
        .prepare("SELECT sql FROM sqlite_schema WHERE name = 'memberships_project_user'")
        .first('sql'),
    ).resolves.toContain('ON "memberships" ("project_id", "user_id")');
  });

  it('makes a row of an id alone of the defaults the old fields had', async () => {
    const binding = await fresh();
    const made = async (table: string) => {
      await binding.prepare(`INSERT INTO ${table} (id) VALUES ('d')`).run();
      return binding.prepare(`SELECT * FROM ${table} WHERE id = 'd'`).first();
    };

    await expect(made('projects')).resolves.toStrictEqual({ id: 'd', owner_id: '', title: '' });
    await expect(made('memberships')).resolves.toStrictEqual({
      can_edit: 0,
      id: 'd',
      project_id: '',
      user_id: '',
    });
    await expect(made('todos')).resolves.toStrictEqual({
      completed: 0,
      estimate: 0,
      id: 'd',
      project_id: '',
      title: '',
    });
    await expect(made('counters')).resolves.toStrictEqual({
      count: 0,
      id: 'd',
      owner_id: '',
      title: '',
    });
  });
});
