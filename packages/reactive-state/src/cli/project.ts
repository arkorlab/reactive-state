import { createRequire } from 'node:module';
import path from 'node:path';

import type { ProjectOptions } from '../next/compile-on-build.ts';
import { loaderOptionsOf, projectOfLoader, REACTIVE_SOURCES } from '../next/config.ts';

/**
 * What `reactive dev` reads of the application's config and its `.env` files, in a process of its
 * own, which `dev.ts` forks each time: a config it imported would be read of the module cache after,
 * what the config runs stays out of it, and `.env`'s values stay out of the environment `next dev`
 * is given, in which they would come before the files as `next dev` reads them again.
 */

const DEVELOPMENT = 'phase-development-server';

/** What a config holds of the rule for the components' sources, as Next.js filled it in. */
interface LoadedConfig {
  readonly turbopack?: { readonly rules?: Readonly<Record<string, unknown>> };
}

/** What the process answers. */
export interface ProjectRead {
  /** What the compile is given, as the application's config says. */
  readonly project: ProjectOptions;
  /** What the application's `.env` files add, which the authority's process is given. */
  readonly env: Readonly<Record<string, string>>;
}

/** What reading the config added of the environment, of what `next dev` had set itself. */
function added(before: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && before[name] === undefined) env[name] = value;
  }
  return env;
}

async function read(projectDir: string, args: readonly string[]): Promise<ProjectRead> {
  const require = createRequire(path.join(projectDir, 'package.json'));
  const { default: loadConfig } = require('next/dist/server/config') as {
    readonly default: (
      phase: string,
      dir: string,
      options: Readonly<Record<string, unknown>>,
    ) => Promise<LoadedConfig>;
  };
  // As `next dev` sets them before it reads the config, which refuses what they do not allow.
  Reflect.set(process.env, 'NODE_ENV', 'development');
  if (!args.includes('--webpack')) process.env['TURBOPACK'] ??= 'auto';
  const before = { ...process.env };
  const config = await loadConfig(DEVELOPMENT, projectDir, { silent: true });
  const rule = config.turbopack?.rules?.[REACTIVE_SOURCES];
  const loader = rule === undefined ? undefined : loaderOptionsOf(rule as never);
  return {
    env: added(before),
    project: loader === undefined ? { projectDir } : projectOfLoader(loader),
  };
}

if (process.send === undefined) throw new Error('`reactive dev` forks this process.');
// Whatever the config left running: what it read is said.
process.send(await read(process.cwd(), process.argv.slice(2)), () => {
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit();
});
