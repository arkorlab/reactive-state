import { mkdirSync } from 'node:fs';
import path from 'node:path';
// The authority's database on a developer's machine is SQLite through Node's own driver: a release
// candidate in Node 25, and present without a flag in the Node 24 this workspace runs.
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- see above
import { DatabaseSync } from 'node:sqlite';

import { refuseAsync, type SqlDriver } from './sql.ts';

/** What Node's driver is opened with: what a Durable Object's storage settles for itself. */
const PRAGMAS: readonly string[] = [
  'PRAGMA journal_mode=WAL',
  'PRAGMA foreign_keys=ON',
  'PRAGMA busy_timeout=5000',
];

/** The authority's SQLite in a file, or in memory (`:memory:`), through `node:sqlite`. */
export function nodeSql(filename: string): SqlDriver {
  if (filename !== ':memory:') {
    mkdirSync(path.dirname(filename), { recursive: true });
  }
  const database = new DatabaseSync(filename);
  for (const pragma of PRAGMAS) {
    database.exec(pragma);
  }
  let inTransaction = false;
  return {
    all: (query, ...parameters) => database.prepare(query).all(...parameters),
    close: () => {
      database.close();
    },
    get: (query, ...parameters) => database.prepare(query).get(...parameters),
    run: (query, ...parameters) => {
      database.prepare(query).run(...parameters);
    },
    transaction: (body) => {
      if (inTransaction) {
        throw new Error('A transaction cannot open inside another');
      }
      // Marked open once it is: a `BEGIN` that fails — the write lock not had within the busy
      // timeout — opens nothing, and the next transaction is free to try.
      database.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      try {
        const result = body();
        refuseAsync(result);
        database.exec('COMMIT');
        return result;
      } catch (error) {
        // SQLite rolls some failures back itself (a full disk, an I/O error): what is answered is
        // the error that ended the transaction, not a rollback's of one that is over.
        if (database.isTransaction) {
          database.exec('ROLLBACK');
        }
        throw error;
      } finally {
        inTransaction = false;
      }
    },
  };
}
