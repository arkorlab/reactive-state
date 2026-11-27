import { drizzle } from 'drizzle-orm/d1';

import { followDrizzle, followedDb } from '../../../src/sql/index.ts';
import type { D1Binding } from '../../../src/sql/sqlite/client.ts';
import { schema } from './schema.ts';

/**
 * The test application's `@/db`, of its Drizzle schema in D1: the follow, the application's own
 * Drizzle (`orm`), which reads and writes through the binding of now, and the database the
 * authority is given (`db`), of whose tables a state binds a row. One module serves Node and
 * workerd: a test connects the D1 it made (`connect`) — a database of memory alone on Node, the
 * suite's `REACTIVE_D1` in workerd — and a database made anew is connected in its place, under the
 * same follow, Drizzle and database.
 */

/** The D1 the application reads and writes through, as the test connected it last. */
const connection: { binding?: D1Binding | undefined } = {};

/** Connects the application to `binding`, in place of the one before; to none, of none. */
export function connect(binding: D1Binding | undefined): void {
  connection.binding = binding;
}

/** The binding the application reads and writes through now, if any. */
export function connected(): D1Binding | undefined {
  return connection.binding;
}

/**
 * Refuses a test's second database while its first is connected: the one connection serves every
 * engine of the test, so a second would move the first engine onto it without a word.
 */
export function refuseSecond(): void {
  if (connection.binding !== undefined) {
    throw new Error(
      "This test's database is connected already, and every engine of the test reads it: give another engine over it (`reopened()` on Node), not a second database.",
    );
  }
}

export const follow = followDrizzle(schema, { store: 'app' });

/**
 * The application's Drizzle. D1's type of a Worker's is not Node's, which knows no `D1Database`:
 * the binding of now is given as D1's driver takes one, whichever it is.
 */
export const orm = drizzle(follow.client(() => connection.binding) as never, { schema });

export const db = followedDb(follow);
