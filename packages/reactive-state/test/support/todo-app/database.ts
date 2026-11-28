import { onTestFinished } from 'vitest';

import { type LocalD1, localD1 } from '../../../src/sql/sqlite/local-d1.ts';
import { connect, follow, refuseSecond } from './db.ts';
import { DDL, SEED } from './schema.ts';

/**
 * The test application's database on Node: a D1 stand-in of memory alone (`localD1(':memory:')`),
 * made anew for each test and connected, so that no test reads what another wrote. Its tables, the
 * seed, and the follow's log and triggers are made in one batch, the log last, so that the seed is
 * no change the log tells. One test, one database: the application's one connection serves every
 * engine of the test, so a second would move the first engine onto it — refused. As the test ends,
 * the database is let go of and none is connected: a test that made none is refused by the store,
 * naming it, and so is a statement of a test that ran past its end, until the next test connects
 * its own.
 */

/** A database of the tables, their log and the seed, connected until the test ends. */
export async function fresh(): Promise<LocalD1> {
  refuseSecond();
  const binding = localD1(':memory:');
  onTestFinished(() => {
    connect(undefined);
    binding.close();
  });
  const statements = [...DDL, ...SEED, ...follow.captureSql()];
  await binding.batch(statements.map((statement) => binding.prepare(statement)));
  connect(binding);
  return binding;
}
