import type { SQL } from 'drizzle-orm';
import { boolean, pgTable, text } from 'drizzle-orm/pg-core';
import { integer, sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core';
import { describe, expectTypeOf, it } from 'vitest';

import type { FieldRef } from '../src/program.ts';
import type { ReactiveDb } from '../src/sql/db.ts';
import { followDrizzle, followedDb } from '../src/sql/index.ts';

/**
 * The type of `reactiveDb`'s `db`: `followedDb`'s, of the row a condition names of each table alone
 * (`db.<table>.where(…)`), of PostgreSQL's tables and of D1's. What `database()`'s type holds
 * besides — `get`, `findMany`, `count` and the rest, and `db.transaction` — is a fault of a
 * followed table, so the type holds none of it.
 */

const tasks = pgTable('tasks', {
  id: text().primaryKey(),
  title: text().notNull(),
  done: boolean().notNull(),
});
const cards = sqliteTable('cards', {
  id: sqliteText().primaryKey(),
  title: sqliteText().notNull(),
  done: integer({ mode: 'boolean' }).notNull(),
});

describe("reactiveDb's db", () => {
  it("is followedDb's of PostgreSQL's tables: where alone, as precise", () => {
    const followed = followedDb(followDrizzle({ tasks }));
    type Db = ReactiveDb<{ tasks: typeof tasks }>['db'];
    type Bound = ReturnType<Db['tasks']['where']>;

    expectTypeOf(followed.tasks).toEqualTypeOf<Db['tasks']>();
    expectTypeOf<Parameters<Db['tasks']['where']>[0]>().toEqualTypeOf<SQL | undefined>();
    expectTypeOf<Bound['title']>().toEqualTypeOf<FieldRef<string>>();
    expectTypeOf<Bound['done']>().toEqualTypeOf<FieldRef<boolean>>();
    expectTypeOf<Db['tasks']>().not.toHaveProperty('get');
    expectTypeOf<Db['tasks']>().not.toHaveProperty('findMany');
    expectTypeOf<Db['tasks']>().not.toHaveProperty('count');
    expectTypeOf<Db['tasks']>().not.toHaveProperty('insert');
    expectTypeOf<Db['tasks']>().not.toHaveProperty('ref');
    expectTypeOf<Db>().not.toHaveProperty('transaction');
  });

  it("is followedDb's of D1's tables: where alone, as precise", () => {
    const followed = followedDb(followDrizzle({ cards }));
    type Db = ReactiveDb<{ cards: typeof cards }>['db'];
    type Bound = ReturnType<Db['cards']['where']>;

    expectTypeOf(followed.cards).toEqualTypeOf<Db['cards']>();
    expectTypeOf<Bound['title']>().toEqualTypeOf<FieldRef<string>>();
    expectTypeOf<Bound['done']>().toEqualTypeOf<FieldRef<boolean>>();
    expectTypeOf<Db['cards']>().not.toHaveProperty('get');
    expectTypeOf<Db['cards']>().not.toHaveProperty('findMany');
    expectTypeOf<Db['cards']>().not.toHaveProperty('count');
    expectTypeOf<Db>().not.toHaveProperty('transaction');
  });
});
