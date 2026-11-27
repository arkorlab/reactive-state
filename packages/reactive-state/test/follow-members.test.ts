import { pgTable, text } from 'drizzle-orm/pg-core';
import { sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { followDrizzle } from '../src/sql/index.ts';
import { followInternals } from './support/follow-store.ts';

/**
 * What a follow answers (`followDrizzle`), of PostgreSQL's tables or of D1's: what a host runs and
 * gives it — its log's statements, its connection, its prune, and of PostgreSQL's the channel its
 * log commits on — and nothing of its tables, its store or its store's name, which it keeps of its
 * own (`follow-internals.ts`) for the database of its follows.
 */

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text().notNull() });
const cards = sqliteTable('cards', { id: sqliteText().primaryKey() });

describe('a follow', () => {
  it('of PostgreSQL holds no tables, store or store name', () => {
    const follow = followDrizzle({ tasks });

    expect(new Set(Object.keys(follow))).toStrictEqual(
      new Set(['captureSql', 'channel', 'client', 'prune']),
    );

    expectTypeOf(follow).not.toHaveProperty('tables');
    expectTypeOf(follow).not.toHaveProperty('store');
    expectTypeOf(follow).not.toHaveProperty('storeName');
  });

  it('of D1 holds no tables, store or store name', () => {
    const follow = followDrizzle({ cards });

    expect(new Set(Object.keys(follow))).toStrictEqual(new Set(['captureSql', 'client', 'prune']));

    expectTypeOf(follow).not.toHaveProperty('tables');
    expectTypeOf(follow).not.toHaveProperty('store');
    expectTypeOf(follow).not.toHaveProperty('storeName');
  });

  it('keeps them of its own, for the database of its follows', () => {
    const { storeName, tables } = followInternals(followDrizzle({ tasks }, { store: 'web' }));

    expect(storeName).toBe('web');
    expect(Object.keys(tables)).toStrictEqual(['tasks', 'reactive_state_schema_web']);
  });
});
