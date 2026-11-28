import { pgTable, text as column } from 'drizzle-orm/pg-core';
import { sqliteTable, text as sqliteColumn } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import { followedTable } from '../src/server/followed-table.ts';
import { database, definitionOf, table, text } from '../src/server/schema.ts';
import { followDrizzle, followedDb } from '../src/sql/index.ts';
import { followInternals } from './support/follow-store.ts';

/**
 * A table read through a store is one a follow of the application's Drizzle schema declares
 * (`followed-table.ts`), and nothing else: `table()` declares one the authority keeps, and refuses
 * a store's name; `database()` takes a table that names a store of a follow's alone. What a follow's
 * tables may not be — a store's name that is none, seed records, a reference to a record — is
 * refused as it was of a table declared by hand.
 */

const tasks = pgTable('tasks', { id: column().primaryKey(), title: column().notNull() });
const cards = sqliteTable('cards', { id: sqliteColumn().primaryKey() });

/**
 * A store's name as a caller in JavaScript, or through `any`, may give one that is no text: each
 * converts to text that reads as a name.
 */
const NO_TEXT: readonly (readonly [string, unknown])[] = [
  ['a boolean', true],
  ['a number', NaN],
  ['a list of a name', ['store']],
  ['an object', { toString: () => 'store' }],
];

/** What `table()` and `database()` say of a table that names a store no follow declared it of. */
const NOT_FOLLOWED =
  "a table of the application's own database is one of its Drizzle schema, which `followDrizzle()` of `./drizzle` follows";

describe('a table read through a store', () => {
  it('is refused of table(), naming followDrizzle', () => {
    const untyped = table as (fields: unknown, options: unknown) => unknown;

    expect(() => untyped({}, { external: 'x' })).toThrow(
      `database(): \`external\` is no option of table(): ${NOT_FOLLOWED}`,
    );
    expect(() => untyped({ title: text() }, { external: null })).toThrow(NOT_FOLLOWED);
  });

  it('is refused of database() where a table written by hand names one', () => {
    const written = { external: 'x', fields: { title: text() }, public: [], unique: [] };
    const copied = { ...followInternals(followDrizzle({ tasks })).tables['tasks'] };

    expect(() => database({ records: written as never })).toThrow(
      `database(): the table \`records\` names a store, which no follow declared it of: ${NOT_FOLLOWED}`,
    );
    expect(() => database({ tasks: copied as never })).toThrow(NOT_FOLLOWED);
  });

  it('is taken of database() as a follow declared it, its store named', () => {
    const { tables } = followInternals(followDrizzle({ tasks }, { store: 'web' }));
    const declared = definitionOf(database(tables)).tables;

    expect(declared.get('tasks')).toBe(tables['tasks']);
    expect(declared.get('tasks')?.external).toBe('web');
    expect(Object.isFrozen(declared.get('tasks'))).toBe(true);
    expect(Object.isFrozen(declared.get('tasks')?.fields)).toBe(true);
  });
});

describe('a row a state binds', () => {
  it('is a follow’s table’s alone: one written by hand is declared of none', () => {
    const rows = { fields: {}, where: () => ({}) };
    const written = { fields: { title: text() }, public: [], rows, unique: [] };
    const db = database({ records: written as never }) as unknown as Readonly<
      Record<string, { readonly where: (condition: unknown) => unknown }>
    >;

    expect(definitionOf(db as never).tables.get('records')).not.toHaveProperty('rows');
    expect(() => db['records']?.where({})).toThrow(
      'db.records.where: a condition names a row of a table of a Drizzle schema, which records is not',
    );
  });
});

describe("a follow's tables", () => {
  it.each([
    ['PostgreSQL', { tasks }],
    ['D1', { cards }],
  ])('of %s refuse a store whose name is none', (_, schema) => {
    expect(() => followDrizzle(schema, { store: 'not-a-name' })).toThrow(
      "followDrizzle(): `not-a-name` is not a store's name: a letter, then letters, digits or _",
    );
  });

  it.each(NO_TEXT)('refuse a store whose name is %s, though it converts to one', (_, store) => {
    expect(() => followDrizzle({ tasks }, { store: store as string })).toThrow(
      "followDrizzle(): a store's name is text",
    );
  });

  it.each([
    ['PostgreSQL', { tasks }],
    ['D1', { cards }],
  ])('of %s are of the store `sql` where its name is `null`, as of none', (_, schema) => {
    const { storeName, tables } = followInternals(followDrizzle(schema, { store: null as never }));

    expect(storeName).toBe('sql');
    expect(Object.keys(tables)).toContain('reactive_state_schema_sql');
    expect(Object.values(tables).map((each) => each.external)).toStrictEqual(
      Object.values(tables).map(() => 'sql'),
    );
  });

  it.each(['id', '1st', 'with-dash', 'k_é', ''])(
    'refuse a field whose name is none, `%s`, where they are made',
    (name) => {
      expect(() => followedTable({ [name]: text() }, 'sql')).toThrow(
        `followDrizzle(): \`${name}\` is not a field's name: a letter, then letters, digits or _, and never \`id\``,
      );
    },
  );

  it('take a field of a key column, `k_<column>`, and of no field', () => {
    const keyed = followedTable({ k_id: text(), k_2: text() }, 'sql');

    expect(Object.keys(keyed.fields)).toStrictEqual(['k_id', 'k_2']);
    expect(followedTable({}, 'sql').fields).toStrictEqual({});
  });

  it('refuse seed records, which the authority never writes', () => {
    const { tables } = followInternals(followDrizzle({ tasks }));

    expect(() => database(tables, { seed: { tasks: { t1: {} } } })).toThrow(
      "database(): the seed names `tasks`, whose records are the store `sql`'s, which the authority never writes",
    );
  });

  it('refuse a reference to a record, before any evaluation', () => {
    const db = followedDb(followDrizzle({ tasks })) as unknown as Readonly<
      Record<string, { readonly ref: (id: string) => unknown }>
    >;

    expect(() => db['reactive_state_schema_sql']?.ref('first')).toThrow(
      'whose records no state is bound to',
    );
    expect(() => db['tasks']?.ref('first')).toThrow('a row of tasks is named by a condition');
  });
});
