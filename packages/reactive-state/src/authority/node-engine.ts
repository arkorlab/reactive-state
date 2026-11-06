import { AuthorityEngine } from './engine.ts';
import type { EngineOptions } from './model.ts';
import { nodeSql } from './node-sql.ts';

/**
 * The authority on a developer's machine: its engine over SQLite in a file, or in memory when no
 * file is named. A Durable Object opens the same engine over its own storage instead
 * (`@arkorlab/reactive-state/cloudflare`), and so never loads `node:sqlite`.
 */
export class Engine extends AuthorityEngine {
  constructor(options: EngineOptions) {
    const { filename = ':memory:', ...application } = options;
    const sql = nodeSql(filename);
    try {
      super({ ...application, sql });
    } catch (error) {
      // An authority refused as it starts — a program of another protocol, a database of another
      // schema — lets go of the file it opened, rather than hold it until it is collected.
      sql.close();
      throw error;
    }
  }
}
