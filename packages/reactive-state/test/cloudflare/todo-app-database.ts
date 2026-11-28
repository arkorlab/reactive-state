import { env } from 'cloudflare:workers';
import { onTestFinished } from 'vitest';

import { connect, follow, refuseSecond } from '../support/todo-app/db.ts';
import { DDL, SEED, TABLES } from '../support/todo-app/schema.ts';

/**
 * The test application's database in workerd, the twin of its Node one (`database.ts` beside its
 * schema): the suite's D1, `REACTIVE_D1`, its tables, log and seed dropped and made anew for each
 * test — the seed before the log, which tells no row of it — and connected until the test ends, so
 * that the application's Drizzle and its bound rows read and write it; one a test, as on Node.
 * Storage outlives a test within its file, and other files' tests use the same D1 of tables of
 * their own.
 */

/** The tables dropped: the application's, and the log's own, which `follow.captureSql()` makes. */
const DROPPED: readonly string[] = [...TABLES, '_rs_changes', '_rs_meta'];

/** `REACTIVE_D1`, of the test application's tables, log and seed alone, made anew and connected. */
export async function fresh(): Promise<D1Database> {
  refuseSecond();
  const binding = env.REACTIVE_D1;
  onTestFinished(() => {
    connect(undefined);
  });
  for (const name of DROPPED) {
    await binding.exec(`DROP TABLE IF EXISTS ${name}`);
  }
  const statements = [...DDL, ...SEED, ...follow.captureSql()];
  await binding.batch(statements.map((statement) => binding.prepare(statement)));
  connect(binding);
  return binding;
}
