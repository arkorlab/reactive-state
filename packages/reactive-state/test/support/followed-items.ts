import { pgTable, text } from 'drizzle-orm/pg-core';

import type { ExternalStore } from '../../src/authority/external.ts';
import { type AnyDatabase, definitionOf, type Table } from '../../src/server/schema.ts';
import { followDrizzle, followedDb } from '../../src/sql/index.ts';
import { readingThrough } from './follow-store.ts';

/**
 * The one table of the tests of what the authority does of a followed store's log, `items`, of a
 * Drizzle schema: followed as the store `remote` by a follow given no connection, whose log is a
 * stand-in of the test's, brought by the database's declaration in place of the follow's own.
 */

const items = pgTable('items', { id: text().primaryKey(), title: text() });

/** The store's name the follow of `items` is of. */
const ITEMS_STORE = 'remote';

/** The database of `items`, as an application declares it (`followedDb`). */
function declared() {
  return followedDb(followDrizzle({ items }, { store: ITEMS_STORE }));
}

/** A database of `items`, whose log the authority reads through `store`. */
export function itemsReadThrough(store: ExternalStore): AnyDatabase {
  return readingThrough(declared(), { [ITEMS_STORE]: () => store });
}

/** The tables of a database of `items`, as the authority reads them: `items`, and its schema's. */
export function itemTables(): ReadonlyMap<string, Table> {
  return definitionOf(declared()).tables;
}
