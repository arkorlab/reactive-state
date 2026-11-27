import { existsSync, type FSWatcher, watch } from 'node:fs';
import path from 'node:path';

import type { ProjectLayout } from '../next/compile-on-build.ts';

/**
 * What `reactive dev` follows of an application: the components, and what the authority reads as it
 * starts. Directories by themselves, as a recursive watch of the root would walk `node_modules`, past
 * what Linux allows a user.
 */

/** Where Drizzle's migrations are, from the application's root. */
export const MIGRATIONS = 'drizzle';
/** The application's first records, from its components' directory. */
export const SEED = 'seed.ts';
/**
 * The files of the root the authority's start reads of: the config and `.env`, as `next dev` reads
 * them again, and `tsconfig.json`, whose paths it resolves the application's imports by
 * (`registerPaths`) — that file alone, of no build's `tsconfig.tsbuildinfo` beside it.
 */
const ROOT_FILES = /^(?:next\.config\.|\.env|tsconfig\.json$)/u;

/** What a change asks: a compile, or to start again what was read as it started. */
export type Change = 'compile' | 'start';

/** `node:fs`'s `watch`, as it is called here. */
type Watch = (
  directory: string,
  options: { readonly recursive: boolean },
  listener: (event: string, name: string | null) => void,
) => FSWatcher;

/**
 * Tells `told` of each change of what `layout` holds, and answers what ends that. What the system
 * refuses to watch, as of too many files, is said: the rest runs on, and a change there waits for a
 * restart.
 */
export function followChanges(
  layout: ProjectLayout,
  told: (change: Change) => void,
  say: (line: string) => void,
  watching: Watch = watch,
): () => void {
  const watchers = new Map<string, FSWatcher>();
  const refused = (directory: string, error: unknown): void => {
    say(
      `[watch] ${directory}: ${String(error)}. A change there takes a restart of \`reactive dev\`.`,
    );
  };
  const follow = (
    directory: string,
    recursive: boolean,
    listener: (event: string, name: string | null) => void,
  ): void => {
    try {
      const watcher = watching(directory, { recursive }, listener);
      watcher.on('error', (error) => {
        refused(directory, error);
      });
      watchers.set(directory, watcher);
    } catch (error) {
      refused(directory, error);
    }
  };
  const migrations = path.join(layout.projectDir, MIGRATIONS);
  const followMigrations = (): void => {
    if (watchers.has(migrations) || !existsSync(migrations)) return;
    follow(migrations, true, () => {
      told('start');
    });
  };
  follow(layout.srcDir, true, (_event, name) => {
    // No compile reads the seed, which the authority's start alone runs.
    told(name === SEED ? 'start' : 'compile');
  });
  if (existsSync(layout.appDir) && path.relative(layout.srcDir, layout.appDir).startsWith('..')) {
    follow(layout.appDir, true, () => {
      told('compile');
    });
  }
  follow(layout.projectDir, false, (_event, name) => {
    if (name === MIGRATIONS) {
      followMigrations();
      told('start');
    } else if (name !== null && ROOT_FILES.test(name)) {
      told('start');
    }
  });
  followMigrations();
  return () => {
    for (const watcher of watchers.values()) watcher.close();
  };
}
