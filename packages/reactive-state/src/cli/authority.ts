import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { registerPaths, startAuthority } from '../authority/index.ts';
import type { Authority, AuthorityOptions } from '../authority/start.ts';
import { prepare } from './prepare.ts';
import { STOP_MS } from './supervisor.ts';

/**
 * The authority's process of `reactive dev`, in the application's root: what the compile wrote in
 * the directory it is given, the application's migrations and first records, then the authority.
 * `dev.ts` runs it, and runs it again once the components or the modules they import change.
 */

const [outDir = '', srcDir = ''] = process.argv.slice(2);
const token = process.env['REACTIVE_ENGINE_TOKEN'];
if (token === undefined || token === '') throw new Error('REACTIVE_ENGINE_TOKEN is required.');
const port = Number(process.env['REACTIVE_ENGINE_PORT']);

/**
 * What a signal asks of the process, from the first: left to its default, one that came as the
 * application's database opened would end the process with PGlite's directory open.
 */
const running: { authority?: Authority; stopping?: Promise<void> } = {};

/**
 * Closes the authority, which keeps PGlite's directory whole, and ends the process: what a lost
 * link or the application's own modules still hold would keep it, and a restart behind it.
 */
async function stop(authority: Authority): Promise<void> {
  try {
    await authority.close();
  } catch (error) {
    process.stderr.write(`Stopping failed: ${String(error)}\n`);
    process.exitCode = 1;
  }
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit();
}

/**
 * Stops the authority, or has it stop as it starts, within `STOP_MS`: a start a database never
 * answers would hold the process through any signal.
 */
function asked(): void {
  if (running.stopping !== undefined) return;
  setTimeout(() => {
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
  }, STOP_MS);
  running.stopping = running.authority === undefined ? Promise.resolve() : stop(running.authority);
}

process.on('SIGINT', asked);
process.on('SIGTERM', asked);

registerPaths(path.resolve('tsconfig.json'));
const compiled = pathToFileURL(path.join(outDir, 'authority.mts')).href;
const application = (await import(compiled)) as AuthorityOptions;
await prepare(application.database, process.cwd(), srcDir);
const stateDir = '.data/authority';
const authority = await startAuthority({ ...application, port, stateDir, token });
process.stdout.write(`authority ${authority.url}\n`);
if (running.stopping === undefined) running.authority = authority;
else await stop(authority);
