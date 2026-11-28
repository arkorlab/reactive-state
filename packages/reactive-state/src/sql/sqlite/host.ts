import type { DatabaseHost } from '../../authority/database-host.ts';
import { d1Hosted } from './d1-host.ts';
import type { DrizzleD1Follow } from './follow.ts';
import type { LocalD1 } from './local-d1.ts';
import { ownChanges } from './own-changes.ts';

/**
 * A database of a schema of SQLite's tables, as `reactiveDb` opens one in a process that has no D1
 * of Cloudflare's: a file in D1's shape (`localD1`), which the authority of `reactive dev` follows.
 * It tells of no commit: the authority reads the log at its interval.
 */

/** Where the file is kept between runs, beside PGlite's directory. */
const FILE = '.data/d1.sqlite';
/** What notes that the application's first records were written, beside the log (`_rs_changes`). */
const SEEDED = '"_rs_seeded"';

/**
 * Runs `first` unless `binding`'s database says it ran, so that the application's first records are
 * plain inserts. The note is written once `first` ended, so one that failed runs again.
 */
async function seedOnce(binding: LocalD1, first: () => Promise<void>): Promise<void> {
  await binding.prepare(`CREATE TABLE IF NOT EXISTS ${SEEDED} ("at" INTEGER NOT NULL)`).run();
  if ((await binding.prepare(`SELECT 1 FROM ${SEEDED} LIMIT 1`).first()) !== null) return;
  await first();
  await binding.prepare(`INSERT INTO ${SEEDED} ("at") VALUES (?)`).bind(Date.now()).run();
}

/**
 * The file `D1_FILE` names, or `.data/d1.sqlite`: what the application's Drizzle reads and writes,
 * and what the authority it is given opens as it starts. Its log keeps `keptMs` of changes.
 */
export async function inSqliteFile<S extends Readonly<Record<string, unknown>>>(
  schema: S,
  follow: DrizzleD1Follow<S>,
  keptMs: number,
): Promise<{ readonly orm: unknown; readonly host: DatabaseHost }> {
  // Of the process that opens the file alone: a bundle of a Worker's may import this module.
  const [{ drizzle }, migrator, { aloneOf, localD1 }] = await Promise.all([
    import('drizzle-orm/d1'),
    import('drizzle-orm/d1/migrator'),
    import('./local-d1.ts'),
  ]);
  const file = process.env['D1_FILE'] ?? FILE;
  const binding = localD1(file);
  // A write answers its own changes, not the rows the log's triggers wrote beside them.
  const orm = drizzle(follow.client(ownChanges(binding)) as never, { schema });
  return {
    host: {
      ...d1Hosted(binding, follow, keptMs),
      alone: (work) => aloneOf(file, work),
      close: () => {
        binding.close();
        return Promise.resolve();
      },
      listen: () => Promise.resolve(),
      migrate: (migrationsFolder) => migrator.migrate(orm, { migrationsFolder }),
      seed: (first) => seedOnce(binding, first),
    },
    orm,
  };
}
