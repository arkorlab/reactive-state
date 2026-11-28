import type { Table, TableRows } from './schema.ts';

/**
 * The tables a follow declares of an application's Drizzle schema (`followDrizzle`): each read
 * through the follow's store, by its name, its records none of the authority's — what `database()`
 * takes as a table of a store, and nothing else. A table is one of them as this module made it:
 * one of `table()`, or written by hand, is none, whatever store it names.
 */

/** A store's name, and a field's: a letter, then up to 63 letters, digits or `_`. */
const NAME = /^[A-Za-z]\w{0,63}$/u;

/** Where they are kept, on `globalThis`: a follow may be of another copy of this module. */
const FOLLOWED = Symbol.for('arkorlab.reactive-state.followed-tables');

/** The tables this module made, of the process's. */
function made(): WeakSet<Table> {
  const shared = globalThis as unknown as Record<symbol, WeakSet<Table> | undefined>;
  shared[FOLLOWED] ??= new WeakSet();
  return shared[FOLLOWED];
}

function fail(message: string): never {
  throw new TypeError(`followDrizzle(): ${message}`);
}

/**
 * A table of `fields` a follow declares, read through the store `store`, and, of a table of the
 * schema's, how a state binds one of its rows (`rows`): it declares no public fields and no unique
 * groups, as the authority keeps neither of a database of the application's own. Frozen, as
 * `database()` takes it as it is.
 */
export function followedTable<F extends Table['fields']>(
  fields: F,
  store: string,
  rows?: TableRows,
): Table<F> {
  // Text alone, as a caller in JavaScript, or through `any`, may give another value: `NAME` would
  // test the text it converts to, and take `null`, `true` or `['store']` for a name.
  if (typeof store !== 'string') {
    fail("a store's name is text: a letter, then letters, digits or _");
  }
  if (!NAME.test(store)) {
    fail(`\`${store}\` is not a store's name: a letter, then letters, digits or _`);
  }
  // As `table()` holds a field's name: `database()` takes this table as it is made.
  for (const name of Object.keys(fields)) {
    if (name === 'id' || !NAME.test(name)) {
      fail(
        `\`${name}\` is not a field's name: a letter, then letters, digits or _, and never \`id\``,
      );
    }
  }
  const table: Table<F> = Object.freeze({
    external: store,
    fields: Object.freeze({ ...fields }),
    public: Object.freeze([]),
    unique: Object.freeze([]),
    ...(rows !== undefined && { rows }),
  });
  made().add(table);
  return table;
}

/** Whether `table` is one a follow declares, as `followedTable` made it. */
export function isFollowedTable(table: Table): boolean {
  return made().has(table);
}
