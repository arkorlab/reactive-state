import { recordResource } from '../program.ts';
import { type DatabaseDefinition, uniqueValue } from '../server/schema.ts';
import type { Database } from './database.ts';
import { valuesOf } from './records.ts';

/** Whether a table of the declaration holds a `unique` group, which its records are checked for. */
function holdsUnique(tables: DatabaseDefinition['tables']): boolean {
  for (const table of tables.values()) {
    if (table.unique.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Makes each record the declaration seeds that the database was never seeded with: a record seeded
 * once and deleted since stays deleted, however often the database is opened again. Those a
 * database starts with are where it starts; one made later — as the declaration gains a seed — is a
 * change like any other, numbered and logged, so that a page rendered before it hears of it. A database
 * whose records hold one value of a `unique` group twice — a seed's among them, or a group the
 * declaration gained over records that already did — is refused, and left as it was.
 */
export function seedDatabase(
  db: Database,
  definition: DatabaseDefinition,
  clock: () => number,
): void {
  const { seed, tables } = definition;
  if (seed.length === 0 && !holdsUnique(tables)) {
    return;
  }
  db.transaction(() => {
    const made: string[] = [];
    for (const { id, table, values } of seed) {
      if (db.seedRecord(table, id, values)) {
        made.push(recordResource(table, id));
      }
    }
    for (const [name, table] of tables) {
      for (const group of table.unique) {
        const held = new Set<string>();
        for (const { data } of db.records(name)) {
          const value = uniqueValue(group, valuesOf(table, data));
          if (held.has(value)) {
            throw new Error(
              `database(): two records of ${name} hold the same ${group.join(', ')}.`,
            );
          }
          held.add(value);
        }
      }
    }
    if (made.length > 0 && !db.made) {
      db.advance(made, 'state', clock());
    }
  });
}
