import { onTestFinished } from 'vitest';

import type { EngineOptions } from '../../../src/authority/model.ts';
import { Engine } from '../../../src/authority/node-engine.ts';
import {
  type Authority,
  type AuthorityOptions,
  startAuthority,
} from '../../../src/authority/start.ts';
import { IDLE_POLL_MS } from './build.ts';
import { fresh } from './database.ts';
import { application } from './programs.ts';

/**
 * Authorities of the test application on Node, each over a database made anew for it (`fresh`):
 * what `new Engine(application)` and `startAuthority(application)` were of the tables the
 * authority kept. The authority reads the log of the application's tables when the test says so
 * (`engine.poke()`) or when it reads it itself, after an operation; never on a timer while a test
 * runs. Each has read the log once before it is answered — the first read of a log begins its
 * epoch, which is a commit of every table — so that what a test sees of commits and revisions is
 * of what it did.
 */

/** What a test gives an engine beside the test application, which it may override. */
type EngineOverrides = Partial<EngineOptions>;

/** An engine of the test application over the database connected now, closed as the test ends. */
export async function reopened(options: EngineOverrides = {}): Promise<Engine> {
  const engine = new Engine({ ...application, externalPollMs: IDLE_POLL_MS, ...options });
  onTestFinished(async () => {
    await engine.close();
  });
  await engine.poke();
  return engine;
}

/** An engine of the test application over a database made anew, closed as the test ends. */
export async function opened(options: EngineOverrides = {}): Promise<Engine> {
  await fresh();
  return reopened(options);
}

/** An authority of the test application served over HTTP, of a database made anew. */
export async function started(options: Partial<AuthorityOptions> = {}): Promise<Authority> {
  await fresh();
  const authority = await startAuthority({
    ...application,
    externalPollMs: IDLE_POLL_MS,
    ...options,
  });
  onTestFinished(async () => {
    await authority.close();
  });
  await authority.engine.poke();
  return authority;
}
