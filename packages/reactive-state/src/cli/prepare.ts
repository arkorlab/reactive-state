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

/**
 * Runs Drizzle's migrations of `database`, where it is `reactiveDb`'s and `projectDir` holds any,
 * then the export `seed` of `<srcDir>/seed.ts`, where there is one.
 */
export async function prepare(
  database: AnyDatabase,
  projectDir: string,
  srcDir: string,
): Promise<void> {
  const host = hostOf(database);
  const migrations = path.join(projectDir, MIGRATIONS);
  if (host !== undefined && existsSync(path.join(migrations, JOURNAL))) {
    await host.migrate(migrations);
  }
  const file = path.join(srcDir, SEED);
  if (!existsSync(file)) return;
  const seed = seedOf(await import(pathToFileURL(file).href));
  if (typeof seed !== 'function') {
    throw new TypeError(`${file} exports no \`seed\` to run as the application starts.`);
  }
  await Reflect.apply(seed, undefined, []);
}
