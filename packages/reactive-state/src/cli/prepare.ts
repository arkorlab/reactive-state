import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { hostOf } from '../authority/database-host.ts';
import type { AnyDatabase } from '../server/schema.ts';
import { MIGRATIONS, SEED } from './changes.ts';

/**
 * What `reactive dev` does of the application before its authority starts, by where its files are:
 * nothing it does not find. Production leaves both to the application's own deploy.
 */

/** What says there are any of Drizzle's migrations, from their folder. */
const JOURNAL = 'meta/_journal.json';

/** The export `seed` of `src/seed.ts`, where it holds one. */
function seedOf(module: unknown): unknown {
  return typeof module === 'object' && module !== null ? Reflect.get(module, 'seed') : undefined;
}

/** What runs the export `seed` of `<srcDir>/seed.ts`, where there is one. */
async function firstRecordsOf(srcDir: string): Promise<(() => Promise<void>) | undefined> {
  const file = path.join(srcDir, SEED);
  if (!existsSync(file)) return undefined;
  const seed = seedOf(await import(pathToFileURL(file).href));
  if (typeof seed !== 'function') {
    throw new TypeError(`${file} exports no \`seed\` to run as the application starts.`);
  }
  return async () => {
    await Reflect.apply(seed, undefined, []);
  };
}

/**
 * Runs Drizzle's migrations of `database`, where it is `reactiveDb`'s and `projectDir` holds any,
 * then the export `seed` of `<srcDir>/seed.ts`, where there is one: once of a database of
 * `reactiveDb`, which notes it, and at each start of one that opens no connection of its own. The
 * two run alone of the hosts of the database, as a new one is what they make.
 */
export async function prepare(
  database: AnyDatabase,
  projectDir: string,
  srcDir: string,
): Promise<void> {
  const host = hostOf(database);
  if (host === undefined) {
    const first = await firstRecordsOf(srcDir);
    await first?.();
    return;
  }
  const migrations = path.join(projectDir, MIGRATIONS);
  await host.alone(async () => {
    if (existsSync(path.join(migrations, JOURNAL))) await host.migrate(migrations);
    // After them, as the seed's module may read what they made as it loads.
    const first = await firstRecordsOf(srcDir);
    if (first !== undefined) await host.seed(first);
  });
}
