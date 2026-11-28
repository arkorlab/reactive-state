/**
 * The change log in D1 and its epoch, as the store of `d1-store.ts` reads it: the log the triggers of
 * `changeCaptureSql`, and of a Drizzle schema's tables (`drizzle-orm/sqlite-core`), write. A module of
 * its own, which the `./d1` entry does not export.
 */

const LOG = '_rs_changes';
const META = '_rs_meta';

/** The statements that make the change log and its epoch, which a database made again begins anew. */
export function changeLogSql(): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${META} (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`,
    `DELETE FROM ${META} WHERE key = 'epoch' AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${LOG}')`,
    `CREATE TABLE IF NOT EXISTS ${LOG} (seq INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, tbl TEXT NOT NULL, id TEXT NOT NULL, before TEXT, after TEXT, at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS _rs_changes_at ON ${LOG} (at)`,
    `INSERT OR IGNORE INTO ${META} (key, value) VALUES ('epoch', lower(hex(randomblob(16))))`,
  ];
}
